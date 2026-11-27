// Fine-grained look for the ANIMATED subtitle styles (karaoke / word) — the
// details that make one creator's captions read differently from another's.
// Pure and framework-free: the editor preview (CSS) and the export (libass,
// lib/ass-subtitles.ts) both go through these helpers so they always agree.

export type ActiveWordMode = "color" | "box" | "scale";

export type SubtitleLook = {
  wordsPerLine: number;      // karaoke: words shown at once, 0 = the whole phrase
  uppercase: boolean;        // ALL-CAPS captions
  outline: number;           // outline/stroke thickness multiplier, 0 = none, 1 = default, up to 3
  activeMode: ActiveWordMode; // how the spoken word stands out: colour / coloured box / bigger
  pop: boolean;              // the active word pops in (scale bounce)
};

export const DEFAULT_SUBTITLE_LOOK: SubtitleLook = {
  wordsPerLine: 0, uppercase: false, outline: 1, activeMode: "color", pop: false,
};

export const ACTIVE_WORD_MODES: ActiveWordMode[] = ["color", "box", "scale"];

export function sanitizeSubtitleLook(v: unknown): SubtitleLook {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof SubtitleLook, unknown>>;
  const n = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  return {
    wordsPerLine: Math.max(0, Math.min(8, Math.round(n(o.wordsPerLine, 0)))),
    uppercase: o.uppercase === true,
    outline: Math.max(0, Math.min(3, n(o.outline, 1))),
    activeMode: ACTIVE_WORD_MODES.includes(o.activeMode as ActiveWordMode) ? o.activeMode as ActiveWordMode : "color",
    pop: o.pop === true,
  };
}

export type Win = { word: string; start: number; end: number; emoji?: string };

/**
 * Split a phrase's word windows into the groups shown on screen together.
 * wordsPerLine 0 → one group (the whole phrase). Groups never split a word
 * from its timing; each group is visible from its first word's start to its
 * last word's end.
 */
export function chunkWindows<W extends Win>(ws: W[], wordsPerLine: number): W[][] {
  if (!(wordsPerLine > 0) || ws.length <= wordsPerLine) return ws.length ? [ws] : [];
  const out: W[][] = [];
  for (let i = 0; i < ws.length; i += wordsPerLine) out.push(ws.slice(i, i + wordsPerLine));
  return out;
}

export const caseWord = (w: string, look: SubtitleLook) => (look.uppercase ? w.toUpperCase() : w);

/** Scale of the active word in "scale" mode (and the pop's resting size). */
export const ACTIVE_SCALE = 1.18;
/** Pop: active word starts this small and bounces to its resting size. */
export const POP_FROM = 0.72;
export const POP_MS = 110;
