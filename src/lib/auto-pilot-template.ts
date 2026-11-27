// The Auto-Pilot "look" template: what every clip a schedule produces gets.
// Shared by the builder UI and the API. Client-safe (no server imports).
//
// The template is stored as JSON and later spread into renderClip(), so it is
// WHITELISTED here: only known keys with validated values survive. Anything
// else (videoUrl, assets, trim…) is dropped — the engine supplies those itself.
import {
  ASPECT_KEYS, COLOR_FILTER_KEYS, isFontKey, sanitizeSplit,
  type AspectKey, type ColorFilterKey, type SplitConfig, type TextStyle,
} from "./clip-filters";

export type PilotSubtitles = {
  enabled: boolean;
  style: "karaoke" | "word" | "classic";   // animated (libass) or plain lines
  language: string;                        // "original" or a target language code
  emoji: boolean;                          // AI emoji on keywords (animated styles)
  highlight: string;                       // active-word colour, RRGGBB
  y: number;                               // vertical position 0–100
  size: number;                            // size multiplier
};

export type PilotTemplate = {
  cropAspect?: AspectKey;
  cropFill?: "crop" | "blur" | "split";
  split?: SplitConfig;                     // when cropFill === "split" (clip-only screens)
  autoFacecam?: boolean;                   // re-detect the facecam on every clip → frame screen 1 on it
  caption?: string;
  textStyle?: TextStyle;                   // caption + subtitle font/template/colour
  subtitles?: PilotSubtitles;
  colorFilter?: ColorFilterKey;
  brightness?: number; contrast?: number; saturation?: number;
  vignette?: boolean;
  introText?: string; outroText?: string;
  fadeIn?: number; fadeOut?: number;
  loudnorm?: boolean;
  styleRef?: string;                       // AI editing style ("builtin:hype" / "user:12")
  campaignId?: number;                     // revenue campaign for produced posts
};

export const DEFAULT_SUBTITLES: PilotSubtitles = {
  enabled: true, style: "karaoke", language: "original", emoji: true, highlight: "FFE000", y: 72, size: 1.2,
};

const TEMPLATES = ["outline", "box", "shadow", "pop"] as const;
const SUB_STYLES = ["karaoke", "word", "classic"] as const;
const hex = (v: unknown, d: string) => (typeof v === "string" && /^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : d);
const num = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function sanitizePilotTemplate(raw: unknown): PilotTemplate {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: PilotTemplate = {};

  if (typeof t.cropAspect === "string" && (ASPECT_KEYS as string[]).includes(t.cropAspect)) out.cropAspect = t.cropAspect as AspectKey;
  if (t.cropFill === "crop" || t.cropFill === "blur" || t.cropFill === "split") out.cropFill = t.cropFill;
  if (out.cropFill === "split") {
    const split = sanitizeSplit(t.split);
    // Auto-Pilot screens always crop the stream itself — no extra videos.
    if (split && out.cropAspect && out.cropAspect !== "original") {
      out.split = { ...split, panels: split.panels.map((p) => ({ cx: p.cx, cy: p.cy, zoom: p.zoom })) };
      if (t.autoFacecam === true) out.autoFacecam = true;
    } else {
      out.cropFill = "crop";
    }
  }

  const caption = text(t.caption, 120);
  if (caption) out.caption = caption;
  const ts = t.textStyle as Partial<TextStyle> | undefined;
  if (ts && typeof ts === "object") {
    out.textStyle = {
      font: isFontKey(ts.font) ? ts.font : "bold",
      color: hex(ts.color, "FFFFFF"),
      template: (TEMPLATES as readonly string[]).includes(String(ts.template)) ? ts.template as TextStyle["template"] : "outline",
    };
  }

  const s = t.subtitles as Partial<PilotSubtitles> | undefined;
  if (s && typeof s === "object" && s.enabled === true) {
    out.subtitles = {
      enabled: true,
      style: (SUB_STYLES as readonly string[]).includes(String(s.style)) ? s.style as PilotSubtitles["style"] : "karaoke",
      language: typeof s.language === "string" && /^[a-z]{2,8}$/.test(s.language) ? s.language : "original",
      emoji: s.emoji === true,
      highlight: hex(s.highlight, "FFE000"),
      y: num(s.y, 5, 95, 72),
      size: num(s.size, 0.6, 2.5, 1.2),
    };
  }

  if (typeof t.colorFilter === "string" && (COLOR_FILTER_KEYS as string[]).includes(t.colorFilter) && t.colorFilter !== "none") {
    out.colorFilter = t.colorFilter as ColorFilterKey;
  }
  for (const k of ["brightness", "contrast", "saturation"] as const) {
    const v = num(t[k], -50, 50, 0);
    if (v) out[k] = v;
  }
  if (t.vignette === true) out.vignette = true;
  const intro = text(t.introText, 60), outro = text(t.outroText, 60);
  if (intro) out.introText = intro;
  if (outro) out.outroText = outro;
  const fi = num(t.fadeIn, 0, 3, 0), fo = num(t.fadeOut, 0, 3, 0);
  if (fi) out.fadeIn = fi;
  if (fo) out.fadeOut = fo;
  if (t.loudnorm === true) out.loudnorm = true;
  if (typeof t.styleRef === "string" && /^(builtin|user):[\w-]{1,40}$/.test(t.styleRef)) out.styleRef = t.styleRef;
  if (typeof t.campaignId === "number" && Number.isInteger(t.campaignId) && t.campaignId > 0) out.campaignId = t.campaignId;
  return out;
}

export function parsePilotTemplate(raw: string | null | undefined): PilotTemplate {
  if (!raw) return {};
  try { return sanitizePilotTemplate(JSON.parse(raw)); } catch { return {}; }
}
