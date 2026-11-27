"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check, ChevronDown, Copy, Link2, Loader2, Trash2, Upload, X, Film, Palette, AlertCircle,
} from "lucide-react";
import type { ClipStyle } from "@/lib/clip-style";
import { cn } from "@/lib/utils";
import { textStyleCss } from "./editor-ui";

// "Copy a style" UI: pick a built-in or saved editing style, preview it, or
// analyze a reference clip into a new one. The selected style drives the
// editor's Auto-edit / Apply look (page.tsx) and is reused by the batch tools.

export type StyleOption = { ref: string; id: number | null; name: string; style: ClipStyle; source: string | null; builtin: boolean };

export function useStyles() {
  const [builtin, setBuiltin] = useState<StyleOption[]>([]);
  const [saved, setSaved] = useState<StyleOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => fetch("/api/styles")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      setBuiltin(d.builtin ?? []);
      setSaved(d.saved ?? []);
    })
    .catch(() => { /* offline — pickers just show nothing */ })
    .finally(() => setLoaded(true)), []);

  useEffect(() => {
    let alive = true;
    fetch("/api/styles")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) { setBuiltin(d.builtin ?? []); setSaved(d.saved ?? []); } })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  async function save(style: ClipStyle, name: string, source?: string): Promise<StyleOption> {
    const r = await fetch("/api/styles", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style, name, source }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? "Couldn't save the style");
    setSaved((prev) => [d as StyleOption, ...prev]);
    return d as StyleOption;
  }

  async function remove(opt: StyleOption) {
    if (opt.id == null) return;
    const r = await fetch(`/api/styles/${opt.id}`, { method: "DELETE" });
    if (r.ok) setSaved((prev) => prev.filter((s) => s.id !== opt.id));
  }

  return { builtin, saved, loaded, refresh, save, remove };
}

// ─── Preview card ────────────────────────────────────────────────────────────

const PUNCH_LABEL = { none: "No zooms", light: "Light zooms", medium: "Zooms on beats", heavy: "Heavy zooms" } as const;

// A tiny 9:16 "phone" showing what the style looks like: grade tint, hook
// text, and the caption treatment with its highlighted word.
export function StyleThumb({ style, size = 64 }: { style: ClipStyle; size?: number }) {
  const h = Math.round(size * 16 / 9);
  const tint: Record<string, string> = {
    none: "from-zinc-700 to-zinc-900", vivid: "from-rose-700/70 to-sky-800", warm: "from-orange-700/70 to-zinc-900",
    cool: "from-sky-800 to-zinc-900", bw: "from-zinc-500 to-zinc-900", sepia: "from-amber-800/70 to-stone-900",
    faded: "from-zinc-600/70 to-zinc-800",
  };
  const capPx = Math.max(6, Math.round(size * 0.11 * style.captions.size));
  const ts = { font: style.captions.font, template: style.captions.template, color: style.captions.color };
  return (
    <div className={cn("relative flex-shrink-0 rounded-md overflow-hidden bg-gradient-to-b border border-white/10", tint[style.grade.colorFilter] ?? tint.none)}
      style={{ width: size, height: h }}>
      {style.grade.vignette && <div className="absolute inset-0" style={{ boxShadow: "inset 0 0 18px rgba(0,0,0,0.85)" }} />}
      {style.hook.enabled && (
        <div className="absolute left-1 right-1 text-center leading-none font-black text-white"
          style={{ top: `${style.hook.positionY}%`, fontSize: Math.max(5, Math.round(size * 0.085)) }}>
          {style.hook.uppercase ? "WAIT FOR IT" : "Wait for it"}
        </div>
      )}
      {style.captions.enabled && (
        <div className="absolute left-0 right-0 flex justify-center" style={{ top: `${style.captions.positionY}%`, transform: "translateY(-50%)" }}>
          <span style={textStyleCss(ts, capPx)}>
            {style.captions.animation === "word" ? (
              <span style={{ color: `#${style.captions.highlight}` }}>NO</span>
            ) : (
              <>no <span style={{ color: style.captions.animation === "karaoke" ? `#${style.captions.highlight}` : undefined }}>way</span>{style.captions.emoji ? " 😱" : ""}</>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

export function StyleTags({ style }: { style: ClipStyle }) {
  const tags = [
    `${style.pacing.targetMinSec}–${style.pacing.targetMaxSec}s`,
    style.pacing.energy,
    style.captions.enabled ? `${style.captions.animation} captions` : "no captions",
    PUNCH_LABEL[style.motion.punchIns],
    style.grade.colorFilter !== "none" ? style.grade.colorFilter : "",
    style.pacing.removeDeadAir ? "jump cuts" : "",
    style.transitions.flashOnBeats ? "flashes" : "",
    style.hook.enabled ? "hook text" : "",
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="text-[10px] text-zinc-400 bg-white/[0.04] border border-white/[0.07] px-1.5 py-px rounded-full whitespace-nowrap">{t}</span>
      ))}
    </div>
  );
}

// ─── Picker ──────────────────────────────────────────────────────────────────

export function StylePicker({
  value, builtin, saved, onChange, onCopyNew, onDelete, disabled,
}: {
  value: StyleOption | null;
  builtin: StyleOption[];
  saved: StyleOption[];
  onChange: (s: StyleOption | null) => void;
  onCopyNew: () => void;
  onDelete: (s: StyleOption) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ left: number; width: number; bottom: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu is portaled with fixed positioning so the scrollable AI panel
  // can't clip it; it opens upward from the trigger.
  function toggle() {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setBox({ left: r.left, width: Math.max(r.width, 240), bottom: window.innerHeight - r.top + 4 });
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("resize", dismiss); };
  }, [open]);

  const row = (opt: StyleOption | null) => {
    const active = (value?.ref ?? null) === (opt?.ref ?? null);
    return (
      <div key={opt?.ref ?? "none"}
        className={cn("group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
          active ? "bg-violet-500/[0.12]" : "hover:bg-white/[0.05]")}
        onClick={() => { onChange(opt); setOpen(false); }}>
        {opt ? <StyleThumb style={opt.style} size={20} /> : (
          <div className="w-5 h-9 rounded-[4px] border border-dashed border-white/15 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] text-zinc-200 font-medium truncate">{opt ? opt.name : "No style"}</p>
          <p className="text-[10px] text-zinc-500 truncate">{opt ? opt.style.summary : "Auto-edit decides the look"}</p>
        </div>
        {active && <Check size={10} className="text-violet-300 flex-shrink-0" />}
        {opt && !opt.builtin && (
          <button type="button" title="Delete style"
            onClick={(e) => { e.stopPropagation(); onDelete(opt); }}
            className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-opacity p-0.5">
            <Trash2 size={10} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button type="button" disabled={disabled} onClick={toggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.08]
          hover:border-white/[0.16] disabled:opacity-40 transition-colors text-left">
        {value ? <StyleThumb style={value.style} size={14} /> : <Palette size={11} className="text-zinc-500 flex-shrink-0" />}
        <span className="flex-1 text-[11px] text-zinc-300 truncate">{value ? value.name : "No style"}</span>
        <ChevronDown size={10} className={cn("text-zinc-500 transition-transform", open && "rotate-180")} />
      </button>

      {open && box && createPortal(
        <div ref={menuRef} className="fixed z-[90] max-h-[min(380px,70vh)] overflow-y-auto rounded-xl
          bg-d14 border border-white/[0.1] shadow-2xl p-1"
          style={{ left: Math.min(box.left, window.innerWidth - box.width - 8), width: box.width, bottom: box.bottom }}>
          {row(null)}
          <p className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">Presets</p>
          {builtin.map((s) => row(s))}
          {saved.length > 0 && <p className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">Your styles</p>}
          {saved.map((s) => row(s))}
          <button type="button" onClick={() => { setOpen(false); onCopyNew(); }}
            className="mt-1 w-full flex items-center gap-1.5 px-2 py-2 rounded-md text-[11px] font-medium text-violet-300
              hover:bg-violet-500/[0.1] border-t border-white/[0.06]">
            <Copy size={10} /> Copy a style from a clip…
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Copy-a-style modal ──────────────────────────────────────────────────────

const STEPS = ["Fetching the clip", "Measuring cuts & pacing", "Watching captions, zooms & grade", "Writing the style recipe"];

type CopyStyleProps = {
  open: boolean;
  onClose: () => void;
  onSaved: (s: StyleOption) => void;
  save: (style: ClipStyle, name: string, source?: string) => Promise<StyleOption>;
  currentClipUrl?: string;   // server-fetchable URL of the clip open in the editor
};

// The body only mounts while open, so every opening starts from a clean state.
export function CopyStyleModal(props: CopyStyleProps) {
  return props.open ? <CopyStyleBody {...props} /> : null;
}

function CopyStyleBody({ onClose, onSaved, save, currentClipUrl }: CopyStyleProps) {
  const [mode, setMode] = useState<"link" | "file" | "current">("link");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ style: ClipStyle; facts: { duration: number; cutsPerMin: number; aspect?: string | null; pausesPerMin?: number; verified?: boolean }; source: string } | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const canRun = mode === "link" ? !!link.trim() : mode === "file" ? !!file : !!currentClipUrl;

  async function analyze() {
    if (!canRun || busy) return;
    setBusy(true); setError(""); setResult(null); setStep(0);
    // The server does it in one call; advance the visible steps on a rough
    // schedule so the wait reads as progress, and snap to done on return.
    timers.current = [6000, 14000, 30000].map((ms, i) => setTimeout(() => setStep(i + 1), ms));
    try {
      let res: Response;
      if (mode === "file" && file) {
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch("/api/styles/analyze", { method: "POST", body: fd });
      } else {
        res = await fetch("/api/styles/analyze", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: mode === "link" ? link.trim() : currentClipUrl }),
        });
      }
      const d = await res.json().catch(() => ({ error: "The server returned an unexpected response." }));
      if (!res.ok) throw new Error(d.error ?? "Couldn't analyze that clip");
      setResult({ style: d.style, facts: d.facts, source: d.source || (mode === "current" ? "Current clip" : "") });
      setName(d.style?.name ?? "My style");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't analyze that clip");
    } finally {
      timers.current.forEach(clearTimeout);
      setBusy(false);
    }
  }

  async function keep() {
    if (!result) return;
    setSaving(true); setError("");
    try {
      const saved = await save(result.style, name.trim() || result.style.name, result.source);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the style");
    } finally {
      setSaving(false);
    }
  }

  const tab = (m: typeof mode, icon: React.ReactNode, label: string, disabled = false) => (
    <button type="button" disabled={disabled || busy} onClick={() => setMode(m)}
      className={cn("flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-35",
        mode === m ? "bg-white/[0.08] text-white" : "text-zinc-500 hover:text-zinc-300")}>
      {icon}{label}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="w-full max-w-[460px] rounded-2xl bg-d11 border border-white/[0.09] shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-white/[0.05]">
          <div>
            <h2 className="text-[14px] font-semibold text-white">Copy a style</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
              Show the AI a short you love. It learns the captions, hook text, pacing, zooms and color
              grade — then Auto-edit, Schedule a week and Auto-Pilot edit new clips the same way.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-zinc-500 hover:text-white p-1 -mr-1 disabled:opacity-30">
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {!result && (
            <>
              <div className="flex gap-1 p-0.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                {tab("link", <Link2 size={10} />, "Paste link")}
                {tab("file", <Upload size={10} />, "Upload")}
                {tab("current", <Film size={10} />, "This clip", !currentClipUrl)}
              </div>

              {mode === "link" && (
                <input autoFocus value={link} onChange={(e) => setLink(e.target.value)} disabled={busy}
                  onKeyDown={(e) => { if (e.key === "Enter") void analyze(); }}
                  placeholder="TikTok, YouTube Shorts, Reels, X, Twitch or Kick link"
                  className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[12px] text-white
                    placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/50" />
              )}
              {mode === "file" && (
                <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
                  className="w-full flex flex-col items-center justify-center gap-1 py-5 rounded-lg border border-dashed
                    border-white/[0.12] hover:border-violet-500/40 text-[11px] text-zinc-400 transition-colors">
                  <Upload size={14} className="text-zinc-500" />
                  {file ? <span className="text-zinc-200">{file.name}</span> : "Choose a video file (max 200 MB)"}
                  <input ref={fileRef} type="file" accept="video/*" hidden
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </button>
              )}
              {mode === "current" && (
                <p className="text-[11px] text-zinc-400 leading-relaxed rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2.5">
                  Use the clip that&apos;s open in the editor as the reference — handy when you imported someone&apos;s short to study it.
                </p>
              )}

              {busy && (
                <div className="space-y-1.5 py-1">
                  {STEPS.map((s, i) => (
                    <div key={s} className={cn("flex items-center gap-2 text-[11px] transition-colors",
                      i < step ? "text-zinc-400" : i === step ? "text-white" : "text-zinc-600")}>
                      {i < step ? <Check size={10} className="text-violet-400" />
                        : i === step ? <Loader2 size={10} className="animate-spin text-violet-300" />
                        : <span className="w-2.5 h-2.5 rounded-full border border-white/15" />}
                      {s}
                    </div>
                  ))}
                </div>
              )}

              <button type="button" onClick={analyze} disabled={!canRun || busy}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-semibold
                  bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors">
                {busy ? <><Loader2 size={11} className="animate-spin" /> Analyzing…</> : <><Copy size={11} /> Analyze style</>}
              </button>
            </>
          )}

          {result && (
            <div className="space-y-3">
              <div className="flex gap-3">
                <StyleThumb style={result.style} size={84} />
                <div className="flex-1 min-w-0 space-y-2">
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
                    className="w-full px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.08] text-[12px] font-semibold text-white
                      focus:outline-none focus:border-violet-500/50" />
                  <p className="text-[11px] text-zinc-400 leading-relaxed">{result.style.summary}</p>
                  <StyleTags style={result.style} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-zinc-500 rounded-lg bg-white/[0.02] border border-white/[0.05] px-3 py-2">
                <span>Reference length</span><span className="text-zinc-300 text-right">{result.facts.duration ? `${result.facts.duration.toFixed(0)}s` : "—"}</span>
                <span>Cut rate</span><span className="text-zinc-300 text-right">{result.facts.cutsPerMin}/min</span>
                {result.facts.pausesPerMin != null && (<>
                  <span>Pauses</span><span className="text-zinc-300 text-right">{result.facts.pausesPerMin}/min</span>
                </>)}
                <span>Framing</span>
                <span className="text-zinc-300 text-right">
                  {result.style.framing.aspect}{result.style.framing.layout === "facecam" ? " · facecam split" : result.style.framing.fill === "blur" ? " · blur fill" : ""}
                </span>
                <span>Captions</span>
                <span className="text-zinc-300 text-right">
                  {result.style.captions.enabled
                    ? `${result.style.captions.font} · ${result.style.captions.template}${result.style.captions.uppercase ? " · CAPS" : ""}${result.style.captions.wordsPerLine ? ` · ${result.style.captions.wordsPerLine}/line` : ""}`
                    : "none"}
                </span>
                {result.style.captions.enabled && (<>
                  <span>Caption check</span>
                  <span className={result.facts.verified ? "text-emerald-400/80 text-right" : "text-zinc-500 text-right"}>
                    {result.facts.verified ? "re-created & verified" : "not verified"}
                  </span>
                </>)}
                <span>Hook text</span>
                <span className="text-zinc-300 text-right truncate">{result.style.hook.enabled ? result.style.hook.tone || "yes" : "none"}</span>
              </div>

              {result.style.notes && (
                <p className="text-[11px] text-zinc-400 leading-relaxed border-l-2 border-violet-500/40 pl-2.5">{result.style.notes}</p>
              )}

              <div className="flex gap-2">
                <button type="button" onClick={() => setResult(null)} disabled={saving}
                  className="px-3 py-2 rounded-lg text-[12px] text-zinc-400 hover:text-white bg-white/[0.04] border border-white/[0.08]">
                  Try another
                </button>
                <button type="button" onClick={keep} disabled={saving}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-semibold
                    bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 transition-colors">
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save &amp; use this style
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="flex items-start gap-1.5 text-[11px] text-red-400 bg-red-500/[0.07] border border-red-500/15 rounded-lg px-3 py-2">
              <AlertCircle size={10} className="flex-shrink-0 mt-px" /> {error}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
