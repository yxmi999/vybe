import type { RenderClipInput } from "./clip-render";
import type { Subtitle } from "./timeline";
import { planAutoEdit, type ClipMeta } from "./auto-edit";
import { generateSubtitles } from "./subtitle-generation";
import { pickCaptionEmojis } from "./caption-emojis";
import { styleLook, type ClipStyle } from "./clip-style";

// Turn a raw cut into a fully EDITED short in a given style — the batch
// counterpart of the editor's Auto-edit. Used by "Schedule a week" and
// Auto-Pilot so automated clips come out with hook trims, punch-ins, animated
// captions and the style's look instead of a bare center-crop.
//
//   plan (AI watches the cut)  ┐
//                              ├─▶ merge ─▶ emoji ─▶ RenderClipInput fields
//   transcribe (word timings)  ┘
//
// Every AI step is fail-soft: an outage degrades to "style look on the original
// trim" rather than failing the clip.

export type StyledInput = {
  videoUrl: string;
  clip: ClipMeta;
  trimStart: number;
  trimEnd: number;
  style: ClipStyle;
};

export type StyledResult = {
  fields: Partial<RenderClipInput>;   // spread into renderClip(); includes trimStart/trimEnd
  notes: string[];
  planned: boolean;                   // false = AI plan failed, look-only fallback
  captioned: boolean;
};

export async function buildStyledRender(input: StyledInput): Promise<StyledResult> {
  const { videoUrl, clip, trimStart, trimEnd, style } = input;
  const wantCaptions = style.captions.enabled;

  const [plan, subs] = await Promise.all([
    planAutoEdit({ videoUrl, clip, trimStart, trimEnd, style }).catch((err) => {
      console.error("[styled-render] plan failed:", err instanceof Error ? err.message : err);
      return null;
    }),
    wantCaptions
      ? generateSubtitles({ videoUrl, language: "original" }).catch((err) => {
          console.error("[styled-render] subtitles failed:", err instanceof Error ? err.message : err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  const look = styleLook(style);
  const e = plan?.edits;
  const tStart = e ? e.trimStart : trimStart;
  const tEnd = e ? e.trimEnd : trimEnd;

  // Keep only segments that overlap the final trim (times are source-time on
  // the same file, which is what the renderer expects).
  let subtitles: Subtitle[] = (subs?.segments ?? [])
    .filter((s) => s.end > tStart && s.start < tEnd)
    .map((s, i) => ({ id: `s${i}`, start: s.start, end: s.end, text: s.text, words: s.words }));

  if (subtitles.length > 0 && style.captions.emoji && style.captions.animation !== "classic") {
    const flat: { seg: number; word: number; text: string }[] = [];
    subtitles.forEach((s, si) => (s.words ?? []).forEach((w, wi) => flat.push({ seg: si, word: wi, text: w.word })));
    try {
      const picks = await pickCaptionEmojis(flat.map((f) => f.text));
      subtitles = subtitles.map((s) => ({ ...s, words: s.words?.map((w) => ({ ...w })) }));
      for (const p of picks) {
        const f = flat[p.index];
        const w = f && subtitles[f.seg].words?.[f.word];
        if (w) w.emoji = p.emoji;
      }
    } catch (err) {
      console.error("[styled-render] emoji failed:", err instanceof Error ? err.message : err);
    }
  }

  const fields: Partial<RenderClipInput> = e
    ? {
        trimStart: tStart,
        trimEnd: tEnd,
        caption: e.caption,
        captionX: e.captionX,
        captionY: e.captionY,
        captionSize: Math.max(0.5, Math.min(2.5, e.captionSize || 1)),
        captionStart: e.captionStart,
        captionEnd: e.captionEnd,
        textStyle: { font: e.captionFont, template: e.captionTemplate, color: e.captionColor },
        cropAspect: e.cropAspect,
        cropFill: e.cropFill,
        cropX: e.cropX,
        cropKeys: e.cropKeys,
        cropSmooth: e.cropSmooth,
        zoom: e.zoom,
        zoomKeys: e.zoomKeys,
        zoomSmooth: e.zoomSmooth,
        // Batch clips never get speed/pitch/mirror/cards — those are creative
        // calls a human should make; the style controls the rest.
        brightness: e.brightness,
        contrast: e.contrast,
        saturation: e.saturation,
        colorFilter: e.colorFilter,
        vignette: e.vignette,
        fadeIn: e.fadeIn,
        fadeOut: e.fadeOut,
        effects: e.effects,
        volumeKeys: e.volumeKeys,
        videoVolume: e.videoVolume > 0 ? e.videoVolume : 100,
        loudnorm: e.loudnorm,
        subtitleStyle: look.subtitleStyle,
        subtitleHighlight: look.subtitleHighlight,
        subtitleX: look.subtitleX,
        subtitleY: look.subtitleY,
        subtitleSize: look.subtitleSize,
        subtitleLook: look.subtitleLook,
      }
    : { ...look, trimStart: tStart, trimEnd: tEnd };

  if (subtitles.length > 0) fields.subtitles = subtitles;

  // The planner writes every timestamp on the SOURCE timeline, but renderClip
  // treats keyframes, effects and the caption window as TIMELINE time (0 =
  // the clip's first frame) and adds the trim start back itself. Passed
  // through unconverted, every punch-in, effect and hook caption landed
  // `trimStart` seconds late — usually past the end of the clip. Subtitles
  // stay source-time (renderClip maps those itself).
  if (e) {
    const tl = (t: number) => Math.max(0, t - tStart);
    fields.cropKeys = e.cropKeys.map((k) => ({ ...k, time: tl(k.time) }));
    fields.zoomKeys = e.zoomKeys.map((k) => ({ ...k, time: tl(k.time) }));
    fields.effects = e.effects.map((x) => ({ ...x, start: tl(x.start), end: tl(x.end) }));
    fields.volumeKeys = e.volumeKeys.map((k) => ({ ...k, time: tl(k.time) }));
    if (e.captionStart > 0 || e.captionEnd > 0) {
      // 0 means "open" to the renderer, so a window that starts at the first
      // frame becomes a tiny positive offset instead of collapsing to open.
      fields.captionStart = e.captionStart > 0 ? Math.max(0.01, tl(e.captionStart)) : 0;
      fields.captionEnd = e.captionEnd > 0 ? tl(e.captionEnd) : 0;
    }
  }

  return { fields, notes: plan?.notes ?? [], planned: !!plan, captioned: subtitles.length > 0 };
}
