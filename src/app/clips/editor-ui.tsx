"use client";
// Small presentational primitives for the clip editor (extracted from page.tsx).
import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { FONT_KEYS, TEXT_FONTS, type TextStyle } from "@/lib/clip-filters";

// Same font files the export burns in (public/fonts, @font-face in globals.css).
export const fontCss = (k: TextStyle["font"]) => `'${(TEXT_FONTS[k] ?? TEXT_FONTS.bold).css}', sans-serif`;
const STYLE_FONTS_UI = FONT_KEYS.map((k) => ({ k, label: TEXT_FONTS[k].label }));
const STYLE_TEMPLATES: { k: TextStyle["template"]; label: string }[] = [
  { k: "outline", label: "Outline" }, { k: "box", label: "Box" }, { k: "shadow", label: "Shadow" }, { k: "pop", label: "Pop" },
];
const STYLE_COLORS = ["FFFFFF", "FFE000", "000000", "FF3B30", "34C759", "32ADE6", "FF2D92", "AF7BFF"];

// Approximate the burned-in look for the live preview.
export function textStyleCss(style: TextStyle, sizePx: number, outlineMul = 1): React.CSSProperties {
  // Mirrors styleDrawOptions (lib/clip-filters): stroke ~ size/16, soft shadow.
  // paint-order keeps the stroke outside the glyph like ffmpeg's borderw.
  // outlineMul scales the stroke (animated subtitle look; 0 = no outline).
  const stroke = Math.max(1, sizePx / 16) * outlineMul;
  const sh = Math.max(1, sizePx / 22);
  const css: React.CSSProperties = {
    fontFamily: fontCss(style.font),
    color: `#${style.color}`,
    fontSize: `${sizePx}px`,
    fontWeight: 400, // each style is its own weight-specific file; never fake-bold
    lineHeight: 1.1,
    padding: "0 0.12em",
    paintOrder: "stroke fill",
  };
  if (style.template === "box") {
    css.background = "rgba(0,0,0,0.62)";
    css.padding = "0.08em 0.28em";
    css.borderRadius = "0.12em";
  } else if (style.template === "shadow") {
    css.textShadow = `${sh}px ${sh}px 0 rgba(0,0,0,0.7)`;
  } else if (style.template === "pop") {
    css.WebkitTextStroke = `${stroke * 1.6 * 2}px #000`;
    css.textShadow = `${sh + 1}px ${sh + 2}px 0 rgba(0,0,0,0.9)`;
  } else {
    css.WebkitTextStroke = `${stroke * 2}px #000`;
    css.textShadow = `0 ${sh}px 0 rgba(0,0,0,0.35)`;
  }
  return css;
}

export function TextStylePicker({ style, onChange }: { style: TextStyle; onChange: (s: TextStyle) => void }) {
  return (
    <div className="space-y-1.5 pt-1.5 mt-1 border-t border-white/[0.05]">
      <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">Text style</p>
      <div className="grid grid-cols-3 gap-1">
        {STYLE_FONTS_UI.map(({ k, label }) => (
          <button key={k} type="button" onClick={() => onChange({ ...style, font: k })}
            style={{ fontFamily: fontCss(k) }}
            className={`py-1.5 rounded-md text-[12px] border transition-colors ${
              style.font === k ? "bg-violet-600/20 border-violet-500/40 text-violet-200" : "bg-white/[0.03] border-white/[0.05] text-white/45 hover:text-white/70"
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex gap-1">
        {STYLE_TEMPLATES.map(({ k, label }) => (
          <button key={k} type="button" onClick={() => onChange({ ...style, template: k })}
            className={`flex-1 py-1.5 rounded-md text-[11px] font-semibold border transition-colors ${
              style.template === k ? "bg-violet-600/20 border-violet-500/40 text-violet-200" : "bg-white/[0.03] border-white/[0.05] text-white/40 hover:text-white/65"
            }`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {STYLE_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => onChange({ ...style, color: c })}
            title={`#${c}`}
            className={`w-6 h-6 rounded-full border transition-transform ${style.color === c ? "ring-2 ring-violet-400 scale-110 border-transparent" : "border-white/20 hover:scale-110"}`}
            style={{ backgroundColor: `#${c}` }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Glow dot ────────────────────────────────────────────────────────────────

export function GlowDot({ pulse = false, color = "violet" }: { pulse?: boolean; color?: "violet" | "green" | "amber" }) {
  const colors = {
    violet: { ring: "bg-violet-400", core: "bg-violet-500" },
    green:  { ring: "bg-green-400",  core: "bg-green-500"  },
    amber:  { ring: "bg-amber-400",  core: "bg-amber-500"  },
  };
  const c = colors[color];
  return (
    <span className="relative inline-flex h-1.5 w-1.5 flex-shrink-0">
      {pulse && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${c.ring} opacity-60`} />}
      <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${c.core} shadow-[0_0_6px_2px_rgba(51,92,186,0.4)]`} />
    </span>
  );
}

// ─── Inspector primitives ─────────────────────────────────────────────────────

export function Section({
  icon: Icon, label, children, badge, summary, active = false,
  defaultOpen = false, hidden = false, open, onToggle,
}: {
  icon: React.ElementType; label: string; children: React.ReactNode;
  badge?: React.ReactNode; summary?: React.ReactNode; active?: boolean;
  defaultOpen?: boolean; hidden?: boolean;
  open?: boolean; onToggle?: () => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const toggle = () => (isControlled ? onToggle?.() : setInternalOpen((v) => !v));
  if (hidden) return null;
  return (
    <div className={`border-b border-white/[0.04] transition-colors duration-200 ${isOpen ? "bg-white/[0.018]" : ""}`}>
      {/* Header is a div (not a button) so an interactive `badge` — e.g. a reset
          button — can live inside it without nesting <button> in <button>. */}
      <div
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
        className="w-full flex items-center gap-2.5 px-4 py-3 cursor-pointer hover:bg-white/[0.03] focus-visible:outline-none focus-visible:bg-white/[0.04] transition-all duration-200 ease-out group select-none"
      >
        <span className="relative flex-shrink-0">
          <Icon size={13} className={`transition-colors duration-200 ${active ? "text-violet-400" : "text-violet-400/45 group-hover:text-violet-400/80"}`} />
          {active && !isOpen && (
            <span className="absolute -top-1 -right-1 w-1 h-1 rounded-full bg-violet-400 shadow-[0_0_4px_rgba(51,92,186,0.8)]" />
          )}
        </span>
        <span className={`text-[11px] tracking-wider uppercase font-semibold transition-colors duration-200 ${isOpen ? "text-zinc-300" : "text-zinc-500 group-hover:text-zinc-400"}`}>
          {label}
        </span>
        <div className="flex-1" />
        {isOpen
          ? badge
          : summary != null && (
              <span className={`text-[11px] font-medium truncate max-w-[170px] tabular-nums transition-colors ${active ? "text-violet-300/80" : "text-white/25"}`}>
                {summary}
              </span>
            )}
        <ChevronRight
          size={11}
          className={`text-zinc-600 transition-transform duration-200 ease-out flex-shrink-0 ${isOpen ? "rotate-90" : ""}`}
        />
      </div>
      <div
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{ maxHeight: isOpen ? 3000 : 0, opacity: isOpen ? 1 : 0 }}
      >
        <div className="px-4 pb-4 pt-0.5 space-y-3">
          {children}
        </div>
      </div>
    </div>
  );
}

export function DInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full bg-d08 border border-white/[0.07] rounded-lg px-2.5 py-2 text-[13px] text-white/80
        outline-none shadow-[inset_0_1px_3px_rgba(0,0,0,0.5)]
        focus:border-violet-500/40 focus:shadow-[inset_0_1px_3px_rgba(0,0,0,0.5),0_0_0_2px_rgba(51,92,186,0.1)]
        transition-all duration-200 ease-out placeholder:text-white/15
        [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none ${className}`}
    />
  );
}

export function DSlider({ label, value, min, max, step = 1, onChange, format, resetTo }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string;
  /** Double-click the slider (or click the value) to snap back to this. */
  resetTo?: number;
}) {
  const pct = Math.round(((value - min) / (max - min)) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-zinc-500 font-medium tracking-wide">{label}</span>
        <button type="button"
          onClick={() => resetTo !== undefined && onChange(resetTo)}
          title={resetTo !== undefined && value !== resetTo ? "Click to reset" : undefined}
          className={`text-[11px] font-mono tabular-nums bg-white/[0.05] border border-white/[0.06] px-1.5 py-px rounded transition-colors ${
            resetTo !== undefined && value !== resetTo ? "text-violet-200 hover:border-violet-500/40 cursor-pointer" : "text-zinc-400 cursor-default"
          }`}>
          {format ? format(value) : value}
        </button>
      </div>
      <div className="relative h-2 rounded-full bg-white/[0.06] shadow-[inset_0_1px_2px_rgba(0,0,0,0.4)]"
        onDoubleClick={() => resetTo !== undefined && onChange(resetTo)}>
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-violet-700 to-violet-400"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className="absolute -inset-y-2.5 inset-x-0 w-full h-[calc(100%+20px)] opacity-0 cursor-pointer touch-none"
        />
        <div
          className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-[0_0_0_2px_rgba(51,92,186,0.45),0_1px_4px_rgba(0,0,0,0.5)] pointer-events-none transition-all duration-75"
          style={{ left: `${pct}%`, transform: "translate(-50%,-50%)" }}
        />
      </div>
    </div>
  );
}

// ─── Transport ────────────────────────────────────────────────────────────────

export function TransportBtn({ label, onClick, disabled, children, className = "" }: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; className?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className={`w-9 h-9 flex items-center justify-center rounded-lg text-white/60 hover:text-white hover:bg-white/[0.07]
        active:bg-white/[0.1] disabled:opacity-25 disabled:hover:bg-transparent transition-colors ${className}`}>
      {children}
    </button>
  );
}

// ─── Keyboard shortcuts overlay ───────────────────────────────────────────────

export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Space"], label: "Play / pause" },
  { keys: ["K"], label: "Pause" },
  { keys: ["J"], label: "Back 5 seconds" },
  { keys: ["L"], label: "Forward 5 seconds" },
  { keys: ["←", "→"], label: "Back / forward 1s (Shift: 5s)" },
  { keys: [",", "."], label: "Step one frame" },
  { keys: ["Home", "End"], label: "Jump to start / end" },
  { keys: ["S"], label: "Split at playhead" },
  { keys: ["Q"], label: "Trim segment start to playhead" },
  { keys: ["W"], label: "Trim segment end to playhead" },
  { keys: ["Del"], label: "Delete segment under playhead" },
  { keys: ["Ctrl", "Wheel"], label: "Zoom the timeline" },
  { keys: ["Alt"], label: "Hold while trimming to skip snapping" },
  { keys: ["Ctrl", "Z"], label: "Undo" },
  { keys: ["Ctrl", "Shift", "Z"], label: "Redo (or Ctrl+Y)" },
  { keys: ["1–7"], label: "Switch tool tab" },
  { keys: ["?"], label: "Show this panel" },
];

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
        className="w-full max-w-md rounded-2xl border border-white/[0.09] bg-d11 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <p className="text-[15px] font-semibold text-white/90">Keyboard shortcuts</p>
          <button type="button" onClick={onClose} aria-label="Close" className="w-8 h-8 -mr-2 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06]">
            <X size={16} />
          </button>
        </div>
        <ul className="px-5 py-3 space-y-0.5">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-4 py-1.5">
              <span className="text-[13px] text-white/65">{s.label}</span>
              <span className="flex items-center gap-1 flex-shrink-0">
                {s.keys.map((k) => (
                  <kbd key={k} className="min-w-[26px] text-center text-[11px] font-mono text-white/80 bg-white/[0.06] border border-white/[0.1] border-b-2 rounded-md px-1.5 py-0.5">{k}</kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
