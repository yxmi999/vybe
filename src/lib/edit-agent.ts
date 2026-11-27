import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { google } from "@/lib/ai-keys";
import { GEMINI_MODELS, isTransient, aiFailure } from "./ai";
import { FONT_KEYS, SPLIT_LAYOUT_KEYS } from "./clip-filters";
import { lazyLocalMedia, probeDuration, sceneCuts, silences, loudPeaks, framesAt } from "./media-probe";
import { BUILTIN_STYLES, captionLook, layoutFields, type ClipStyle } from "./clip-style";
import { ACTIVE_WORD_MODES, type SubtitleLook } from "./subtitle-look";
import { SFX_LIBRARY, SFX_KEYS, type SfxKey } from "./sfx-library";

// The AI editor as a tool-using agent. Instead of rewriting the editor's whole
// ~50-field state in one shot, the model LOOKS (transcript search, silence /
// loudness / scene-cut detection, frames) and then ACTS through small editing
// tools — anything it doesn't touch stays exactly as it was.
//
// Time convention: every tool speaks SOURCE seconds (the same clock as the
// transcript and the detectors). The editor stores keyframes / effects /
// caption timing in TIMELINE seconds (0 = first frame of the edited clip), so
// we convert once at the start and once at the end, using the final segments.
//
// Output is a PARTIAL edit object in the existing aiEditSchema vocabulary —
// the editor's applyAiResult() only applies fields that are present.

export type ClipMeta = { title: string; platform: string; duration: number; streamer: string };
type Seg = { start: number; end: number; volume: number };
type ZoomK = { time: number; z: number };
type CropK = { time: number; x: number };
type VolK = { time: number; v: number };
type Fx = { type: (typeof EFFECT_TYPES)[number]; start: number; end: number };
type Track = { id: string; type: string; name: string; start: number; duration: number; volume?: number };

const EFFECT_TYPES = ["flash", "blur", "bw", "vivid", "warm", "cool", "invert", "dim", "punch"] as const;
const COLOR_FILTERS = ["none", "bw", "sepia", "vivid", "warm", "cool", "faded"] as const;
const ASPECTS = ["original", "9:16", "1:1", "4:5", "16:9"] as const;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SUB_LANGS = ["original", "en", "es", "fr", "ar", "de", "pt", "hi", "ja", "it", "ru", "zh", "ko", "tr", "nl", "pl"] as const;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

// ─── Timeline <-> source mapping over a segment list ─────────────────────────

function layout(segs: Seg[]) {
  let t = 0;
  return segs.map((s) => { const o = { ...s, tl: t }; t += s.end - s.start; return o; });
}
function tlToSrc(segs: Seg[], t: number): number {
  const L = layout(segs);
  for (const s of L) if (t <= s.tl + (s.end - s.start) + 1e-6) return s.start + Math.max(0, t - s.tl);
  const last = L[L.length - 1];
  return last ? last.end : t;
}
function srcToTl(segs: Seg[], src: number): number | null {
  for (const s of layout(segs)) if (src >= s.start - 1e-6 && src <= s.end + 1e-6) return s.tl + (src - s.start);
  return null;
}
const totalLen = (segs: Seg[]) => segs.reduce((a, s) => a + (s.end - s.start), 0);

/** Remove [a,b] source ranges from a segment list (ripple cut). */
function cutRanges(segs: Seg[], ranges: { start: number; end: number }[]): Seg[] {
  let out = segs.map((s) => ({ ...s }));
  for (const r of ranges) {
    if (!(r.end > r.start)) continue;
    const next: Seg[] = [];
    for (const s of out) {
      if (r.end <= s.start || r.start >= s.end) { next.push(s); continue; }
      if (r.start > s.start) next.push({ ...s, end: r.start });
      if (r.end < s.end) next.push({ ...s, start: r.end });
    }
    out = next;
  }
  return out.filter((s) => s.end - s.start >= 0.15);
}

// ─── Working state ───────────────────────────────────────────────────────────

type Work = {
  segs: Seg[];
  segsTouched: boolean;
  zoomKeys: ZoomK[];   // source seconds
  cropKeys: CropK[];
  volumeKeys: VolK[];
  effects: Fx[];
  captionWin: { start: number | null; end: number | null }; // source; null = clip edge
  timedTouched: boolean;
  set: Record<string, unknown>;   // plain (non-timed) fields that changed
  trackEdits: Record<string, { id: string; start: number; duration: number; volume: number; remove: boolean }>;
  sounds: { sfx: SfxKey; time: number; volume: number }[];  // source seconds
  log: string[];
};

function initWork(state: Record<string, unknown>, dur: number): Work {
  const raw = Array.isArray(state.segments) ? state.segments as Array<Record<string, unknown>> : [];
  let segs: Seg[] = raw
    .map((g) => ({ start: num(g.start, 0), end: num(g.end, 0), volume: num(g.volume, 100) }))
    .filter((g) => g.end > g.start);
  if (segs.length === 0) {
    const ts = num(state.trimStart, 0), te = num(state.trimEnd, dur);
    segs = [{ start: ts, end: te > ts ? te : dur, volume: 100 }];
  }
  const toSrc = (t: number) => r2(tlToSrc(segs, t));
  const arr = <T,>(v: unknown) => (Array.isArray(v) ? v as T[] : []);
  const cs = num(state.captionStart, 0), ce = num(state.captionEnd, 0);
  return {
    segs, segsTouched: false,
    zoomKeys: arr<ZoomK>(state.zoomKeys).map((k) => ({ time: toSrc(k.time), z: k.z })),
    cropKeys: arr<CropK>(state.cropKeys).map((k) => ({ time: toSrc(k.time), x: k.x })),
    volumeKeys: arr<VolK>(state.volumeKeys).map((k) => ({ time: toSrc(k.time), v: k.v })),
    effects: arr<Fx>(state.effects).map((e) => ({ type: e.type, start: toSrc(e.start), end: toSrc(e.end) })),
    captionWin: { start: cs > 0 ? toSrc(cs) : null, end: ce > 0 ? toSrc(ce) : null },
    timedTouched: false,
    set: {},
    trackEdits: {},
    sounds: [],
    log: [],
  };
}

/** Collapse the working state into the editor's partial-edit vocabulary. */
function finalize(w: Work, initialSegCount: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...w.set };
  const segs = w.segs;
  if (w.segsTouched) {
    if (segs.length === 1 && initialSegCount <= 1) {
      out.trimStart = r2(segs[0].start);
      out.trimEnd = r2(segs[0].end);
      if (segs[0].volume !== 100) out.segments = [{ start: r2(segs[0].start), end: r2(segs[0].end), volume: segs[0].volume }];
    } else {
      out.segments = segs.map((s) => ({ start: r2(s.start), end: r2(s.end), volume: Math.round(s.volume) }));
    }
  }
  if (w.timedTouched || w.segsTouched) {
    const tl = (t: number) => srcToTl(segs, t);
    const keyed = <K extends { time: number }>(ks: K[]) => ks
      .map((k) => { const t = tl(k.time); return t == null ? null : { ...k, time: r2(t) }; })
      .filter((k): k is K => k != null)
      .sort((a, b) => a.time - b.time);
    out.zoomKeys = keyed(w.zoomKeys);
    out.cropKeys = keyed(w.cropKeys);
    out.volumeKeys = keyed(w.volumeKeys);
    out.effects = w.effects
      .map((e) => {
        const s = tl(e.start);
        if (s == null) return null;
        // An effect spanning a cut is clipped to the segment it starts in.
        const seg = segs.find((g) => e.start >= g.start - 1e-6 && e.start <= g.end + 1e-6)!;
        const end = tl(Math.min(e.end, seg.end));
        return end != null && end > s ? { type: e.type, start: r2(s), end: r2(end) } : null;
      })
      .filter(Boolean);
    const cs = w.captionWin.start != null ? tl(w.captionWin.start) : 0;
    const ce = w.captionWin.end != null ? tl(w.captionWin.end) : 0;
    const capStart = r2(cs ?? 0), capEnd = r2(ce ?? 0);
    out.captionStart = capStart;
    out.captionEnd = capEnd > capStart ? capEnd : 0;
    // Static zoom/crop are ignored by the editor once keyframes exist.
  }
  const tracks = Object.values(w.trackEdits);
  if (tracks.length) out.trackEdits = tracks;
  // New sound effects, placed on the FINAL timeline (dropped if their moment was cut).
  const sounds = w.sounds
    .map((x) => { const t = srcToTl(segs, x.time); return t == null ? null : { sfx: x.sfx, time: r2(t), volume: x.volume }; })
    .filter(Boolean);
  if (sounds.length) out.addSounds = sounds;
  return out;
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

function describeState(state: Record<string, unknown>, w: Work, tracks: Track[]): string {
  const j = (v: unknown) => JSON.stringify(v);
  const L = layout(w.segs);
  return [
    `Timeline segments (SOURCE seconds, play order): ${j(L.map((s, i) => ({ n: i + 1, start: r2(s.start), end: r2(s.end), volume: s.volume })))} → ${totalLen(w.segs).toFixed(1)}s long`,
    `Hook/caption text: "${state.caption || ""}" at x=${state.captionX ?? 50} y=${state.captionY ?? 88} size=${state.captionSize ?? 1}, shown ${w.captionWin.start ?? "start"} → ${w.captionWin.end ?? "end"}`,
    `Text style: font=${state.captionFont || "bold"} template=${state.captionTemplate || "outline"} color=${state.captionColor || "FFFFFF"}`,
    `Framing: aspect=${state.cropAspect || "original"} fill=${state.cropFill || "crop"} cropX=${state.cropX ?? 50}  crop path=${w.cropKeys.length ? j(w.cropKeys) : "none"}`,
    `Zoom: static ${state.zoom ?? 1}×  keyframes=${w.zoomKeys.length ? j(w.zoomKeys) : "none"} (${state.zoomSmooth === false ? "snap" : "smooth"})`,
    `Look: filter=${state.colorFilter || "none"} brightness=${state.brightness ?? 0} contrast=${state.contrast ?? 0} saturation=${state.saturation ?? 0} vignette=${state.vignette === true} mirror=${state.mirror === true} fades=${state.fadeIn ?? 0}/${state.fadeOut ?? 0}s speed=${state.speed ?? 1}×`,
    `Timed effects: ${w.effects.length ? j(w.effects) : "none"}`,
    `Audio: volume=${state.videoVolume ?? 100}% level=${state.loudnorm === true} pitch=${state.videoPitch ?? 0}st  volume keys=${w.volumeKeys.length ? j(w.volumeKeys) : "none"}`,
    `Subtitles: ${state.subtitles ? j(state.subtitles) : "none"}`,
    `Intro card: "${state.introText || ""}"  Outro card: "${state.outroText || ""}"`,
    `Track items (start in SOURCE seconds): ${tracks.length ? j(tracks) : "none"}`,
    `Split screen: ${state.split ? j(state.split) : "off"}`,
  ].join("\n");
}

function buildSystem(clip: ClipMeta, stateText: string, hasMedia: boolean, hasTranscript: boolean): string {
  return `You are the AI video editor inside Vybe, a short-form clip editor for streamers and creators.
You edit by CALLING TOOLS. Each tool changes one part of the edit; anything you don't touch stays as it is.

Clip: "${clip.title}" (${clip.platform}${clip.streamer ? `, ${clip.streamer}` : ""}), source length ${clip.duration.toFixed(1)}s.

Current edit:
${stateText}

How to work:
1. If the request depends on WHAT HAPPENS in the clip ("zoom on the reactions", "cut the dead air", "start at the question", "when he says X", "make it TikTok-ready"), LOOK first:
   ${hasTranscript ? "search_transcript for spoken moments," : "(no transcript yet — use the detectors),"} ${hasMedia ? "find_loud_moments for reactions/peaks, find_silences for dead air, find_scene_cuts for camera changes, look_at_frames to SEE the picture (framing, facecam, what's on screen)." : "media detectors are unavailable for this clip (local file) — work from the transcript and the request."}
2. NEVER ask the user a question — this is one-shot, they can't answer. Missing details (hook wording, colors, timings) are yours to decide well.
3. Then make the smallest set of tool calls that does what was asked. Don't change things the user didn't ask for.
4. ALL times you pass to tools are SOURCE seconds — the same clock the transcript and detectors use.
5. For broad requests ("make it viral", "TikTok-ready", "edit this for me"), a strong short edit is: trim to the best 15-45s that opens on the hook, cut dead air, 9:16 framing, animated subtitles, a short hook title for the first ~3s, punch-ins on the 2-4 biggest beats (a "hit" or "whoosh" sound on some of them, a "boom" on the payoff), audio leveled. Don't overdo sounds or effects — every one must land on a real beat.
6. Hook text must be SPECIFIC to this clip (what happens / what's at stake), 2-7 words — never generic like "New Clip!" or "Watch this". If you haven't seen or read the clip yet, look_at_frames (and search_transcript) before writing it.
7. Finish with ONE or TWO short sentences telling the user what you did (with timestamps where useful). No markdown.

Conventions: hook text normally sits at the TOP (y≈12) unless asked otherwise. Positions are 0-100 (x: 0 left → 100 right; y: ≈12 top, 50 middle, ≈88 bottom). Colors are 6-digit hex without '#'. "caption" = ONE static text overlay (hook/title/CTA), never transcribed speech — use set_subtitles for spoken words.`;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

function makeTools(w: Work, ctx: {
  clip: ClipMeta;
  transcript: { start: number; end: number; text: string }[];
  media: ReturnType<typeof lazyLocalMedia>;
  tracks: Track[];
  state: Record<string, unknown>;
}) {
  const dur = ctx.clip.duration || 600;
  const set = (k: string, v: unknown) => { w.set[k] = v; };
  const inKept = (t: number) => srcToTl(w.segs, t) != null;
  const needMedia = async () => {
    const f = await ctx.media.get();
    if (!f) throw new Error("Media analysis isn't available for this clip (it's a local file). Use the transcript instead.");
    return f;
  };
  const keptRange = () => ({ start: Math.min(...w.segs.map((s) => s.start)), end: Math.max(...w.segs.map((s) => s.end)) });

  return {
    // ── Perception ──
    search_transcript: tool({
      description: "Find where words/phrases are spoken. Returns matching transcript lines with SOURCE times. Pass an empty query to get the whole transcript.",
      inputSchema: z.object({ query: z.string().describe("Words to look for (case-insensitive, any word matches). Empty = everything.") }),
      execute: async ({ query }) => {
        if (ctx.transcript.length === 0) return "No transcript yet. Call set_subtitles to transcribe, or use the media detectors.";
        const words = query.toLowerCase().split(/\s+/).filter((x) => x.length > 1);
        const hits = words.length === 0 ? ctx.transcript
          : ctx.transcript.filter((l) => words.some((x) => l.text.toLowerCase().includes(x)));
        if (hits.length === 0) return `No line mentions "${query}".`;
        return hits.slice(0, 60).map((l) => `[${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`).join("\n");
      },
    }),
    find_silences: tool({
      description: "Detect dead air / pauses in the source audio. Returns silent spans (SOURCE seconds) inside the kept footage.",
      inputSchema: z.object({ minSeconds: z.number().describe("Shortest pause to report, e.g. 0.5") }),
      execute: async ({ minSeconds }) => {
        const f = await needMedia();
        const k = keptRange();
        const spans = (await silences(f, clamp(minSeconds, 0.2, 5))).filter((s) => s.end > k.start && s.start < k.end);
        return spans.length ? { silences: spans.slice(0, 80), totalSilentSec: r2(spans.reduce((a, s) => a + s.end - s.start, 0)) } : "No pauses that long.";
      },
    }),
    find_loud_moments: tool({
      description: "Find the loudest moments (shouts, laughs, hype reactions, big sounds). Returns SOURCE times with loudness above the clip's median.",
      inputSchema: z.object({ count: z.number().describe("How many moments, 1-10") }),
      execute: async ({ count }) => {
        const f = await needMedia();
        const d = (await probeDuration(f)) || dur;
        const peaks = (await loudPeaks(f, d, clamp(Math.round(count), 1, 10) + 4)).filter((p) => inKept(p.time));
        return peaks.length ? peaks.slice(0, clamp(Math.round(count), 1, 10)) : "No clear peaks in the kept footage.";
      },
    }),
    find_scene_cuts: tool({
      description: "Detect hard camera/scene changes. Returns SOURCE times.",
      inputSchema: z.object({}),
      execute: async () => {
        const f = await needMedia();
        const k = keptRange();
        const cuts = await sceneCuts(f, k.start, k.end - k.start);
        return cuts.length ? { cuts: cuts.slice(0, 100) } : "No hard cuts — it's one continuous shot.";
      },
    }),
    look_at_frames: tool({
      description: "See still frames of the video at given SOURCE times (max 6). Use to check framing, where the subject/facecam is, on-screen text, or what's happening.",
      inputSchema: z.object({ times: z.array(z.number()).describe("SOURCE seconds, 1-6 of them") }),
      execute: async ({ times }) => {
        const f = await needMedia();
        const frames = await framesAt(f, times.slice(0, 6).map((t) => clamp(t, 0, dur)));
        return frames.map((x) => ({ time: x.time, data: x.jpeg.toString("base64") }));
      },
      toModelOutput: ({ output }) => ({
        type: "content",
        value: (output as { time: number; data: string }[]).flatMap((x) => [
          { type: "text" as const, text: `Frame at ${x.time.toFixed(1)}s:` },
          { type: "image-data" as const, data: x.data, mediaType: "image/jpeg" },
        ]),
      }),
    }),

    // ── Timeline ──
    set_trim: tool({
      description: "Keep only SOURCE start→end as a single segment (replaces any cuts).",
      inputSchema: z.object({ start: z.number(), end: z.number() }),
      execute: async ({ start, end }) => {
        const s = clamp(start, 0, dur), e = clamp(end, 0, dur);
        if (e - s < 1) return "Trim must keep at least 1 second.";
        const vol = w.segs[0]?.volume ?? 100;
        w.segs = [{ start: s, end: e, volume: vol }]; w.segsTouched = true;
        w.log.push(`Trim ${s.toFixed(1)}–${e.toFixed(1)}s`);
        return `Kept ${s.toFixed(1)}–${e.toFixed(1)}s (${(e - s).toFixed(1)}s).`;
      },
    }),
    cut_ranges: tool({
      description: "Remove SOURCE ranges from the timeline (ripple delete). Use for 'cut out X', jump cuts, removing a tangent.",
      inputSchema: z.object({ ranges: z.array(z.object({ start: z.number(), end: z.number() })) }),
      execute: async ({ ranges }) => {
        const next = cutRanges(w.segs, ranges);
        if (next.length === 0 || totalLen(next) < 1) return "That would remove everything — not applied.";
        const removed = totalLen(w.segs) - totalLen(next);
        w.segs = next; w.segsTouched = true;
        return `Removed ${removed.toFixed(1)}s. Timeline is now ${next.length} segment(s), ${totalLen(next).toFixed(1)}s.`;
      },
    }),
    remove_dead_air: tool({
      description: "Detect pauses and cut them out (jump-cut talking style), keeping a little padding so words aren't clipped.",
      inputSchema: z.object({
        minPauseSeconds: z.number().describe("Only cut pauses at least this long; 0.5 = tight, 0.8 = gentle"),
        keepPaddingSeconds: z.number().describe("Silence to keep on each side of speech, 0.1-0.3"),
      }),
      execute: async ({ minPauseSeconds, keepPaddingSeconds }) => {
        const f = await needMedia();
        const pad = clamp(keepPaddingSeconds, 0.05, 0.5);
        const spans = await silences(f, clamp(minPauseSeconds, 0.3, 3));
        const ranges = spans.map((s) => ({ start: s.start + pad, end: s.end - pad })).filter((r) => r.end - r.start > 0.15);
        const next = cutRanges(w.segs, ranges);
        if (next.length === 0 || totalLen(next) < 1) return "Almost everything is silent — not applied.";
        const removed = totalLen(w.segs) - totalLen(next);
        if (removed < 0.2) return "No dead air worth cutting.";
        w.segs = next; w.segsTouched = true;
        return `Cut ${removed.toFixed(1)}s of dead air across ${ranges.length} pause(s). Now ${totalLen(next).toFixed(1)}s.`;
      },
    }),
    set_segment_volume: tool({
      description: "Set the audio volume (0-200%) for a SOURCE time range — splits segments as needed. Use for 'mute 10-12s', 'boost the reaction'.",
      inputSchema: z.object({ start: z.number(), end: z.number(), volume: z.number() }),
      execute: async ({ start, end, volume }) => {
        const v = clamp(Math.round(volume), 0, 200);
        const out: Seg[] = [];
        for (const s of w.segs) {
          if (end <= s.start || start >= s.end) { out.push(s); continue; }
          if (start > s.start) out.push({ ...s, end: start });
          out.push({ ...s, start: Math.max(s.start, start), end: Math.min(s.end, end), volume: v });
          if (end < s.end) out.push({ ...s, start: end });
        }
        w.segs = out.filter((s) => s.end - s.start >= 0.1); w.segsTouched = true;
        return `Volume ${v}% on ${start.toFixed(1)}–${end.toFixed(1)}s.`;
      },
    }),

    // ── Motion ──
    add_punch_ins: tool({
      description: "Add zoom punch-ins on beats. Each punch zooms in at `time` and returns to normal after `holdSeconds`.",
      inputSchema: z.object({
        punches: z.array(z.object({
          time: z.number().describe("SOURCE seconds"),
          zoom: z.number().describe("1.1 subtle … 1.3 normal … 1.6 strong"),
          holdSeconds: z.number().describe("How long to stay zoomed, e.g. 1-3"),
        })),
        snap: z.boolean().describe("true = instant cut-in (hype); false = smooth ramp (calm)"),
      }),
      execute: async ({ punches, snap }) => {
        const ramp = snap ? 0 : 0.35;
        const keys = [...w.zoomKeys];
        const first = Math.min(...w.segs.map((s) => s.start));
        if (!keys.some((k) => k.time <= first + 0.05)) keys.push({ time: first, z: 1 });
        for (const p of punches) {
          const z = clamp(p.zoom, 1.02, 3), t = p.time, hold = clamp(p.holdSeconds, 0.3, 10);
          if (!snap) keys.push({ time: Math.max(first, t - ramp), z: 1 });
          keys.push({ time: t, z });
          keys.push({ time: t + hold, z });
          keys.push({ time: t + hold + (snap ? 0.01 : ramp), z: 1 });
        }
        w.zoomKeys = dedupeKeys(keys);
        set("zoomSmooth", !snap); w.timedTouched = true;
        return `${punches.length} punch-in(s) added (${snap ? "snap" : "smooth"}).`;
      },
    }),
    set_zoom: tool({
      description: "Replace ALL zoom with either a static zoom (keyframes empty) or your own zoom keyframes. Use clear=true to remove all zoom.",
      inputSchema: z.object({
        staticZoom: z.number().describe("1 = none; used when keyframes is empty"),
        keyframes: z.array(z.object({ time: z.number().describe("SOURCE seconds"), z: z.number() })),
        smooth: z.boolean(),
      }),
      execute: async ({ staticZoom, keyframes, smooth }) => {
        w.zoomKeys = dedupeKeys(keyframes.map((k) => ({ time: k.time, z: clamp(k.z, 1, 3) })));
        set("zoom", clamp(staticZoom, 1, 3)); set("zoomSmooth", smooth); w.timedTouched = true;
        return w.zoomKeys.length ? `${w.zoomKeys.length} zoom keyframes.` : `Static zoom ${clamp(staticZoom, 1, 3)}×.`;
      },
    }),
    set_framing: tool({
      description: "Output aspect + how the frame is filled + horizontal crop position. Optionally a moving crop path (pan to follow the subject).",
      inputSchema: z.object({
        aspect: z.enum(ASPECTS).optional(),
        fill: z.enum(["crop", "blur"]).optional().describe("crop = fill the frame; blur = fit whole video over a blurred copy"),
        cropX: z.number().optional().describe("Fixed horizontal crop 0-100"),
        cropPath: z.array(z.object({ time: z.number().describe("SOURCE seconds"), x: z.number() })).optional().describe("≥2 keys for a moving crop; [] removes it"),
        smoothPan: z.boolean().optional(),
        mirror: z.boolean().optional(),
      }),
      execute: async (a) => {
        if (a.aspect) set("cropAspect", a.aspect);
        if (a.fill) set("cropFill", a.fill);
        if (a.cropX != null) set("cropX", clamp(a.cropX, 0, 100));
        if (a.smoothPan != null) set("cropSmooth", a.smoothPan);
        if (a.mirror != null) set("mirror", a.mirror);
        if (a.cropPath) { w.cropKeys = dedupeKeys(a.cropPath.map((k) => ({ time: k.time, x: clamp(k.x, 0, 100) }))); w.timedTouched = true; }
        return "Framing updated.";
      },
    }),
    set_split_screen: tool({
      description: "Split-screen layouts. 'facecam' = streamer's webcam on top, gameplay below. detectFacecam frames the top panel on the real webcam automatically.",
      inputSchema: z.object({
        layout: z.enum(["off", ...SPLIT_LAYOUT_KEYS]),
        detectFacecam: z.boolean(),
        topHeightPercent: z.number().describe("Top panel height 20-60 for 2-panel layouts; 0 = default"),
      }),
      execute: async ({ layout: l, detectFacecam, topHeightPercent }) => {
        set("splitScreen", l);
        set("detectFacecam", l !== "off" && detectFacecam);
        set("splitTopHeight", topHeightPercent > 0 ? clamp(topHeightPercent, 20, 60) : 0);
        return l === "off" ? "Split screen off." : `Split → ${l}${detectFacecam ? " (detecting facecam)" : ""}.`;
      },
    }),

    // ── Text ──
    set_hook_text: tool({
      description: "The single static text overlay (hook / title / call-to-action). Empty text removes it.",
      inputSchema: z.object({
        text: z.string(),
        x: z.number().optional(), y: z.number().optional(),
        size: z.number().optional().describe("0.5-2.5, 1 = default"),
        showFrom: z.number().optional().describe("SOURCE seconds; omit = clip start"),
        showUntil: z.number().optional().describe("SOURCE seconds; omit = clip end"),
      }),
      execute: async (a) => {
        set("caption", a.text.slice(0, 140));
        if (a.x != null) set("captionX", clamp(a.x, 0, 100));
        if (a.y != null) set("captionY", clamp(a.y, 0, 100));
        if (a.size != null) set("captionSize", clamp(a.size, 0.5, 2.5));
        w.captionWin = { start: a.showFrom ?? null, end: a.showUntil ?? null }; w.timedTouched = true;
        return a.text ? `Hook text "${a.text.slice(0, 40)}".` : "Hook text removed.";
      },
    }),
    set_text_style: tool({
      description: "Font / treatment / color for BOTH the hook text and subtitles, plus the subtitle highlight color and placement.",
      inputSchema: z.object({
        font: z.enum(FONT_KEYS).optional().describe("bold = heavy Montserrat, impact = Anton meme, condensed = Bebas, sans = Poppins, serif, round = Lilita, marker, mono"),
        template: z.enum(["outline", "box", "shadow", "pop"]).optional(),
        color: z.string().optional(),
        highlightColor: z.string().optional().describe("Active-word color for karaoke/word subtitles"),
        subtitleY: z.number().optional(),
        subtitleSize: z.number().optional().describe("0.4-3"),
        wordsPerLine: z.number().optional().describe("Karaoke: words on screen at once, 0 = whole phrase (2-4 = punchy TikTok look)"),
        uppercase: z.boolean().optional().describe("ALL-CAPS subtitles"),
        outline: z.number().optional().describe("Subtitle outline thickness 0-3 (1 = normal)"),
        activeWord: z.enum(ACTIVE_WORD_MODES as [SubtitleLook["activeMode"], ...SubtitleLook["activeMode"][]]).optional()
          .describe("How the spoken word stands out: color, box (coloured pill behind it), scale (bigger)"),
        pop: z.boolean().optional().describe("Spoken word pops in with a bounce"),
      }),
      execute: async (a) => {
        const hex = (v?: string) => { const h = (v ?? "").replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase(); return h.length === 6 ? h : null; };
        if (a.font) set("captionFont", a.font);
        if (a.template) set("captionTemplate", a.template);
        if (hex(a.color)) set("captionColor", hex(a.color));
        if (hex(a.highlightColor)) set("subtitleHighlight", hex(a.highlightColor));
        if (a.subtitleY != null) set("subtitleY", clamp(a.subtitleY, 0, 100));
        if (a.subtitleSize != null) set("subtitleSize", clamp(a.subtitleSize, 0.4, 3));
        const look: Partial<SubtitleLook> = { ...(w.set.subtitleLook as Partial<SubtitleLook> | undefined) };
        if (a.wordsPerLine != null) look.wordsPerLine = clamp(Math.round(a.wordsPerLine), 0, 8);
        if (a.uppercase != null) look.uppercase = a.uppercase;
        if (a.outline != null) look.outline = clamp(a.outline, 0, 3);
        if (a.activeWord) look.activeMode = a.activeWord;
        if (a.pop != null) look.pop = a.pop;
        if (Object.keys(look).length) set("subtitleLook", look);
        return "Text style updated.";
      },
    }),
    set_subtitles: tool({
      description: "Auto-subtitle the SPOKEN words (transcribes in the editor), and/or change their animation and emoji.",
      inputSchema: z.object({
        generate: z.boolean().describe("true = (re)transcribe now"),
        language: z.enum(SUB_LANGS).describe("'original' keeps the spoken language"),
        style: z.enum(["classic", "karaoke", "word"]).describe("karaoke = phrase with active word highlighted; word = one word at a time"),
        emoji: z.boolean(),
      }),
      execute: async (a) => {
        if (a.generate) { set("generateSubtitles", true); set("subtitleLanguage", a.language); }
        set("subtitleStyle", a.style); set("subtitleEmoji", a.emoji);
        return a.generate ? "Subtitles will be transcribed." : "Subtitle style updated.";
      },
    }),
    set_cards: tool({
      description: "3-second black intro/outro text cards. Empty string removes.",
      inputSchema: z.object({ intro: z.string().optional(), outro: z.string().optional() }),
      execute: async (a) => {
        if (a.intro != null) set("introText", a.intro.slice(0, 80));
        if (a.outro != null) set("outroText", a.outro.slice(0, 80));
        return "Cards updated.";
      },
    }),

    // ── Look ──
    set_look: tool({
      description: "Whole-clip color grade, vignette, fades and playback speed.",
      inputSchema: z.object({
        colorFilter: z.enum(COLOR_FILTERS).optional(),
        brightness: z.number().optional().describe("-50..50"),
        contrast: z.number().optional().describe("-50..50"),
        saturation: z.number().optional().describe("-50..50"),
        vignette: z.boolean().optional(),
        fadeIn: z.number().optional().describe("seconds 0-3"),
        fadeOut: z.number().optional().describe("seconds 0-3"),
        speed: z.number().optional().describe("0.5, 0.75, 1, 1.25, 1.5 or 2"),
      }),
      execute: async (a) => {
        if (a.colorFilter) set("colorFilter", a.colorFilter);
        if (a.brightness != null) set("brightness", clamp(Math.round(a.brightness), -50, 50));
        if (a.contrast != null) set("contrast", clamp(Math.round(a.contrast), -50, 50));
        if (a.saturation != null) set("saturation", clamp(Math.round(a.saturation), -50, 50));
        if (a.vignette != null) set("vignette", a.vignette);
        if (a.fadeIn != null) set("fadeIn", clamp(a.fadeIn, 0, 3));
        if (a.fadeOut != null) set("fadeOut", clamp(a.fadeOut, 0, 3));
        if (a.speed != null) set("speed", SPEEDS.reduce((b, s) => (Math.abs(s - a.speed!) < Math.abs(b - a.speed!) ? s : b), 1));
        return "Look updated.";
      },
    }),
    add_effects: tool({
      description: "Timed effects over SOURCE ranges: flash (≈0.3s white flash on a big beat), invert (≈0.15-0.3s negative hit — glitchy), punch (contrast/saturation hit on a beat), dim (darken for a dramatic pause), blur, bw, vivid, warm, cool. replaceExisting=true clears the old ones first.",
      inputSchema: z.object({
        effects: z.array(z.object({ type: z.enum(EFFECT_TYPES), start: z.number(), end: z.number() })),
        replaceExisting: z.boolean(),
      }),
      execute: async ({ effects, replaceExisting }) => {
        const add = effects.filter((e) => e.end > e.start).map((e) => ({ ...e }));
        w.effects = [...(replaceExisting ? [] : w.effects), ...add].sort((a, b) => a.start - b.start);
        w.timedTouched = true;
        return `${add.length} effect(s) added; ${w.effects.length} total.`;
      },
    }),

    // ── Audio ──
    set_audio: tool({
      description: "Original-audio volume, loudness leveling, pitch shift.",
      inputSchema: z.object({
        volume: z.number().optional().describe("0-100"),
        level: z.boolean().optional().describe("normalize loudness (almost always good)"),
        pitch: z.number().optional().describe("semitones -12..12"),
      }),
      execute: async (a) => {
        if (a.volume != null) set("videoVolume", clamp(Math.round(a.volume), 0, 100));
        if (a.level != null) set("loudnorm", a.level);
        if (a.pitch != null) set("videoPitch", clamp(Math.round(a.pitch), -12, 12));
        return "Audio updated.";
      },
    }),
    duck_audio: tool({
      description: "Lower the original audio over SOURCE ranges with short ramps (e.g. under a sound effect or voiceover). clear=true removes all ducking.",
      inputSchema: z.object({
        ranges: z.array(z.object({ start: z.number(), end: z.number() })),
        levelPercent: z.number().describe("Volume during the dip, e.g. 30"),
        clear: z.boolean(),
      }),
      execute: async ({ ranges, levelPercent, clear }) => {
        const v = clamp(levelPercent, 0, 200);
        const keys = clear ? [] : [...w.volumeKeys];
        for (const r of ranges) {
          if (!(r.end > r.start)) continue;
          keys.push({ time: Math.max(0, r.start - 0.3), v: 100 }, { time: r.start, v }, { time: r.end, v }, { time: r.end + 0.3, v: 100 });
        }
        w.volumeKeys = dedupeKeys(keys); w.timedTouched = true;
        return clear && ranges.length === 0 ? "Ducking removed." : `Ducked ${ranges.length} range(s) to ${v}%.`;
      },
    }),
    edit_track_item: tool({
      description: "Change an EXISTING overlay/audio track item (sound effect, footage, image, music — '__music' = background music) by id. New files can't be added here.",
      inputSchema: z.object({
        id: z.string(),
        start: z.number().optional().describe("SOURCE seconds"),
        duration: z.number().optional(),
        volume: z.number().optional().describe("0-200 (music 0-100)"),
        remove: z.boolean().optional(),
      }),
      execute: async (a) => {
        const item = ctx.tracks.find((t) => t.id === a.id);
        if (!item) return `No track item "${a.id}". Items: ${ctx.tracks.map((t) => t.id).join(", ") || "none"}`;
        let start = -1;
        if (a.start != null) {
          const tl = srcToTl(w.segs, a.start);
          if (tl == null) return `${a.start.toFixed(1)}s is in cut-out footage.`;
          start = r2(tl);
        }
        w.trackEdits[a.id] = {
          id: a.id, start,
          duration: a.duration != null ? Math.max(0, a.duration) : -1,
          volume: a.volume != null ? clamp(a.volume, 0, 200) : -1,
          remove: a.remove === true,
        };
        return a.remove ? `Removed ${item.name}.` : `Updated ${item.name}.`;
      },
    }),
    add_sound_effects: tool({
      description: `Drop built-in sound effects at SOURCE times. Library: ${SFX_KEYS.map((k) => `'${k}' (${SFX_LIBRARY[k].use})`).join("; ")}. Use them sparingly — on real beats (punch-ins, reveals, cuts), typically 2-6 per clip. A riser should END on the beat, so start it ~2s before.`,
      inputSchema: z.object({
        sounds: z.array(z.object({
          sfx: z.enum(SFX_KEYS as [SfxKey, ...SfxKey[]]),
          time: z.number().describe("SOURCE seconds where the sound starts"),
          volume: z.number().describe("0-200, 100 = normal; 60-80 to sit under speech"),
        })),
      }),
      execute: async ({ sounds }) => {
        const add = sounds.slice(0, 12).map((x) => ({ sfx: x.sfx, time: Math.max(0, x.time), volume: clamp(Math.round(x.volume), 0, 200) }));
        w.sounds.push(...add);
        const lost = add.filter((x) => !inKept(x.time)).length;
        return `${add.length} sound effect(s) added${lost ? ` (${lost} fall in cut-out footage and will be dropped)` : ""}.`;
      },
    }),
    apply_style_preset: tool({
      description: `Apply a built-in house style's LOOK (captions, grade, framing, fades): ${Object.entries(BUILTIN_STYLES).map(([k, s]) => `'${k}' = ${s.summary}`).join(" ")}`,
      inputSchema: z.object({ preset: z.enum(Object.keys(BUILTIN_STYLES) as [string, ...string[]]) }),
      execute: async ({ preset }) => {
        applyLook(w, BUILTIN_STYLES[preset]);
        return `Applied the "${BUILTIN_STYLES[preset].name}" look. Timing (hook, punch-ins, cuts) is still up to you.`;
      },
    }),
  };
}

function dedupeKeys<K extends { time: number }>(keys: K[]): K[] {
  const sorted = [...keys].sort((a, b) => a.time - b.time).map((k) => ({ ...k, time: r2(k.time) }));
  const out: K[] = [];
  for (const k of sorted) {
    if (out.length && Math.abs(out[out.length - 1].time - k.time) < 0.005) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/** The timing-free part of a ClipStyle, written into the working state. */
function applyLook(w: Work, s: ClipStyle) {
  Object.assign(w.set, {
    cropAspect: s.framing.aspect, cropFill: s.framing.fill,
    captionFont: s.captions.font, captionTemplate: s.captions.template, captionColor: s.captions.color,
    subtitleStyle: s.captions.animation, subtitleHighlight: s.captions.highlight,
    subtitleY: s.captions.positionY, subtitleSize: s.captions.size, subtitleX: 50,
    subtitleEmoji: s.captions.enabled && s.captions.emoji && s.captions.animation !== "classic",
    colorFilter: s.grade.colorFilter, brightness: s.grade.brightness, contrast: s.grade.contrast,
    saturation: s.grade.saturation, vignette: s.grade.vignette,
    fadeIn: s.transitions.fadeIn, fadeOut: s.transitions.fadeOut, loudnorm: s.audio.loudnorm,
    subtitleLook: captionLook(s),
    ...layoutFields(s),
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export class EditAgentError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}

export type EditAgentInput = {
  prompt: string;
  clip: ClipMeta;
  state: Record<string, unknown>;
  transcript?: string;  // "[12.3-14.1] words…" lines, SOURCE seconds
  videoUrl?: string;    // server-fetchable source for the detectors
};

export type EditAgentResult = { edits: Record<string, unknown>; notes: string[]; model: string; toolCalls: string[] };

function parseTranscript(t: string) {
  return t.split("\n").map((line) => {
    const m = line.match(/^\[([\d.]+)-([\d.]+)\]\s*(.*)$/);
    return m ? { start: Number(m[1]), end: Number(m[2]), text: m[3] } : null;
  }).filter((x): x is { start: number; end: number; text: string } => !!x && !!x.text);
}

export async function runEditAgent(input: EditAgentInput): Promise<EditAgentResult> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new EditAgentError("AI editing isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart.");
  }
  const { clip, state } = input;
  const transcript = parseTranscript(input.transcript ?? "");
  const media = lazyLocalMedia(input.videoUrl);
  const deadline = AbortSignal.timeout(100_000);

  try {
    let lastErr: unknown;
    for (const modelId of GEMINI_MODELS) {
      if (deadline.aborted) break;
      // Fresh state per attempt — a failed model may have half-applied tools.
      const w = initWork(state, clip.duration);
      const initialSegCount = w.segs.length;
      const rawTracks = Array.isArray(state.tracks) ? state.tracks as Track[] : [];
      const tracks = rawTracks.map((t) => ({ ...t, start: r2(tlToSrc(w.segs, t.start)) }));
      const calls: string[] = [];
      try {
        const result = await generateText({
          model: google(modelId),
          system: buildSystem(clip, describeState(state, w, tracks), media.available, transcript.length > 0),
          prompt: input.prompt.trim(),
          tools: makeTools(w, { clip, transcript, media, tracks, state }),
          stopWhen: stepCountIs(14),
          maxRetries: 1,
          abortSignal: deadline,
          onStepFinish: (step) => { for (const c of step.toolCalls) calls.push(c.toolName); },
        });
        const note = result.text.trim().replace(/\*\*/g, "");
        return {
          edits: finalize(w, initialSegCount),
          notes: note ? [note.slice(0, 400)] : [],
          model: modelId,
          toolCalls: calls,
        };
      } catch (err) {
        lastErr = err;
        console.error(`[edit-agent] ${modelId} failed:`, err instanceof Error ? err.message : err);
        if (!isTransient(err)) break;
      }
    }
    const fail = aiFailure(lastErr);
    throw new EditAgentError(fail.error, fail.status);
  } finally {
    await media.cleanup();
  }
}
