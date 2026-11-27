import { z } from "zod";
import { FONT_KEYS } from "./clip-filters";
import type { ClipEdits } from "./clip-edit-schema";
import { ACTIVE_WORD_MODES, sanitizeSubtitleLook, type SubtitleLook } from "./subtitle-look";

// A ClipStyle is a PORTABLE editing recipe — everything that makes a channel's
// shorts look and feel like "theirs", with no timestamps in it. It's what
// "copy this clip's style" extracts from a reference video, and what Auto-edit,
// "Schedule a week" and Auto-Pilot apply to brand-new clips:
//
//   reference clip ──analyze──▶ ClipStyle ──(+ the new clip)──▶ timed edit plan
//
// The AI still decides WHERE things go in each new clip (hook, punch-in beats,
// trim) because that depends on the content; enforceStyle() then pins the LOOK
// (fonts, colors, grade, framing…) so every clip comes out consistent.

const FONT = z.enum(FONT_KEYS);
const TEMPLATE = z.enum(["outline", "box", "shadow", "pop"]);

export const clipStyleSchema = z.object({
  name: z.string().describe("Short catchy name for this style, 2-4 words (e.g. 'Neon Hype', 'Clean Podcast')."),
  summary: z.string().describe("One sentence describing the style's look and feel."),

  framing: z.object({
    aspect: z.enum(["9:16", "1:1", "4:5", "16:9", "original"]).describe("Output aspect ratio."),
    fill: z.enum(["crop", "blur"]).describe("'crop' = video fills the frame; 'blur' = whole video fitted over a blurred copy of itself."),
    layout: z.enum(["single", "facecam"]).optional()
      .describe("'facecam' = the frame is split: the streamer's webcam on top, gameplay/screen below (the streamer-clip look). 'single' = one view."),
  }),

  captions: z.object({
    enabled: z.boolean().describe("Does the style burn in subtitles of the spoken words?"),
    animation: z.enum(["classic", "karaoke", "word"]).describe("'karaoke' = phrase with the spoken word highlighted, 'word' = one big word at a time, 'classic' = plain lines."),
    font: FONT.describe("Closest font family: impact = heavy condensed meme font, bold = heavy sans, round = rounded friendly, serif, mono, sans = light/regular."),
    template: TEMPLATE.describe("'outline' black outline, 'box' solid box behind text, 'shadow' drop shadow, 'pop' thick outline + shadow."),
    color: z.string().describe("Main caption text color, 6-digit hex without '#'."),
    highlight: z.string().describe("Active/highlighted word color, 6-digit hex without '#' (used by karaoke/word)."),
    positionY: z.number().describe("Vertical caption position 0-100 (≈20 upper third, 50 center, ≈72 lower third, ≈85 bottom)."),
    size: z.number().describe("Caption size multiplier 0.6-2.2 (1 = normal, 1.5 = big bold TikTok captions)."),
    emoji: z.boolean().describe("Are emoji sprinkled into the captions?"),
    // Finer caption details (optional so styles saved before they existed still parse).
    wordsPerLine: z.number().optional().describe("Karaoke: how many words are on screen at once (count them). 0 = the whole sentence/phrase."),
    uppercase: z.boolean().optional().describe("Are the captions written in ALL CAPS?"),
    outline: z.number().optional().describe("Outline thickness vs a normal caption: 0 = none, 1 = normal, 2 = thick, 3 = very thick."),
    activeMode: z.enum(ACTIVE_WORD_MODES as [SubtitleLook["activeMode"], ...SubtitleLook["activeMode"][]]).optional()
      .describe("How the spoken word stands out: 'color' = it changes colour, 'box' = a coloured box/pill appears behind it, 'scale' = it gets bigger."),
    pop: z.boolean().optional().describe("Do words bounce/pop in as they're spoken?"),
  }),

  hook: z.object({
    enabled: z.boolean().describe("Does the style open with a hook/title text overlay?"),
    positionY: z.number().describe("Vertical position of the hook text 0-100 (≈12 top)."),
    uppercase: z.boolean().describe("Is the hook text ALL CAPS?"),
    durationSec: z.number().describe("How long the hook text stays on screen in seconds (0 = whole clip)."),
    tone: z.string().describe("How the hook is written, e.g. 'teasing question', 'bold claim', 'POV: ...', 'numbered list'."),
  }),

  pacing: z.object({
    targetMinSec: z.number().describe("Typical minimum clip length in seconds."),
    targetMaxSec: z.number().describe("Typical maximum clip length in seconds."),
    removeDeadAir: z.boolean().describe("Are pauses/silences cut out (jump-cut talking style)?"),
    energy: z.enum(["calm", "balanced", "hype"]).describe("Overall editing energy."),
  }),

  motion: z.object({
    punchIns: z.enum(["none", "light", "medium", "heavy"]).describe("How often the editor zooms/punches in: light ≈ once, medium ≈ every 8-12s, heavy ≈ every 3-6s."),
    intensity: z.number().describe("Typical punch-in zoom factor 1.05-1.6."),
    snap: z.boolean().describe("true = zooms snap/cut in instantly; false = smooth ramps."),
  }),

  grade: z.object({
    colorFilter: z.enum(["none", "bw", "sepia", "vivid", "warm", "cool", "faded"]),
    brightness: z.number().describe("-50..50, 0 = unchanged"),
    contrast: z.number().describe("-50..50, 0 = unchanged"),
    saturation: z.number().describe("-50..50, 0 = unchanged"),
    vignette: z.boolean(),
  }),

  transitions: z.object({
    fadeIn: z.number().describe("Fade-in seconds 0-1.5 (0 = hard open)."),
    fadeOut: z.number().describe("Fade-out seconds 0-1.5."),
    flashOnBeats: z.boolean().describe("Are white flashes used on big beats/cuts?"),
  }),

  audio: z.object({
    loudnorm: z.boolean().describe("Level the loudness (almost always true)."),
  }),

  notes: z.string().describe("2-4 sentences of concrete editing guidance that capture this style for another editor: what to open on, where emphasis goes, what to avoid."),
});

export type ClipStyle = z.infer<typeof clipStyleSchema>;

// ─── Built-in presets ────────────────────────────────────────────────────────

export const BUILTIN_STYLES: Record<string, ClipStyle> = {
  hype: {
    name: "Streamer Hype",
    summary: "Loud, fast streamer short — big yellow karaoke captions, snap punch-ins, flashes on the peaks.",
    framing: { aspect: "9:16", fill: "crop" },
    captions: { enabled: true, animation: "karaoke", font: "impact", template: "pop", color: "FFFFFF", highlight: "FFE000", positionY: 70, size: 1.35, emoji: true, wordsPerLine: 3, uppercase: true, outline: 1.5, activeMode: "color", pop: true },
    hook: { enabled: true, positionY: 12, uppercase: true, durationSec: 3.5, tone: "bold tease that doesn't spoil the payoff" },
    pacing: { targetMinSec: 15, targetMaxSec: 35, removeDeadAir: true, energy: "hype" },
    motion: { punchIns: "medium", intensity: 1.35, snap: true },
    grade: { colorFilter: "vivid", brightness: 0, contrast: 8, saturation: 10, vignette: false },
    transitions: { fadeIn: 0, fadeOut: 0.3, flashOnBeats: true },
    audio: { loudnorm: true },
    notes: "Open on the loudest reaction or the line that sets it up. Snap-zoom on every reaction beat. End one beat after the payoff — never let it trail.",
  },
  clean: {
    name: "Clean Creator",
    summary: "Polished and readable — white word-by-word captions, gentle zooms, no gimmicks.",
    framing: { aspect: "9:16", fill: "crop" },
    captions: { enabled: true, animation: "word", font: "bold", template: "shadow", color: "FFFFFF", highlight: "32ADE6", positionY: 72, size: 1.2, emoji: false, wordsPerLine: 0, uppercase: false, outline: 1, activeMode: "color", pop: true },
    hook: { enabled: false, positionY: 12, uppercase: false, durationSec: 0, tone: "" },
    pacing: { targetMinSec: 20, targetMaxSec: 45, removeDeadAir: true, energy: "balanced" },
    motion: { punchIns: "light", intensity: 1.15, snap: false },
    grade: { colorFilter: "none", brightness: 0, contrast: 4, saturation: 4, vignette: false },
    transitions: { fadeIn: 0, fadeOut: 0.4, flashOnBeats: false },
    audio: { loudnorm: true },
    notes: "Lead with the clearest statement. Keep zooms slow and rare — clarity over energy.",
  },
  podcast: {
    name: "Podcast Clip",
    summary: "Talking-head podcast cut — boxed captions, jump cuts, a question hook on top.",
    framing: { aspect: "9:16", fill: "crop" },
    captions: { enabled: true, animation: "karaoke", font: "bold", template: "box", color: "FFFFFF", highlight: "34C759", positionY: 75, size: 1.1, emoji: false, wordsPerLine: 4, uppercase: false, outline: 1, activeMode: "box", pop: false },
    hook: { enabled: true, positionY: 12, uppercase: false, durationSec: 0, tone: "the question or claim being answered" },
    pacing: { targetMinSec: 25, targetMaxSec: 60, removeDeadAir: true, energy: "balanced" },
    motion: { punchIns: "light", intensity: 1.2, snap: true },
    grade: { colorFilter: "none", brightness: 0, contrast: 6, saturation: 0, vignette: false },
    transitions: { fadeIn: 0, fadeOut: 0.5, flashOnBeats: false },
    audio: { loudnorm: true },
    notes: "Open on the strongest opinion or the question. Snap-zoom when the speaker makes the key point. Keep the hook on screen the whole clip.",
  },
  cinematic: {
    name: "Cinematic",
    summary: "Moody, slow, filmic — warm grade, vignette, fades, minimal text.",
    framing: { aspect: "9:16", fill: "blur" },
    captions: { enabled: true, animation: "classic", font: "serif", template: "shadow", color: "FFFFFF", highlight: "FFE000", positionY: 82, size: 0.95, emoji: false },
    hook: { enabled: false, positionY: 12, uppercase: false, durationSec: 0, tone: "" },
    pacing: { targetMinSec: 20, targetMaxSec: 50, removeDeadAir: false, energy: "calm" },
    motion: { punchIns: "light", intensity: 1.1, snap: false },
    grade: { colorFilter: "warm", brightness: -4, contrast: 10, saturation: -6, vignette: true },
    transitions: { fadeIn: 0.8, fadeOut: 1, flashOnBeats: false },
    audio: { loudnorm: true },
    notes: "Let moments breathe. Slow push-ins only, no flashes. Fade in and out.",
  },
};

export const BUILTIN_STYLE_KEYS = Object.keys(BUILTIN_STYLES);

// ─── Sanitising (model output → safe values) ─────────────────────────────────

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : d;
  return Math.max(lo, Math.min(hi, n));
};
const hex = (v: unknown, d: string) => {
  const s = String(v ?? "").replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase();
  return s.length === 6 ? s : d;
};

export function sanitizeStyle(s: ClipStyle): ClipStyle {
  const minS = clamp(s.pacing.targetMinSec, 5, 120, 15);
  return {
    ...s,
    name: (s.name || "My style").slice(0, 40),
    summary: (s.summary || "").slice(0, 200),
    captions: {
      ...s.captions,
      color: hex(s.captions.color, "FFFFFF"),
      highlight: hex(s.captions.highlight, "FFE000"),
      positionY: clamp(s.captions.positionY, 8, 92, 72),
      size: clamp(s.captions.size, 0.6, 2.2, 1.2),
      ...captionLook(s),
    },
    hook: {
      ...s.hook,
      positionY: clamp(s.hook.positionY, 5, 95, 12),
      durationSec: clamp(s.hook.durationSec, 0, 15, 3),
      tone: (s.hook.tone || "").slice(0, 120),
    },
    pacing: { ...s.pacing, targetMinSec: minS, targetMaxSec: clamp(s.pacing.targetMaxSec, minS + 5, 180, Math.max(minS + 15, 40)) },
    motion: { ...s.motion, intensity: clamp(s.motion.intensity, 1.05, 1.6, 1.3) },
    grade: {
      ...s.grade,
      brightness: clamp(s.grade.brightness, -30, 30, 0),
      contrast: clamp(s.grade.contrast, -30, 30, 0),
      saturation: clamp(s.grade.saturation, -40, 40, 0),
    },
    transitions: {
      ...s.transitions,
      fadeIn: clamp(s.transitions.fadeIn, 0, 1.5, 0),
      fadeOut: clamp(s.transitions.fadeOut, 0, 1.5, 0),
    },
    notes: (s.notes || "").slice(0, 600),
  };
}

// ─── Prompt + enforcement ────────────────────────────────────────────────────

const PUNCH_RULE: Record<ClipStyle["motion"]["punchIns"], string> = {
  none: "NO zoom punch-ins at all (zoomKeys = [], zoom = 1).",
  light: "ONE punch-in, on the single biggest beat.",
  medium: "A punch-in on each key beat — roughly one every 8-12 seconds of kept footage.",
  heavy: "Frequent punch-ins — on nearly every reaction / emphasis, roughly every 3-6 seconds, alternating zoom in and back out.",
};

// The style rendered as instructions for the Auto-edit planner. Timing-free
// parts (fonts, grade) are enforced afterwards anyway — they're included so the
// model's choices (hook wording, beat picks) fit the look.
export function styleToPrompt(s: ClipStyle): string {
  return `EDIT IN THIS HOUSE STYLE — "${s.name}": ${s.summary}
- Length: ${s.pacing.targetMinSec}-${s.pacing.targetMaxSec}s of kept footage. Energy: ${s.pacing.energy}.
- Punch-ins: ${PUNCH_RULE[s.motion.punchIns]} Zoom factor ≈${s.motion.intensity.toFixed(2)}, ${s.motion.snap ? "snapping (zoomSmooth=false)" : "smooth ramps (zoomSmooth=true)"}.
- Captions: ${s.captions.enabled ? `yes — ${s.captions.animation} style${s.captions.emoji ? " with emoji" : ""}` : "none (generateSubtitles=false)"}.
- Hook text: ${s.hook.enabled ? `yes — ${s.hook.uppercase ? "ALL CAPS, " : ""}written as: ${s.hook.tone || "a short tease"}; ${s.hook.durationSec > 0 ? `show for the first ~${s.hook.durationSec}s` : "keep it up the whole clip"}` : "none (caption = empty string)"}.
- Flashes: ${s.transitions.flashOnBeats ? "add a short 'flash' effect (≈0.3s) on the single hardest-hitting beat" : "none"}.
- Style notes from the reference: ${s.notes}`;
}

// Extra editor fields a style controls that aren't part of the AI edit schema.
export type StyleExtras = {
  subtitleLook: SubtitleLook;
  splitScreen?: "facecam" | "off";
  detectFacecam?: boolean;
  subtitleHighlight: string;
  subtitleY: number;
  subtitleSize: number;
  subtitleX: number;
};

// Pin the look to the style, leaving the model's content decisions (trim,
// beat timing, hook wording, crop tracking) intact. Pure — returns a copy.
export function enforceStyle(e: ClipEdits, s: ClipStyle): ClipEdits & StyleExtras {
  const out: ClipEdits = { ...e };

  out.cropAspect = s.framing.aspect;
  out.cropFill = s.framing.fill;

  out.captionFont = s.captions.font;
  out.captionTemplate = s.captions.template;
  out.captionColor = s.captions.color;
  out.subtitleStyle = s.captions.animation;
  if (!s.captions.enabled) { out.generateSubtitles = false; out.subtitleEmoji = false; }
  else out.subtitleEmoji = s.captions.emoji && s.captions.animation !== "classic";

  if (!s.hook.enabled) {
    out.caption = ""; out.captionStart = 0; out.captionEnd = 0;
  } else if (out.caption) {
    if (s.hook.uppercase) out.caption = out.caption.toUpperCase();
    out.captionY = s.hook.positionY;
    out.captionX = 50;
    if (s.hook.durationSec > 0 && !(out.captionEnd > out.captionStart)) {
      out.captionStart = out.trimStart;
      out.captionEnd = Math.min(out.trimEnd, out.trimStart + s.hook.durationSec);
    }
  }

  // Motion: honour "none", cap intensity at the style's level (+ a little
  // headroom), and use the style's snap/ramp feel.
  if (s.motion.punchIns === "none") { out.zoomKeys = []; out.zoom = 1; }
  else {
    const cap = s.motion.intensity + 0.1;
    out.zoomKeys = out.zoomKeys.map((k) => ({ ...k, z: Math.max(1, Math.min(cap, k.z)) }));
    out.zoom = Math.max(1, Math.min(cap, out.zoom));
    out.zoomSmooth = !s.motion.snap;
  }

  out.colorFilter = s.grade.colorFilter;
  out.brightness = s.grade.brightness;
  out.contrast = s.grade.contrast;
  out.saturation = s.grade.saturation;
  out.vignette = s.grade.vignette;

  out.fadeIn = s.transitions.fadeIn;
  out.fadeOut = s.transitions.fadeOut;
  if (!s.transitions.flashOnBeats) out.effects = out.effects.filter((x) => x.type !== "flash");

  out.loudnorm = s.audio.loudnorm;

  return {
    ...out,
    ...layoutFields(s),
    subtitleLook: captionLook(s),
    subtitleHighlight: s.captions.highlight,
    subtitleY: s.captions.positionY,
    subtitleSize: s.captions.size,
    subtitleX: 50,
  };
}

/** Split-screen fields for the editor when the style uses a facecam layout. */
export function layoutFields(s: ClipStyle): Pick<StyleExtras, "splitScreen" | "detectFacecam"> {
  if (s.framing.layout === "facecam") return { splitScreen: "facecam", detectFacecam: true };
  if (s.framing.layout === "single") return { splitScreen: "off", detectFacecam: false };
  return {};
}

/** The style's caption details as a SubtitleLook (defaults for older styles). */
export function captionLook(s: ClipStyle): SubtitleLook {
  const c = s.captions;
  return sanitizeSubtitleLook({ wordsPerLine: c.wordsPerLine, uppercase: c.uppercase, outline: c.outline, activeMode: c.activeMode, pop: c.pop });
}

// Timing-free "apply the look only" — used by the editor's instant
// "Apply look" button (no AI call) and as the base template for batch renders.
export function styleLook(s: ClipStyle) {
  return {
    cropAspect: s.framing.aspect,
    cropFill: s.framing.fill,
    layout: s.framing.layout ?? null,
    textStyle: { font: s.captions.font, template: s.captions.template, color: s.captions.color },
    subtitleStyle: s.captions.animation,
    subtitleHighlight: s.captions.highlight,
    subtitleX: 50,
    subtitleY: s.captions.positionY,
    subtitleSize: s.captions.size,
    subtitleLook: captionLook(s),
    colorFilter: s.grade.colorFilter,
    brightness: s.grade.brightness,
    contrast: s.grade.contrast,
    saturation: s.grade.saturation,
    vignette: s.grade.vignette,
    fadeIn: s.transitions.fadeIn,
    fadeOut: s.transitions.fadeOut,
    loudnorm: s.audio.loudnorm,
  };
}
