"use client";
// Subtitle editor panel — edit text, split, merge, delete, add, and retime
// subtitles. Subtitles are edited in SOURCE time (they come from the
// transcript); this panel maps to TIMELINE time only for the seek buttons,
// via the same mapSubtitlesToTimeline() the server uses at export, so
// preview and export always agree.
import { Scissors, X, Plus } from "lucide-react";
import { formatTime } from "./editor-types";
import type { Subtitle } from "./editor-types";
import { type Clip, mapSubtitlesToTimeline } from "@/lib/timeline";
import { DInput } from "./editor-ui";

export function SubtitlePanel({
  subtitles, clips, onSeek, onUpdateText, onUpdateTiming, onSplit, onMerge, onAdd, onDelete, onBeginEdit,
}: {
  subtitles: Subtitle[];
  clips: Clip[];
  onSeek: (t: number) => void;
  onUpdateText: (id: string, text: string) => void;
  onUpdateTiming: (id: string, start: number, end: number) => void;
  onSplit: (id: string) => void;
  onMerge: (firstId: string, secondId: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  // One undo snapshot per editing session (fired on focus, not per keystroke).
  onBeginEdit: () => void;
}) {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start);
  const seekTimeFor = (s: Subtitle) => mapSubtitlesToTimeline([s], clips)[0]?.start ?? 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold">
          {sorted.length} line{sorted.length === 1 ? "" : "s"}
        </p>
        <button type="button" onClick={onAdd}
          className="flex items-center gap-1 text-[11px] font-semibold text-violet-300/70 hover:text-violet-200 transition-colors">
          <Plus size={11} /> Add line
        </button>
      </div>

      <div className="space-y-1 max-h-72 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/[0.08] pr-0.5">
        {sorted.map((s, i) => {
          const next = sorted[i + 1];
          return (
            <div key={s.id} className="bg-black/25 border border-white/[0.05] rounded-md px-2 py-1.5 space-y-1">
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => onSeek(seekTimeFor(s))}
                  className="font-mono text-[11px] text-violet-300/70 hover:text-violet-200 tabular-nums flex-shrink-0">
                  {formatTime(s.start)}
                </button>
                <input
                  value={s.text}
                  onFocus={onBeginEdit}
                  onChange={(e) => onUpdateText(s.id, e.target.value)}
                  className="flex-1 bg-transparent text-[12px] text-white/70 outline-none min-w-0"
                />
                <button type="button" onClick={() => onSplit(s.id)} title="Split at playhead"
                  className="text-white/20 hover:text-violet-300 transition-colors flex-shrink-0">
                  <Scissors size={11} />
                </button>
                {next && (
                  <button type="button" onClick={() => onMerge(s.id, next.id)} title="Merge with next line"
                    className="text-white/20 hover:text-violet-300 transition-colors flex-shrink-0 text-[11px] font-bold">
                    ⤒
                  </button>
                )}
                <button type="button" onClick={() => onDelete(s.id)} title="Delete"
                  className="text-white/20 hover:text-red-400 transition-colors flex-shrink-0">
                  <X size={11} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 pl-0.5">
                <span className="text-[7px] text-zinc-600 uppercase tracking-wider font-semibold flex-shrink-0">In/out</span>
                <DInput type="number" step={0.1} min={0} value={s.start.toFixed(2)}
                  onFocus={onBeginEdit}
                  onChange={(e) => onUpdateTiming(s.id, Number(e.target.value), s.end)}
                  className="w-16 text-center font-mono text-[11px] py-0.5" />
                <span className="text-white/15 text-[11px]">–</span>
                <DInput type="number" step={0.1} min={0} value={s.end.toFixed(2)}
                  onFocus={onBeginEdit}
                  onChange={(e) => onUpdateTiming(s.id, s.start, Number(e.target.value))}
                  className="w-16 text-center font-mono text-[11px] py-0.5" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
