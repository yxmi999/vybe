"use client";
// Drop-target empty state shown before a clip is loaded.
import { useState } from "react";
import Link from "next/link";
import { Loader2, UploadCloud, Link2, Wand2, ArrowRight, Sparkles, Captions, Crop, Scissors } from "lucide-react";

const SOURCES = [
  { label: "Twitch", dot: "bg-purple-500" },
  { label: "Kick", dot: "bg-green-500" },
  { label: "YouTube", dot: "bg-red-500" },
  { label: "TikTok", dot: "bg-white/60" },
  { label: "Instagram", dot: "bg-pink-500" },
  { label: "Your files", dot: "bg-violet-400" },
];

const NEXT = [
  { icon: Sparkles, label: "One-click Auto-edit" },
  { icon: Crop, label: "Vertical + facecam" },
  { icon: Captions, label: "Animated captions" },
  { icon: Scissors, label: "Cut dead air" },
];

export function EmptyState({ fetching, onFile, onBrowse }: {
  fetching: boolean;
  onFile: (f: File) => void;
  onBrowse: () => void;
}) {
  const [over, setOver] = useState(false);

  if (fetching) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6" style={{ minHeight: 420 }}>
        <div className="relative">
          <div className="w-16 h-16 rounded-2xl bg-violet-600/10 border border-violet-500/25 flex items-center justify-center">
            <Loader2 size={26} className="text-violet-400 animate-spin" />
          </div>
          <div className="absolute inset-0 rounded-2xl bg-violet-500/10 blur-xl animate-pulse" />
        </div>
        <div>
          <p className="text-white/80 font-semibold text-[15px]">Importing your clip…</p>
          <p className="text-white/40 text-[13px] mt-1 max-w-xs">Kick, TikTok and YouTube links download the full video first — this can take 30–90 seconds.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col items-center px-4 sm:px-8 py-8 sm:py-14"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
    >
      <div className="w-full max-w-2xl">
        <div className="anim-rise text-center mb-7 sm:mb-9">
          <p className="cue text-violet-400/90 mb-3">Clip editor</p>
          <h1 className="font-display text-[32px] sm:text-5xl font-extrabold tracking-tight leading-none text-white">
            Drop in a clip<span className="text-violet-500">.</span>
          </h1>
          <p className="mt-3 text-[15px] text-white/50 leading-relaxed max-w-md mx-auto">
            Paste a link in the bar above, or bring your own video. AI can take it from there.
          </p>
        </div>

        {/* Drop zone */}
        <button type="button" onClick={onBrowse}
          className={`anim-rise d-1 w-full rounded-3xl border-2 border-dashed px-6 py-10 sm:py-14 flex flex-col items-center gap-4 text-center
            transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50
            ${over
              ? "border-violet-400/70 bg-violet-500/[0.08] shadow-[0_0_40px_rgba(51,92,186,0.2)]"
              : "border-white/[0.1] bg-white/[0.02] hover:border-violet-500/40 hover:bg-violet-500/[0.04]"}`}>
          <span className={`w-14 h-14 rounded-2xl flex items-center justify-center border transition-colors ${over ? "bg-violet-500/20 border-violet-400/40" : "bg-white/[0.04] border-white/[0.08]"}`}>
            <UploadCloud size={26} className={over ? "text-violet-200" : "text-white/45"} />
          </span>
          <span>
            <span className="block text-[16px] font-semibold text-white/85">
              {over ? "Drop to start editing" : <><span className="hidden sm:inline">Drag a video here or </span><span className="text-violet-300">choose a file</span></>}
            </span>
            <span className="block mt-1 text-[13px] text-white/35">MP4, MOV, WebM, MKV and more</span>
          </span>
        </button>

        {/* Other ways in */}
        <div className="anim-rise d-2 grid sm:grid-cols-2 gap-3 mt-3">
          <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <span className="w-10 h-10 rounded-xl bg-white/[0.05] border border-white/[0.08] flex items-center justify-center flex-shrink-0">
              <Link2 size={18} className="text-white/55" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-white/85">Paste a link</p>
              <p className="text-[12px] text-white/40 leading-snug">Clips, VODs and shorts — use the bar at the top.</p>
            </div>
          </div>
          <Link href="/auto-clipper"
            className="group flex items-center gap-3 rounded-2xl border border-violet-500/25 bg-violet-500/[0.06] p-4 hover:border-violet-500/45 hover:bg-violet-500/[0.1] transition-colors">
            <span className="w-10 h-10 rounded-xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center flex-shrink-0">
              <Wand2 size={18} className="text-violet-200" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-white/90">Find clips in a VOD</p>
              <p className="text-[12px] text-white/45 leading-snug">Auto-Clipper scans a stream for highlights.</p>
            </div>
            <ArrowRight size={16} className="text-violet-300/60 group-hover:translate-x-0.5 transition-transform flex-shrink-0" />
          </Link>
        </div>

        <div className="anim-rise d-3 mt-8 flex flex-wrap items-center justify-center gap-2">
          {SOURCES.map(({ label, dot }) => (
            <span key={label} className="flex items-center gap-1.5 text-[12px] font-medium text-white/50 bg-white/[0.03] border border-white/[0.06] rounded-full px-2.5 py-1">
              <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{label}
            </span>
          ))}
        </div>

        <div className="anim-rise d-4 mt-8 pt-6 border-t border-white/[0.05] grid grid-cols-2 sm:grid-cols-4 gap-3">
          {NEXT.map(({ icon: Icon, label }) => (
            <div key={label} className="flex items-center gap-2 text-[12px] text-white/45">
              <Icon size={14} className="text-violet-400/70 flex-shrink-0" />{label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
