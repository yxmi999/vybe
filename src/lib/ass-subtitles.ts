// Builds an ASS subtitle file for word-level animated captions, rendered by
// libass via FFmpeg's `subtitles` filter (server-side only — subtitles already
// force the server render path). Two looks:
//   • "karaoke" — the whole phrase stays on screen; the spoken word lights up in
//     the highlight colour (the dominant CapCut/TikTok style).
//   • "word"    — one big word at a time, centered, swapping as it's spoken.
import type { TextStyle } from "./clip-filters";
import { DEFAULT_SUBTITLE_LOOK, chunkWindows, caseWord, ACTIVE_SCALE, POP_FROM, POP_MS, type SubtitleLook } from "./subtitle-look";

export type SubWord = { word: string; start: number; end: number; emoji?: string };
export type SubSeg = { start: number; end: number; text: string; words?: SubWord[] };
export type SubtitleStyle = "classic" | "karaoke" | "word";

export type AssOptions = {
  segments: SubSeg[];
  mode: "karaoke" | "word";
  trimStart: number;
  trimEnd: number;
  speed: number;            // output time = (srcTime - trimStart) / speed
  outW: number;
  outH: number;
  style: TextStyle;         // template + base colour (shared with the caption)
  // Real family name (and matching bold flag) of the font file clip-render.ts
  // already resolved on disk for this style, paired with a `fontsdir` pointing
  // libass at that same file — this is a real, present family, not a name we
  // hope the host's fontconfig can resolve.
  fontFamily: string;
  fontBold: 0 | 1;
  highlightHex: string;     // active-word colour, 6-digit RRGGBB (no '#')
  posX: number;             // 0-100, % of frame width — center of the text block
  posY: number;             // 0-100, % of frame height
  sizeMul: number;          // font-size multiplier, 1 = default
  look?: SubtitleLook;      // words per line, caps, outline, active-word treatment, pop
};

// "RRGGBB" → ASS "&HAABBGGRR" (opaque). ASS orders bytes B,G,R after the alpha.
function assColor(hex: string, alpha = 0): string {
  const h = hex.replace(/[^0-9a-fA-F]/g, "").padStart(6, "0").slice(0, 6).toUpperCase();
  const rr = h.slice(0, 2), gg = h.slice(2, 4), bb = h.slice(4, 6);
  const aa = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${aa}${bb}${gg}${rr}`;
}

function assTime(s: number): string {
  const t = Math.max(0, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(Math.min(99, cs)).padStart(2, "0")}`;
}

// ASS override braces / backslashes would break the tag parser — strip them.
function clean(s: string): string {
  return s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
}

// Per-segment contiguous word windows: each word owns the time until the next
// word starts (last word until the segment end), so exactly one window is active
// at any moment inside the segment — no flicker, no gaps.
function wordWindows(seg: SubSeg): SubWord[] {
  let words = (seg.words ?? []).filter((w) => w && w.word && typeof w.start === "number" && typeof w.end === "number");
  if (words.length === 0) {
    const toks = clean(seg.text).split(" ").filter(Boolean);
    const dur = Math.max(0.3, seg.end - seg.start);
    const per = dur / Math.max(1, toks.length);
    words = toks.map((w, i) => ({ word: w, start: seg.start + i * per, end: seg.start + (i + 1) * per }));
  }
  const sorted = [...words].sort((a, b) => a.start - b.start);
  return sorted.map((w, i) => ({
    word: clean(w.word),
    start: i === 0 ? Math.max(seg.start, w.start) : sorted[i].start,
    end: i < sorted.length - 1 ? sorted[i + 1].start : Math.max(w.end, seg.end),
    emoji: typeof w.emoji === "string" && w.emoji.trim() ? w.emoji.trim() : undefined,
  })).filter((w) => w.word);
}

// template → libass border/shadow. Outline is black; box uses an opaque-ish back.
function borderForTemplate(t: TextStyle["template"]): { borderStyle: number; outline: number; shadow: number; back: string } {
  switch (t) {
    case "box":    return { borderStyle: 3, outline: 6, shadow: 0, back: assColor("000000", 0x40) };
    case "shadow": return { borderStyle: 1, outline: 1, shadow: 3, back: assColor("000000", 0x00) };
    case "pop":    return { borderStyle: 1, outline: 4, shadow: 2, back: assColor("000000", 0x60) };
    case "outline":
    default:       return { borderStyle: 1, outline: 3, shadow: 0, back: assColor("000000", 0x00) };
  }
}

export function buildAss(o: AssOptions): string {
  const font = { name: o.fontFamily, bold: o.fontBold };
  const base = assColor(o.style.color || "FFFFFF");
  const highlight = assColor(o.highlightHex || "FFE000");
  const outlineCol = assColor("000000");
  const look = o.look ?? DEFAULT_SUBTITLE_LOOK;
  const tb = borderForTemplate(o.style.template);
  const { borderStyle, shadow, back } = tb;
  // The box template's "outline" is the box padding — leave it; scale real strokes.
  const outline = borderStyle === 3 ? tb.outline : Math.round(tb.outline * look.outline * 10) / 10;

  const isWord = o.mode === "word";
  const sizeMul = o.sizeMul > 0 ? o.sizeMul : 1;
  const fontSize = Math.round(o.outH * (isWord ? 0.10 : 0.052) * sizeMul);
  // Alignment/MarginV below only seed the [V4+ Styles] default — every
  // Dialogue line carries its own `\an5\pos(x,y)` (below) so the user's
  // dragged position wins regardless of style/wrap.
  const alignment = 5;
  const marginV = 0;
  const posX = Math.round((o.posX / 100) * o.outW);
  const posY = Math.round((o.posY / 100) * o.outH);

  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    // 0 = smart wrap (top line wider): long karaoke phrases break onto extra
    // lines within MarginL/MarginR instead of running off the frame edges,
    // which is what WrapStyle 2 (no wrap) did.
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${o.outW}`,
    `PlayResY: ${o.outH}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: V,${font.name},${fontSize},${base},${base},${outlineCol},${back},${font.bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${alignment},${Math.round(o.outW * 0.06)},${Math.round(o.outW * 0.06)},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const outDur = Math.max(0.1, (o.trimEnd - o.trimStart) / o.speed);
  const toOut = (t: number) => (t - o.trimStart) / o.speed;
  const lines: string[] = [];

  // Active-word treatment. Tags are explicitly undone after the word (not with
  // a style reset, which would also wipe the line's base colour/border).
  const pct = (v: number) => Math.round(v * 100);
  const restScale = look.activeMode === "scale" ? ACTIVE_SCALE : 1;
  const popTag = look.pop ? `\\fscx${pct(POP_FROM * restScale)}\\fscy${pct(POP_FROM * restScale)}\\t(0,${POP_MS},\\fscx${pct(restScale)}\\fscy${pct(restScale)})` : "";
  const boxBord = Math.max(outline * 2.2, Math.round(fontSize * 0.14));
  const activeOn = (() => {
    switch (look.activeMode) {
      case "box":   return `{\\3c${highlight}\\bord${boxBord}\\shad0${popTag}}`;
      case "scale": return `{\\1c${highlight}${popTag || `\\fscx${pct(ACTIVE_SCALE)}\\fscy${pct(ACTIVE_SCALE)}`}}`;
      default:      return `{\\1c${highlight}${popTag}}`;
    }
  })();
  const activeOff = `{\\1c${base}\\3c${outlineCol}\\bord${outline}\\shad${shadow}\\fscx100\\fscy100}`;

  for (const seg of o.segments) {
    const windows = wordWindows(seg);
    for (const group of chunkWindows(windows, isWord ? 1 : look.wordsPerLine)) {
      group.forEach((w, i) => {
        const st = Math.max(0, toOut(w.start));
        const en = Math.min(outDur, toOut(w.end));
        if (en <= st) return;
        // An emoji rides after its word, outside the colour override so libass
        // renders it in the font's native (colour-emoji) glyph, not the text tint.
        const suffix = (ww: SubWord) => (ww.emoji ? ` ${ww.emoji}` : "");
        // `\an5\pos(x,y)` anchors the CENTER of the (possibly multi-line,
        // wrapped) text block at the user's dragged position — this overrides
        // the style's Alignment/MarginV for this line, so it's placed
        // identically regardless of style or how many lines it wraps to.
        const posTag = `{\\an5\\pos(${posX},${posY})}`;
        let text: string;
        if (isWord) {
          // One word at a time, always in the highlight colour and caps.
          const box = look.activeMode === "box" ? `\\3c${highlight}\\bord${boxBord}\\shad0` : `\\1c${highlight}`;
          const pop = look.pop ? `\\fscx${pct(POP_FROM)}\\fscy${pct(POP_FROM)}\\t(0,${POP_MS},\\fscx100\\fscy100)` : "";
          text = `${posTag}{${box}${pop}}${w.word.toUpperCase()}${activeOff}${suffix(w)}`;
        } else {
          text = posTag + group
            .map((ww, j) => {
              const word = caseWord(ww.word, look);
              return j === i ? `${activeOn}${word}${activeOff}${suffix(ww)}` : `${word}${suffix(ww)}`;
            })
            .join(" ");
        }
        lines.push(`Dialogue: 0,${assTime(st)},${assTime(en)},V,,0,0,0,,${text}`);
      });
    }
  }

  return `${head}\n${lines.join("\n")}\n`;
}
