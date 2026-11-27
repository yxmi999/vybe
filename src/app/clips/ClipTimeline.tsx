"use client";
// Non-destructive multi-clip timeline. One block per Clip over the assembled
// duration, with:
//  • edge trim that follows the cursor 1:1 (delta from drag start, scale and
//    layout frozen for the gesture, ripple applied on release), live preview
//    of the frame being trimmed to, and snapping to playhead/segment edges
//  • drag a segment's body to reorder it (mouse: just drag; touch: hold first,
//    a quick swipe pans the zoomed timeline instead)
//  • zoom (Ctrl/⌘+wheel, buttons) with horizontal scroll and playhead follow
//  • filmstrip thumbnails sampled from the source video
//  • click / drag the ruler to scrub
//  • per-segment volume, and extra tracks under the video: an overlay track
//    (image / video footage) and an audio track (sound effects + music) whose
//    items are dragged to move, edge-dragged to resize, and accept dropped files
import { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback } from "react";
import { formatTime, formatTimecode } from "./editor-types";
import { totalDuration, clipVolume, MIN_CLIP_DURATION, type Clip } from "@/lib/timeline";
import {
  Trash2, ZoomIn, ZoomOut, Magnet, Scissors, ArrowLeftToLine, ArrowRightToLine, Maximize,
  Volume2, VolumeX, Plus, Music, Image as ImageIcon, Film, AudioLines, Loader2,
} from "lucide-react";

export type TrackItemType = "image" | "video" | "sound" | "music";
export type TrackItem = {
  id: string;
  type: TrackItemType;
  name: string;
  start: number;      // timeline seconds
  duration: number;
  volume?: number;    // percent; absent = no audio (images)
  uploading?: boolean;
  thumb?: string;     // image preview
  fixedStart?: boolean; // music always starts at 0 — only its end can move
};
export type TrackPatch = { start?: number; duration?: number; volume?: number };
const laneOf = (t: TrackItemType) => (t === "image" || t === "video" ? "overlay" : "audio");
const ITEM_STYLE: Record<TrackItemType, { cls: string; icon: typeof Music }> = {
  image: { cls: "bg-sky-500/25 ring-sky-400/50 text-sky-100", icon: ImageIcon },
  video: { cls: "bg-pink-500/25 ring-pink-400/50 text-pink-100", icon: Film },
  sound: { cls: "bg-emerald-500/25 ring-emerald-400/50 text-emerald-100", icon: AudioLines },
  music: { cls: "bg-amber-500/25 ring-amber-400/50 text-amber-100", icon: Music },
};
const MIN_ITEM = 0.2;

const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 5;
const TOUCH_HOLD_MS = 320;
const MAX_ZOOM = 40;

type TrimDrag = {
  kind: "trim";
  edge: "start" | "end";
  clipId: string;
  startX: number;
  pxPerSec: number;
  snapshot: Clip[];       // layout frozen at drag start
  scaleDur: number;
  origStart: number; origEnd: number; origTimelineStart: number;
  newStart: number; newEnd: number;
  snapPoints: number[];   // timeline times (snapshot coords)
  snapped: boolean;
};
type BodyDrag = {
  kind: "body";
  clipId: string;
  startX: number;
  startScroll: number;
  pointerType: string;
  downAt: number;
  mode: "pending" | "reorder" | "pan";
  dx: number;
  targetIndex: number;
};
type SeekDrag = { kind: "seek" };
type ItemDrag = {
  kind: "item";
  id: string;
  mode: "move" | "start" | "end";
  startX: number;
  pxPerSec: number;
  origStart: number; origDur: number;
  snapPoints: number[];
  moved: boolean;
};
type Drag = TrimDrag | BodyDrag | SeekDrag | ItemDrag;

// ─── Filmstrip: sample frames from the source on a hidden <video> ──────────────
function useFilmstrip(src: string | undefined, sourceDuration: number) {
  const [frames, setFrames] = useState<{ key: string; step: number; urls: (string | undefined)[] }>({ key: "", step: 1, urls: [] });
  const key = `${src}|${sourceDuration}`;
  useEffect(() => {
    if (!src || !(sourceDuration > 0)) return;
    let cancelled = false;
    const count = Math.max(8, Math.min(60, Math.ceil(sourceDuration / 1.5)));
    const step = sourceDuration / count;
    const urls: (string | undefined)[] = new Array(count).fill(undefined);

    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.playsInline = true;
    if (/^https?:/.test(src) && !src.startsWith(location.origin)) v.crossOrigin = "anonymous";
    v.src = src;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const seek = (t: number) => new Promise<void>((resolve, reject) => {
      const done = () => { v.removeEventListener("seeked", done); v.removeEventListener("error", fail); resolve(); };
      const fail = () => { v.removeEventListener("seeked", done); v.removeEventListener("error", fail); reject(new Error("seek")); };
      v.addEventListener("seeked", done); v.addEventListener("error", fail);
      v.currentTime = t;
    });

    (async () => {
      try {
        await new Promise<void>((res, rej) => {
          if (v.readyState >= 1) return res();
          v.addEventListener("loadedmetadata", () => res(), { once: true });
          v.addEventListener("error", () => rej(new Error("load")), { once: true });
        });
        const h = 54, w = Math.round(h * (v.videoWidth / Math.max(1, v.videoHeight)) || 96);
        canvas.width = w; canvas.height = h;
        // Coarse-to-fine order so the whole strip fills in quickly, then sharpens.
        const order: number[] = [];
        for (let stride = 8; stride >= 1; stride = Math.floor(stride / 2)) {
          for (let i = 0; i < count; i += stride) if (!order.includes(i)) order.push(i);
          if (stride === 1) break;
        }
        for (const i of order) {
          if (cancelled) return;
          await seek(Math.min(sourceDuration - 0.05, (i + 0.5) * step));
          ctx?.drawImage(v, 0, 0, w, h);
          urls[i] = canvas.toDataURL("image/jpeg", 0.6); // throws if the source is cross-origin tainted
          if (!cancelled) setFrames({ key: `${src}|${sourceDuration}`, step, urls: [...urls] });
        }
      } catch { /* no thumbnails (CORS / codec) — the plain blocks still work */ }
    })();
    return () => { cancelled = true; v.removeAttribute("src"); v.load(); };
  }, [src, sourceDuration]);
  // Frames from a previous source are stale until the new strip starts filling.
  return frames.key === key ? frames : { step: 1, urls: [] as (string | undefined)[] };
}

export function ClipTimeline({
  clips, currentTime, onSeek, onTrimEdge, onTrimDragStart, onReorder, onDelete, onSplit, onTrimToPlayhead,
  markers = [], videoSrc, sourceDuration,
  onClipVolume, tracks = [], onTrackChange, onTrackChangeStart, onTrackDelete, onAddMedia,
}: {
  onClipVolume: (clipId: string, volume: number) => void;
  tracks?: TrackItem[];
  onTrackChange: (id: string, patch: TrackPatch) => void;
  onTrackChangeStart?: () => void;
  onTrackDelete: (id: string) => void;
  // No file = open a picker; with a file (dropped on a track) = add it at `at`.
  onAddMedia: (type: TrackItemType, file?: File, at?: number) => void;
  clips: Clip[];
  currentTime: number; // timeline time
  onSeek: (t: number) => void;
  onTrimEdge: (clipId: string, edge: "start" | "end", newSourceTime: number) => void;
  // Fired once when a trim-edge drag begins — parent pushes one undo snapshot per gesture.
  onTrimDragStart?: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDelete: (clipId: string) => void;
  onSplit: () => void;
  onTrimToPlayhead: (edge: "start" | "end") => void;
  markers?: { id: string; time: number }[];
  videoSrc?: string;
  sourceDuration: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null); // render mirror of dragRef
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [viewW, setViewW] = useState(0);
  const zoomAnchor = useRef<{ t: number; offsetX: number } | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const onSeekRef = useRef(onSeek);
  useLayoutEffect(() => { onSeekRef.current = onSeek; });
  const [selItem, setSelItem] = useState<string | null>(null);
  const [volOpen, setVolOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dropLane, setDropLane] = useState<"overlay" | "audio" | null>(null);
  const item = tracks.find((t) => t.id === selItem) ?? null;

  const liveDur = Math.max(totalDuration(clips), 0.001);
  const trim = drag?.kind === "trim" ? drag : null;
  const layout = trim ? trim.snapshot : clips;
  const scaleDur = trim ? trim.scaleDur : liveDur;
  const innerW = Math.max(1, viewW * zoom);
  const pxPerSec = innerW / scaleDur;
  const pct = (t: number) => `${(t / scaleDur) * 100}%`;
  const film = useFilmstrip(videoSrc, sourceDuration);

  const owner = clips.find((c, i) =>
    currentTime >= c.timelineStart && (i === clips.length - 1 ? currentTime <= c.timelineStart + c.duration : currentTime < c.timelineStart + c.duration));

  // Track the visible width.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Content width (minus padding) so pxPerSec matches the drawn track exactly.
    const measure = () => {
      const cs = getComputedStyle(el);
      setViewW(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // Keep the time under the cursor fixed while zooming.
  useLayoutEffect(() => {
    const a = zoomAnchor.current, el = scrollRef.current;
    if (!a || !el) return;
    el.scrollLeft = a.t * pxPerSec - a.offsetX;
    zoomAnchor.current = null;
  }, [zoom, pxPerSec]);

  const zoomTo = useCallback((next: number, anchorClientX?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const z = Math.max(1, Math.min(MAX_ZOOM, next));
    const rect = el.getBoundingClientRect();
    const offsetX = anchorClientX != null ? anchorClientX - rect.left : Math.min(el.clientWidth, Math.max(0, currentTime * pxPerSec - el.scrollLeft));
    zoomAnchor.current = { t: (el.scrollLeft + offsetX) / pxPerSec, offsetX };
    setZoom(z);
  }, [currentTime, pxPerSec]);

  // Ctrl/⌘ + wheel zooms; plain vertical wheel scrolls horizontally when zoomed.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(zoom * Math.exp(-e.deltaY * 0.0025), e.clientX);
      } else if (zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX) && el) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo]);

  // Follow the playhead when it leaves the visible window (playback / seeking).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom <= 1 || dragRef.current) return;
    const x = currentTime * pxPerSec;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 12) el.scrollLeft = x - el.clientWidth * 0.15;
  }, [currentTime, pxPerSec, zoom]);

  // A trim preview-seek has to run after the parent re-rendered with the new
  // clips, or its seekTo would map through the stale layout.
  useEffect(() => {
    if (pendingSeek.current == null) return;
    const t = pendingSeek.current;
    pendingSeek.current = null;
    onSeekRef.current(t);
  });

  const clientToTime = useCallback((clientX: number) => {
    const el = innerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(scaleDur, ((clientX - rect.left) / rect.width) * scaleDur));
  }, [scaleDur]);

  // ── Global pointer handling for every gesture ──
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "seek") { e.preventDefault(); onSeek(Math.min(liveDur, clientToTime(e.clientX))); return; }

      if (d.kind === "trim") {
        e.preventDefault();
        const delta = (e.clientX - d.startX) / d.pxPerSec;
        const origEdgeT = d.edge === "start" ? d.origTimelineStart : d.origTimelineStart + (d.origEnd - d.origStart);
        let edgeT = origEdgeT + delta;
        let snapped = false;
        if (snap && !e.altKey) {
          const thr = SNAP_PX / d.pxPerSec;
          let best = thr;
          for (const p of d.snapPoints) {
            const dist = Math.abs(p - edgeT);
            if (dist < best) { best = dist; edgeT = p; snapped = true; }
          }
        }
        let { newStart, newEnd } = d;
        if (d.edge === "start") {
          newStart = Math.max(0, Math.min(d.origEnd - MIN_CLIP_DURATION, d.origStart + (edgeT - d.origTimelineStart)));
          onTrimEdge(d.clipId, "start", newStart);
          pendingSeek.current = d.origTimelineStart; // first frame of the trimmed clip
        } else {
          newEnd = Math.min(sourceDuration, Math.max(d.origStart + MIN_CLIP_DURATION, d.origStart + (edgeT - d.origTimelineStart)));
          onTrimEdge(d.clipId, "end", newEnd);
          pendingSeek.current = d.origTimelineStart + (newEnd - d.origStart) - 0.04; // last frame kept
        }
        const next = { ...d, newStart, newEnd, snapped };
        dragRef.current = next; setDrag(next);
        return;
      }

      if (d.kind === "item") {
        const dxPx = e.clientX - d.startX;
        if (!d.moved && Math.abs(dxPx) < DRAG_THRESHOLD_PX) return;
        e.preventDefault();
        if (!d.moved) { d.moved = true; onTrackChangeStart?.(); }
        const delta = dxPx / d.pxPerSec;
        const thr = SNAP_PX / d.pxPerSec;
        const snapT = (t: number) => {
          if (!snap || e.altKey) return t;
          let best = thr, out = t;
          for (const p of d.snapPoints) { const dist = Math.abs(p - t); if (dist < best) { best = dist; out = p; } }
          return out;
        };
        const end0 = d.origStart + d.origDur;
        if (d.mode === "move") {
          if (tracks.find((t) => t.id === d.id)?.fixedStart) return;
          let s = d.origStart + delta;
          // Snap whichever edge is nearer a snap point.
          const cS = snapT(s) - s, cE = snapT(s + d.origDur) - (s + d.origDur);
          s += cS !== 0 && (cE === 0 || Math.abs(cS) <= Math.abs(cE)) ? cS : cE;
          s = Math.max(0, Math.min(liveDur - MIN_ITEM, s));
          onTrackChange(d.id, { start: Number(s.toFixed(2)) });
        } else if (d.mode === "end") {
          const e2 = Math.max(d.origStart + MIN_ITEM, Math.min(liveDur, snapT(end0 + delta)));
          onTrackChange(d.id, { duration: Number((e2 - d.origStart).toFixed(2)) });
        } else {
          const s = Math.max(0, Math.min(end0 - MIN_ITEM, snapT(d.origStart + delta)));
          onTrackChange(d.id, { start: Number(s.toFixed(2)), duration: Number((end0 - s).toFixed(2)) });
        }
        return;
      }

      // Body drag: decide between click / reorder / pan once it moves.
      const dx = e.clientX - d.startX;
      if (d.mode === "pending") {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        const held = e.timeStamp - d.downAt >= TOUCH_HOLD_MS;
        d.mode = d.pointerType === "mouse" || held ? (clips.length > 1 ? "reorder" : "pan") : "pan";
      }
      e.preventDefault();
      if (d.mode === "pan") {
        if (scrollRef.current) scrollRef.current.scrollLeft = d.startScroll - dx;
        return;
      }
      // Reorder: target index = how many other clips' midpoints the dragged
      // clip's (moved) centre has passed.
      const moving = clips.find((c) => c.id === d.clipId);
      if (!moving) return;
      const center = moving.timelineStart + moving.duration / 2 + dx / pxPerSec;
      const others = clips.filter((c) => c.id !== d.clipId);
      const target = others.filter((c) => c.timelineStart + c.duration / 2 < center).length;
      const next = { ...d, dx, targetIndex: target };
      dragRef.current = next; setDrag(next);
    }

    function onUp(e: PointerEvent) {
      const d = dragRef.current;
      dragRef.current = null; setDrag(null);
      if (d?.kind === "item" && !d.moved && e.type === "pointerup") {
        // Plain click on an item: select it and jump to its start.
        setSelItem(d.id); setVolOpen(false);
        onSeek(Math.min(liveDur, d.origStart));
        return;
      }
      if (!d || d.kind !== "body") return;
      setSelItem(null);
      const from = clips.findIndex((c) => c.id === d.clipId);
      if (d.mode === "reorder") {
        if (from !== -1 && d.targetIndex !== from) onReorder(from, d.targetIndex);
      } else if (d.mode === "pending" && e.type === "pointerup") {
        onSeek(Math.min(liveDur, clientToTime(e.clientX))); // a plain click selects + seeks
      }
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [clips, liveDur, snap, sourceDuration, pxPerSec, clientToTime, onSeek, onTrimEdge, onReorder, onTrackChange, onTrackChangeStart, tracks]);

  // Close the volume / add popovers on any press outside the toolbar.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!volOpen && !addOpen) return;
    const close = (e: PointerEvent) => {
      if (toolbarRef.current?.contains(e.target as Node)) return;
      setVolOpen(false); setAddOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setVolOpen(false); setAddOpen(false); } };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", esc); };
  }, [volOpen, addOpen]);

  function startItem(e: React.PointerEvent, it: TrackItem, mode: ItemDrag["mode"]) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const pts = new Set<number>([currentTime, 0, liveDur]);
    for (const c of clips) { pts.add(c.timelineStart); pts.add(c.timelineStart + c.duration); }
    for (const o of tracks) if (o.id !== it.id) { pts.add(o.start); pts.add(o.start + o.duration); }
    const d: ItemDrag = {
      kind: "item", id: it.id, mode, startX: e.clientX, pxPerSec,
      origStart: it.start, origDur: it.duration, snapPoints: [...pts], moved: false,
    };
    dragRef.current = d; setDrag(d);
  }

  function onLaneDrop(e: React.DragEvent, lane: "overlay" | "audio") {
    e.preventDefault(); setDropLane(null);
    const at = Math.max(0, Math.min(liveDur - MIN_ITEM, clientToTime(e.clientX)));
    for (const f of Array.from(e.dataTransfer.files)) {
      const type: TrackItemType | null = f.type.startsWith("image/") ? "image"
        : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "sound" : null;
      if (type && laneOf(type) === lane) onAddMedia(type, f, Number(at.toFixed(2)));
    }
  }

  function startTrim(e: React.PointerEvent, c: Clip, edge: "start" | "end") {
    e.preventDefault(); e.stopPropagation();
    onTrimDragStart?.();
    const pts = new Set<number>([currentTime, 0, liveDur]);
    for (const o of clips) { pts.add(o.timelineStart); pts.add(o.timelineStart + o.duration); }
    pts.delete(edge === "start" ? c.timelineStart : c.timelineStart + c.duration);
    const d: TrimDrag = {
      kind: "trim", edge, clipId: c.id, startX: e.clientX, pxPerSec,
      snapshot: clips, scaleDur: liveDur,
      origStart: c.sourceStart, origEnd: c.sourceEnd, origTimelineStart: c.timelineStart,
      newStart: c.sourceStart, newEnd: c.sourceEnd, snapPoints: [...pts], snapped: false,
    };
    dragRef.current = d; setDrag(d);
  }

  function startBody(e: React.PointerEvent, c: Clip) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const d: BodyDrag = {
      kind: "body", clipId: c.id, startX: e.clientX, startScroll: scrollRef.current?.scrollLeft ?? 0,
      pointerType: e.pointerType, downAt: e.timeStamp, mode: "pending", dx: 0,
      targetIndex: clips.findIndex((x) => x.id === c.id),
    };
    dragRef.current = d; setDrag(d);
  }

  function startSeek(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { kind: "seek" }; setDrag({ kind: "seek" });
    onSeek(Math.min(liveDur, clientToTime(e.clientX)));
  }

  // Ruler ticks adapt to the zoom level.
  const ticks = useMemo(() => {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const stepT = steps.find((s) => s * pxPerSec >= 70) ?? 600;
    const out: number[] = [];
    for (let t = 0; t <= scaleDur + 1e-6; t += stepT) out.push(t);
    return { stepT, out };
  }, [pxPerSec, scaleDur]);

  const tileW = 40 * (16 / 9);
  const reorder = drag?.kind === "body" && drag.mode === "reorder" ? drag : null;
  // Where the reordered clip would land (x of the insertion line).
  const insertX = reorder ? (() => {
    const others = clips.filter((c) => c.id !== reorder.clipId);
    if (reorder.targetIndex >= others.length) return liveDur;
    let t = 0;
    for (let i = 0; i < reorder.targetIndex; i++) t += others[i].duration;
    return t;
  })() : null;

  const trimmedClip = trim ? clips.find((c) => c.id === trim.clipId) : null;

  return (
    <div className="flex flex-col h-full select-none">
      {/* Toolbar */}
      <div ref={toolbarRef} className="relative flex items-center gap-1 px-3 sm:px-4 h-8 flex-shrink-0 border-b border-white/[0.04]">
        <span className="text-[11px] font-mono text-white/35 tabular-nums truncate min-w-0">
          {item
            ? <><span className="text-white/70">{item.name}</span> · {formatTimecode(item.start)}–{formatTimecode(item.start + item.duration)}</>
            : owner
              ? <>Segment <span className="text-violet-300/80">{clips.indexOf(owner) + 1}</span>/{clips.length} · {formatTimecode(owner.duration)}
                  {clipVolume(owner) !== 100 && <span className="text-violet-300/70"> · {clipVolume(owner)}%</span>}</>
              : `${clips.length} segment${clips.length === 1 ? "" : "s"}`}
          {!item && <span className="hidden sm:inline text-white/20"> · total {formatTimecode(liveDur)}</span>}
        </span>
        <div className="flex-1" />
        {item ? (
          <>
            {item.volume != null && (
              <ToolBtn label="Volume" onClick={() => setVolOpen((v) => !v)} active={volOpen}>
                {item.volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </ToolBtn>
            )}
            <ToolBtn label="Delete from timeline" onClick={() => { onTrackDelete(item.id); setSelItem(null); setVolOpen(false); }} danger><Trash2 size={13} /></ToolBtn>
            <button type="button" onClick={() => { setSelItem(null); setVolOpen(false); }}
              className="h-6 px-2 rounded-md text-[11px] text-white/45 hover:text-white hover:bg-white/[0.07]">Done</button>
          </>
        ) : (
          <>
            <ToolBtn label="Trim start to playhead (Q)" onClick={() => onTrimToPlayhead("start")} disabled={!owner}><ArrowLeftToLine size={13} /></ToolBtn>
            <ToolBtn label="Split at playhead (S)" onClick={onSplit} disabled={!owner} className="sm:hidden"><Scissors size={13} /></ToolBtn>
            <ToolBtn label="Trim end to playhead (W)" onClick={() => onTrimToPlayhead("end")} disabled={!owner}><ArrowRightToLine size={13} /></ToolBtn>
            <ToolBtn label="Segment volume" onClick={() => setVolOpen((v) => !v)} disabled={!owner} active={volOpen}>
              {owner && clipVolume(owner) === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </ToolBtn>
            <ToolBtn label="Delete segment (Del)" onClick={() => owner && onDelete(owner.id)} disabled={!owner || clips.length < 2} danger><Trash2 size={13} /></ToolBtn>
          </>
        )}
        <div className="w-px h-4 bg-white/[0.08] mx-1" />
        <ToolBtn label="Add audio, music, footage or an image" onClick={() => { setVolOpen(false); setAddOpen((v) => !v); }} active={addOpen}><Plus size={14} /></ToolBtn>

        {/* Volume popover — the selected track item, else the segment under the playhead */}
        {volOpen && (item ? item.volume != null : !!owner) && (() => {
          const value = item ? item.volume ?? 100 : clipVolume(owner);
          const max = item ? (item.type === "music" ? 100 : 200) : 200;
          const set = (v: number) => (item ? onTrackChange(item.id, { volume: v }) : onClipVolume(owner!.id, v));
          const begin = () => (item ? onTrackChangeStart?.() : onTrimDragStart?.());
          return (
            <div className="absolute right-3 top-9 z-[60] w-56 rounded-xl border border-white/[0.1] bg-d14 shadow-2xl p-3 space-y-2.5"
              onPointerDown={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-white/60">{item ? `${item.name} volume` : `Segment ${clips.indexOf(owner!) + 1} volume`}</span>
                <span className="text-[11px] font-mono text-violet-300 tabular-nums">{value}%</span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" title={value === 0 ? "Unmute" : "Mute"} onClick={() => { begin(); set(value === 0 ? 100 : 0); }}
                  className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-md bg-white/[0.05] text-white/60 hover:text-white">
                  {value === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <input type="range" min={0} max={max} step={1} value={value} aria-label="Volume"
                  onPointerDown={begin} onChange={(e) => set(Number(e.target.value))}
                  className="flex-1 accent-violet-400 cursor-pointer" />
              </div>
              <div className="flex gap-1">
                {[0, 50, 100, 150, 200].filter((p) => p <= max).map((p) => (
                  <button key={p} type="button" onClick={() => { begin(); set(p); }}
                    className={`flex-1 h-6 rounded-md text-[10px] font-mono ${value === p ? "bg-violet-500/25 text-violet-200" : "bg-white/[0.04] text-white/45 hover:text-white"}`}>
                    {p}
                  </button>
                ))}
              </div>
              {!item && <p className="text-[10px] text-white/25 leading-snug">Only this segment. Above 100% boosts on export (the preview tops out at 100%).</p>}
            </div>
          );
        })()}

        {/* Add menu */}
        {addOpen && (
          <div className="absolute right-3 top-9 z-[60] w-48 rounded-xl border border-white/[0.1] bg-d14 shadow-2xl p-1"
            onPointerDown={(e) => e.stopPropagation()}>
            {([
              ["sound", AudioLines, "Audio / sound effect"],
              ["music", Music, "Background music"],
              ["video", Film, "Footage overlay"],
              ["image", ImageIcon, "Image overlay"],
            ] as const).map(([type, Icon, label]) => (
              <button key={type} type="button" onClick={() => { setAddOpen(false); onAddMedia(type); }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12px] text-white/70 hover:text-white hover:bg-white/[0.06]">
                <Icon size={13} className="text-white/40" /> {label}
              </button>
            ))}
            <p className="px-2.5 pt-1 pb-1.5 text-[10px] text-white/25 leading-snug">Or drop files straight onto a track.</p>
          </div>
        )}
        <ToolBtn label={snap ? "Snapping on (hold Alt to bypass)" : "Snapping off"} onClick={() => setSnap((s) => !s)} active={snap}><Magnet size={13} /></ToolBtn>
        <ToolBtn label="Zoom out (Ctrl + wheel)" onClick={() => zoomTo(zoom / 1.6)} disabled={zoom <= 1}><ZoomOut size={13} /></ToolBtn>
        <input type="range" min={0} max={Math.log(MAX_ZOOM)} step={0.01} value={Math.log(zoom)}
          onChange={(e) => zoomTo(Math.exp(Number(e.target.value)))} aria-label="Timeline zoom"
          className="hidden md:block w-20 accent-violet-400 h-1 cursor-pointer" />
        <ToolBtn label="Zoom in (Ctrl + wheel)" onClick={() => zoomTo(zoom * 1.6)} disabled={zoom >= MAX_ZOOM}><ZoomIn size={13} /></ToolBtn>
        <ToolBtn label="Fit timeline" onClick={() => setZoom(1)} disabled={zoom <= 1}><Maximize size={13} /></ToolBtn>
      </div>

      {/* Scrollable timeline */}
      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-3 sm:px-4 [scrollbar-width:thin]">
        <div ref={innerRef} className="relative h-full" style={{ width: zoom > 1 ? innerW : "100%" }}>
          {/* Ruler — click or drag to scrub */}
          <div className="relative h-5 cursor-pointer" style={{ touchAction: "none" }} onPointerDown={startSeek}>
            {ticks.out.map((t) => (
              <div key={t} className="absolute top-0 flex flex-col items-start" style={{ left: pct(t) }}>
                <div className="w-px h-1.5 bg-white/[0.18]" />
                <span className="text-[10px] text-white/30 mt-px -translate-x-1/2 font-mono tracking-tight whitespace-nowrap">
                  {ticks.stepT < 1 ? formatTimecode(t) : formatTime(t)}
                </span>
              </div>
            ))}
          </div>

          {/* Video track */}
          <div className="absolute left-0 right-0 top-6 bottom-[58px]" style={{ touchAction: "none" }}>
            <div className="absolute inset-0 rounded-md bg-white/[0.03] cursor-pointer" onPointerDown={startSeek} />

            {layout.map((c, i) => {
              const isTrim = trim?.clipId === c.id;
              const isMoving = reorder?.clipId === c.id;
              const selected = !trim && !reorder && owner?.id === c.id;
              // While trimming, show the kept range (the handle follows the cursor)
              // over a ghost of the original; ripple happens on release.
              const keptL = isTrim && trim!.edge === "start" ? (trim!.newStart - trim!.origStart) : 0;
              const keptR = isTrim && trim!.edge === "end" ? (trim!.newEnd - trim!.origEnd) : 0;
              const left = c.timelineStart + keptL;
              const dur = c.duration - keptL + keptR;
              const tiles = Math.max(1, Math.ceil((dur * pxPerSec) / tileW));
              return (
                <div key={c.id}
                  className={`absolute inset-y-0 rounded-md overflow-hidden group transition-shadow
                    ${isMoving ? "z-40 opacity-90 shadow-[0_8px_24px_rgba(0,0,0,0.6)] ring-2 ring-white/70 cursor-grabbing" : "cursor-grab"}
                    ${selected ? "ring-2 ring-violet-300/90 z-10" : "ring-1 ring-violet-500/40"}
                    ${isTrim ? "z-30 ring-2 ring-amber-300/90" : ""}`}
                  style={{
                    left: pct(left), width: `calc(${pct(Math.max(dur, 0))} - 2px)`,
                    transform: isMoving ? `translateX(${reorder!.dx}px) translateY(-3px)` : undefined,
                    transition: drag ? "none" : "left 160ms ease, width 160ms ease",
                  }}
                  onPointerDown={(e) => startBody(e, c)}
                >
                  {/* Filmstrip */}
                  <div className="absolute inset-0 flex bg-violet-950/60">
                    {Array.from({ length: tiles }, (_, k) => {
                      const srcT = c.sourceStart + keptL + ((k + 0.5) * tileW) / pxPerSec;
                      const url = film.urls[Math.min(film.urls.length - 1, Math.floor(srcT / film.step))];
                      return (
                        <div key={k} className="h-full flex-shrink-0 bg-cover bg-center border-r border-black/30"
                          style={{ width: tileW, backgroundImage: url ? `url(${url})` : undefined }} />
                      );
                    })}
                  </div>
                  <div className={`absolute inset-0 ${selected ? "bg-violet-500/10" : "bg-gradient-to-b from-violet-600/30 to-black/40"}`} />

                  {/* Label */}
                  <div className="absolute top-0.5 left-3 text-[10px] font-mono font-semibold text-white/85 pointer-events-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] whitespace-nowrap">
                    {i + 1} · {formatTimecode(dur)}
                    {clipVolume(c) !== 100 && (
                      <span className={`ml-1 px-1 rounded ${clipVolume(c) === 0 ? "bg-red-500/70" : "bg-black/60"}`}>
                        {clipVolume(c) === 0 ? "muted" : `${clipVolume(c)}%`}
                      </span>
                    )}
                  </div>

                  {/* Trim handles */}
                  {(["start", "end"] as const).map((edge) => (
                    <div key={edge}
                      className={`absolute inset-y-0 z-10 w-3 flex items-center justify-center cursor-ew-resize
                        ${isTrim && trim!.edge === edge ? "bg-amber-300" : "bg-violet-400/80 group-hover:bg-violet-300"} hover:bg-white
                        ${edge === "start" ? "left-0 rounded-l-md" : "right-0 rounded-r-md"}`}
                      style={{ touchAction: "none" }}
                      title={edge === "start" ? "Drag to trim start" : "Drag to trim end"}
                      onPointerDown={(e) => startTrim(e, c, edge)}
                    >
                      <div className="w-0.5 h-3 rounded-full bg-black/50" />
                    </div>
                  ))}
                </div>
              );
            })}

            {/* Cut-away ghost of the original range while trimming */}
            {trim && (() => {
              const c = trim.snapshot.find((x) => x.id === trim.clipId)!;
              return (
                <div className="absolute inset-y-0 z-20 rounded-md border border-dashed border-white/25 pointer-events-none
                  bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.06)_0_4px,transparent_4px_8px)]"
                  style={{ left: pct(c.timelineStart), width: pct(c.duration) }} />
              );
            })()}

            {/* Trim readout */}
            {trim && trimmedClip && (() => {
              const edgeT = trim.edge === "start"
                ? trim.origTimelineStart + (trim.newStart - trim.origStart)
                : trim.origTimelineStart + (trim.newEnd - trim.origStart);
              const deltaS = trim.edge === "start" ? -(trim.newStart - trim.origStart) : trim.newEnd - trim.origEnd;
              return (
                <>
                  {trim.snapped && <div className="absolute -inset-y-1 z-40 w-px bg-amber-300 pointer-events-none" style={{ left: pct(edgeT) }} />}
                  <div className="absolute -top-6 z-50 -translate-x-1/2 px-1.5 py-0.5 rounded-md bg-black/90 border border-amber-300/40
                    text-[10px] font-mono text-amber-200 whitespace-nowrap pointer-events-none tabular-nums"
                    style={{ left: pct(edgeT) }}>
                    {formatTimecode(trimmedClip.duration)} <span className="text-white/45">({deltaS >= 0 ? "+" : "−"}{Math.abs(deltaS).toFixed(1)}s)</span>
                  </div>
                </>
              );
            })()}

            {/* Reorder insertion line */}
            {insertX != null && (
              <div className="absolute -inset-y-1 z-50 w-0.5 bg-white rounded-full shadow-[0_0_8px_rgba(255,255,255,0.8)] pointer-events-none"
                style={{ left: pct(insertX), transform: "translateX(-50%)" }} />
            )}

            {/* Crop/zoom keyframe markers */}
            {!trim && markers.map((m) => (
              <button key={m.id} type="button"
                title={`Keyframe @ ${formatTimecode(m.time)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onSeek(Math.max(0, Math.min(liveDur, m.time))); }}
                className="absolute z-30 -bottom-1 w-2 h-2 bg-violet-400 border border-violet-200/70 hover:bg-white shadow-[0_0_6px_rgba(51,92,186,0.7)]"
                style={{ left: pct(m.time), transform: "translateX(-50%) rotate(45deg)" }} />
            ))}
          </div>

          {/* Overlay + audio tracks */}
          {(["overlay", "audio"] as const).map((lane) => {
            const items = tracks.filter((t) => laneOf(t.type) === lane);
            return (
              <div key={lane}
                className={`absolute left-0 right-0 h-[22px] rounded-md transition-colors
                  ${dropLane === lane ? "bg-violet-500/20 ring-1 ring-violet-400/60" : "bg-white/[0.025]"}`}
                style={{ bottom: lane === "overlay" ? 31 : 5, touchAction: "none" }}
                onPointerDown={startSeek}
                onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropLane(lane); } }}
                onDragLeave={() => setDropLane((l) => (l === lane ? null : l))}
                onDrop={(e) => onLaneDrop(e, lane)}
              >
                {items.length === 0 && (
                  <button type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onAddMedia(lane === "overlay" ? "video" : "sound")}
                    className="absolute left-1.5 inset-y-0 flex items-center gap-1 text-[10px] text-white/25 hover:text-violet-300">
                    <Plus size={10} /> {lane === "overlay" ? "Footage / image overlay" : "Audio"} <span className="hidden sm:inline">— or drop a file here</span>
                  </button>
                )}
                {items.map((it) => {
                  const S = ITEM_STYLE[it.type];
                  const Icon = S.icon;
                  const sel = selItem === it.id;
                  const muted = it.volume === 0;
                  return (
                    <div key={it.id}
                      className={`absolute inset-y-0 rounded-[5px] ring-1 overflow-hidden flex items-center gap-1 pl-2 pr-2 cursor-grab
                        ${S.cls} ${sel ? "!ring-2 !ring-white z-20" : "z-10"} ${muted ? "opacity-50" : ""}`}
                      style={{ left: pct(it.start), width: `max(6px, calc(${pct(Math.max(it.duration, 0))} - 1px))` }}
                      title={`${it.name} · ${formatTimecode(it.start)}–${formatTimecode(it.start + it.duration)}`}
                      onPointerDown={(e) => startItem(e, it, "move")}
                    >
                      {it.thumb && <div className="absolute inset-0 bg-cover bg-center opacity-35" style={{ backgroundImage: `url(${it.thumb})` }} />}
                      {it.uploading ? <Loader2 size={10} className="relative animate-spin flex-shrink-0" /> : <Icon size={10} className="relative flex-shrink-0" />}
                      <span className="relative text-[10px] font-medium truncate">{it.name}</span>
                      {it.volume != null && it.volume !== 100 && (
                        <span className="relative ml-auto text-[9px] font-mono opacity-70">{muted ? "muted" : `${it.volume}%`}</span>
                      )}
                      {/* Resize handles (music always starts at 0, so only its end moves) */}
                      {!it.fixedStart && (
                        <div className="absolute left-0 inset-y-0 w-2 cursor-ew-resize hover:bg-white/40" style={{ touchAction: "none" }}
                          onPointerDown={(e) => startItem(e, it, "start")} />
                      )}
                      <div className="absolute right-0 inset-y-0 w-2 cursor-ew-resize hover:bg-white/40" style={{ touchAction: "none" }}
                        onPointerDown={(e) => startItem(e, it, "end")} />
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Playhead (hidden while trimming — the video is previewing the edge) */}
          {!trim && (
            <div className="absolute top-0 bottom-0 z-[45] pointer-events-none" style={{ left: pct(Math.min(currentTime, scaleDur)) }}>
              <div className="absolute top-0 -translate-x-1/2 w-3 h-3.5 bg-white rounded-b-sm rounded-t-[1px] pointer-events-auto cursor-ew-resize
                [clip-path:polygon(0_0,100%_0,100%_65%,50%_100%,0_65%)]"
                style={{ touchAction: "none" }}
                onPointerDown={(e) => { e.stopPropagation(); startSeek(e); }} />
              <div className="absolute top-3 bottom-0 w-px -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(255,255,255,0.5)]" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolBtn({ label, onClick, disabled, active, danger, className = "", children }: {
  label: string; onClick: () => void; disabled?: boolean; active?: boolean; danger?: boolean; className?: string; children: React.ReactNode;
}) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className={`w-7 h-6 flex items-center justify-center rounded-md transition-colors disabled:opacity-25 disabled:pointer-events-none
        ${active ? "text-violet-300 bg-violet-500/15" : danger ? "text-red-300/70 hover:text-red-300 hover:bg-red-500/10" : "text-white/45 hover:text-white hover:bg-white/[0.07]"} ${className}`}>
      {children}
    </button>
  );
}
