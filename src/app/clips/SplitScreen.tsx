"use client";
// Split-screen editor: the live preview (one canvas painting every screen —
// from the editor's own <video>, or from a hidden player for screens that show
// their own video), the hidden players themselves, and the side-panel controls
// (layout picker, per-screen source, and a source map where each screen's crop
// box is moved/resized). All framing math comes from lib/clip-filters so the
// preview matches the ffmpeg export exactly.
import { useEffect, useRef, useState } from "react";
import { Move, Upload, Film, Loader2, X, ScanFace } from "lucide-react";
import {
  SPLIT_LAYOUTS, SPLIT_LAYOUT_KEYS, SPLIT_MAX_ZOOM, defaultSplit, splitCropRect, splitSlots, panelSrcDims, fitSplitToFacecam,
  splitResizable, SPLIT_TOP_MIN, SPLIT_TOP_MAX,
  type SplitConfig, type SplitLayoutKey, type SplitPanel, type SplitMedia,
} from "@/lib/clip-filters";
import { DSlider } from "./editor-ui";
import { uploadFile } from "@/lib/upload-client";

// One colour per screen, used for its box on the source map + its tile badge.
export const PANEL_COLORS = ["#8b5cf6", "#ec4899", "#0ea5e9", "#f59e0b"];

// Hidden <video> players for screens with their own video, keyed by media url.
// Owned by the page so the preview and the controls draw from the same element.
export type MediaEls = React.MutableRefObject<Record<string, HTMLVideoElement | null>>;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clampZoom = (z: number) => Math.max(1, Math.min(SPLIT_MAX_ZOOM, z));

// Scroll-wheel resize: wheel up = tighter capture (zoom in). Multiplicative so
// each notch feels the same at 1× and at 5×.
const wheelZoom = (z: number, deltaY: number) => clampZoom(z * Math.exp(-deltaY * 0.0015));

// Where screen i draws from: its own player, or the clip.
type FrameSource = HTMLVideoElement | HTMLImageElement;
function sourceEl(panel: SplitPanel | undefined, clip: FrameSource | null, mediaEls: MediaEls): FrameSource | null {
  return panel?.media ? mediaEls.current[panel.media.url] ?? null : clip;
}

// Grab a few frames spread around the playhead for facecam detection, on a
// hidden copy of the video so the preview doesn't jump. Several frames let
// the server tell the overlay's fixed edges from moving gameplay. Falls back
// to the single frame on screen if the copy can't be read (cross-origin).
async function grabFrames(v: FrameSource): Promise<string[]> {
  const draw = (el: FrameSource) => {
    const fw = frameW(el), fh = frameH(el);
    const W = Math.min(960, fw);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = Math.round(W * (fh / fw));
    cv.getContext("2d")!.drawImage(el, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.8);
  };
  if (v instanceof HTMLVideoElement && (v.currentSrc || v.src) && isFinite(v.duration) && v.duration > 1) {
    const copy = document.createElement("video");
    copy.muted = true; copy.preload = "auto"; copy.playsInline = true;
    if (v.crossOrigin) copy.crossOrigin = v.crossOrigin;
    copy.src = v.currentSrc || v.src;
    try {
      await new Promise<void>((res, rej) => {
        copy.addEventListener("loadeddata", () => res(), { once: true });
        copy.addEventListener("error", () => rej(new Error("load")), { once: true });
        setTimeout(() => rej(new Error("timeout")), 8000);
      });
      const t = v.currentTime, d = v.duration;
      const times = [-3, -1.5, 0, 1.5, 3].map((o) => Math.max(0, Math.min(d - 0.1, t + o)));
      const out: string[] = [];
      for (const tt of [...new Set(times.map((x) => Math.round(x * 10) / 10))]) {
        await new Promise<void>((res, rej) => {
          copy.addEventListener("seeked", () => res(), { once: true });
          setTimeout(() => rej(new Error("seek")), 5000);
          copy.currentTime = tt;
        });
        out.push(draw(copy));
      }
      if (out.length > 0) return out;
    } catch { /* fall through to the frame on screen */ }
    finally { copy.removeAttribute("src"); copy.load(); }
  }
  return [draw(v)];
}

/**
 * Grab frames (or use the remote still), ask the server where the webcam
 * overlay is, and fit screen `slotIndex` of `split` on the whole cam. Used by
 * the "Detect facecam" button and by the AI editor. Never throws.
 */
export async function detectFacecamSplit(o: {
  source: FrameSource | null; frameUrl?: string;
  split: SplitConfig; slotIndex: number; srcW: number; srcH: number; outW: number; outH: number;
}): Promise<{ split: SplitConfig | null; text: string }> {
  const i = o.slotIndex;
  try {
    let body: { images?: string[]; imageUrl?: string } | null = null;
    if (ready(o.source)) {
      try { body = { images: await grabFrames(o.source) }; } catch { /* cross-origin — try the remote still */ }
    }
    if (!body && o.frameUrl) body = { imageUrl: o.frameUrl };
    if (!body) return { split: null, text: "Load the video first, then try again." };
    const res = await fetch("/api/clips/facecam", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { split: null, text: data.error ?? "Detection failed" };
    if (!data.found) {
      return { split: null, text: data.reason === "full_camera"
        ? "The whole frame is the camera here — no separate facecam to split out."
        : "No facecam found in this frame. Try another moment, or place the box by hand." };
    }
    const d = panelSrcDims(o.split.panels[i], o.srcW, o.srcH);
    return {
      split: fitSplitToFacecam(o.split, data.box, i, o.outW, o.outH, d.w, d.h),
      text: `Facecam found — Screen ${i + 1} shows the full cam${data.refined ? ", snapped to its edges" : ""}. Drag or resize to fine-tune.`,
    };
  } catch (err) {
    return { split: null, text: err instanceof Error ? err.message : "Detection failed" };
  }
}

// At least one screen must show the clip (the renderer enforces the same rule:
// the clip drives the length; looping screen videos never end).
const clipScreens = (s: SplitConfig) => s.panels.filter((p) => !p.media).length;

// React's onWheel is passive (can't preventDefault), so the page would scroll
// while resizing — attach a native non-passive listener instead.
function useWheel(ref: React.RefObject<HTMLElement | null>, handler: (e: WheelEvent) => void) {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fn = (e: WheelEvent) => handlerRef.current(e);
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, [ref]);
}

// Run a callback on every animation frame while mounted (latest closure).
// Cheap, and keeps paused/seeked frames current too.
function useFrameLoop(fn: () => void) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  useEffect(() => {
    let raf = 0;
    const tick = () => { fnRef.current(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

// Natural pixel size of a frame source (video frame or still image).
const frameW = (v: FrameSource) => (v instanceof HTMLVideoElement ? v.videoWidth : v.naturalWidth);
const frameH = (v: FrameSource) => (v instanceof HTMLVideoElement ? v.videoHeight : v.naturalHeight);
const ready = (v: FrameSource | null): v is FrameSource =>
  !!v && (v instanceof HTMLVideoElement ? v.readyState >= 2 && v.videoWidth > 0 : v.complete && v.naturalWidth > 0);

// Imperative media control, kept outside React: drive each screen player to
// (its start offset + the clip's playhead), looping, matching play state/speed.
function syncPlayers(els: Record<string, HTMLVideoElement | null>, media: SplitMedia[],
  clip: HTMLVideoElement, now: number, playing: boolean) {
  for (const m of media) {
    const el = els[m.url];
    if (!el || !(el.duration > 0)) continue;
    const target = (m.offset + now) % el.duration;
    if (el.playbackRate !== clip.playbackRate) el.playbackRate = clip.playbackRate;
    if (playing) {
      if (el.paused) el.play().catch(() => {});
      // Wrap-aware drift so the loop point doesn't trigger a seek storm.
      let drift = Math.abs(el.currentTime - target);
      drift = Math.min(drift, el.duration - drift);
      if (drift > 0.3) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
    }
  }
}

// ── Hidden players for screens with their own video ────────────────────────
// Each follows the clip's playhead: timeline time + the screen's start offset,
// looping when shorter — the same timing the export uses.
export function SplitMediaPlayers({ split, mediaEls, clipRef, timelineTime }: {
  split: SplitConfig;
  mediaEls: MediaEls;
  clipRef: React.RefObject<HTMLVideoElement | null>;
  timelineTime: number; // editor playhead, 0-based timeline seconds
}) {
  const media = split.panels.map((p) => p.media).filter((m): m is SplitMedia => !!m);
  // One player per distinct video (two screens can crop the same webcam file).
  const byUrl = new Map(media.map((m) => [m.url, m]));
  const timeRef = useRef(timelineTime);
  useEffect(() => { timeRef.current = timelineTime; });
  // The playhead state only updates a few times a second; extrapolate from the
  // clip element while playing so the drift check doesn't fight real playback.
  const lastRef = useRef({ t: timelineTime, clip: 0 });

  useFrameLoop(() => {
    const clip = clipRef.current;
    if (!clip) return;
    if (timeRef.current !== lastRef.current.t) lastRef.current = { t: timeRef.current, clip: clip.currentTime };
    const playing = !clip.paused && !clip.ended;
    const now = lastRef.current.t + (playing ? Math.max(0, clip.currentTime - lastRef.current.clip) : 0);
    syncPlayers(mediaEls.current, [...byUrl.values()], clip, now, playing);
  });

  return (
    <>
      {[...byUrl.values()].map((m) => (
        // Off-screen rather than display:none so browsers keep decoding frames.
        <video key={m.url} ref={(el) => { mediaEls.current[m.url] = el; }}
          src={m.url} muted playsInline preload="auto" loop
          className="fixed -left-[9999px] top-0 w-px h-px opacity-0 pointer-events-none" aria-hidden="true" />
      ))}
    </>
  );
}

// ── Preview stage ──────────────────────────────────────────────────────────
export function SplitStage({
  videoRef, mediaEls, split, onChange, srcW, srcH, outW, outH, width, height, filter, mirror, onTap,
}: {
  videoRef: React.RefObject<FrameSource | null>;
  mediaEls: MediaEls;
  split: SplitConfig;
  onChange: (s: SplitConfig) => void;
  srcW: number; srcH: number;     // clip size (px)
  outW: number; outH: number;     // export frame size (px) — slot aspect ratios come from this
  width: number; height: number;  // on-screen stage size (CSS px)
  filter: string;                 // CSS filter mirroring the export's look chain
  mirror: boolean;                // the picture wrapper is flipped; invert drag x
  onTap: () => void;              // click without dragging = play/pause
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ i: number; x: number; y: number; start: SplitPanel; tileW: number; tileH: number; crop: { w: number; h: number }; moved: boolean } | null>(null);
  const slots = splitSlots(split);
  const cropOf = (i: number) => {
    const d = panelSrcDims(split.panels[i], srcW, srcH);
    return splitCropRect(split.panels[i], slots[i], outW, outH, d.w, d.h);
  };

  useFrameLoop(() => {
    const cv = canvasRef.current;
    if (!cv || width <= 0 || height <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(width * dpr), H = Math.round(height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    slots.forEach((slot, i) => {
      const v = sourceEl(split.panels[i], videoRef.current, mediaEls);
      if (!ready(v)) return;
      const c = cropOf(i);
      // Crop rect is in source fractions — map onto the decoded frame size,
      // which can differ from the nominal size (e.g. a lower-res preview).
      ctx.drawImage(v, c.x * frameW(v), c.y * frameH(v), c.w * frameW(v), c.h * frameH(v),
        Math.round(slot.x * W), Math.round(slot.y * H), Math.round(slot.w * W), Math.round(slot.h * H));
    });
  });

  // Which screen is under a client point (accounts for the mirrored wrapper).
  function slotAt(clientX: number, clientY: number, r: DOMRect) {
    let fx = (clientX - r.left) / r.width;
    if (mirror) fx = 1 - fx;
    const fy = (clientY - r.top) / r.height;
    return slots.findIndex((s) => fx >= s.x && fx < s.x + s.w && fy >= s.y && fy < s.y + s.h);
  }

  // Scroll over a screen to resize its capture.
  useWheel(canvasRef, (e) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const i = slotAt(e.clientX, e.clientY, cv.getBoundingClientRect());
    if (i < 0) return;
    e.preventDefault();
    onChange({ ...split, panels: split.panels.map((p, j) => (j === i ? { ...p, zoom: wheelZoom(p.zoom, e.deltaY) } : p)) });
  });

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.stopPropagation(); e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const i = slotAt(e.clientX, e.clientY, r);
    if (i < 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      i, x: e.clientX, y: e.clientY, start: split.panels[i],
      tileW: slots[i].w * r.width, tileH: slots[i].h * r.height, crop: cropOf(i), moved: false,
    };
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d) return;
    let dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    if (mirror) dx = -dx;
    // Dragging the picture right reveals what's to its left: move the crop
    // centre against the drag, scaled from tile pixels to source fractions.
    const panels = split.panels.map((p, j) => j !== d.i ? p : {
      ...p,
      cx: clamp01(d.start.cx - (dx / d.tileW) * d.crop.w),
      cy: clamp01(d.start.cy - (dy / d.tileH) * d.crop.h),
    });
    onChange({ ...split, panels });
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (d && !d.moved) onTap();
  }

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing touch-none"
        style={{ filter }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {/* Thin seams + numbered badges so each screen is identifiable while editing.
          Preview-only: the export has no seams. */}
      {slots.map((s, i) => (
        <div key={i} className="absolute pointer-events-none border border-white/15"
          style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` }}>
          <span className="absolute top-1 left-1 w-4 h-4 rounded-full text-[11px] font-bold text-white flex items-center justify-center opacity-80"
            style={{ background: PANEL_COLORS[i], transform: mirror ? "scaleX(-1)" : undefined }}>
            {i + 1}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Side-panel controls ────────────────────────────────────────────────────
function LayoutGlyph({ layout, active }: { layout: SplitLayoutKey; active: boolean }) {
  return (
    <svg viewBox="0 0 18 32" className="w-[18px] h-8" aria-hidden="true">
      {splitSlots(layout).map((s, i) => (
        <rect key={i} x={s.x * 18 + 0.75} y={s.y * 32 + 0.75} width={s.w * 18 - 1.5} height={s.h * 32 - 1.5} rx={1.2}
          fill={active ? PANEL_COLORS[i] : "rgba(255,255,255,0.18)"} fillOpacity={active ? 0.75 : 1} />
      ))}
    </svg>
  );
}

// Read a local video file's size + length before uploading it.
function probeVideo(file: File): Promise<{ w: number; h: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.src = url;
    v.onloadedmetadata = () => {
      const out = { w: v.videoWidth, h: v.videoHeight, duration: isFinite(v.duration) ? v.duration : 0 };
      URL.revokeObjectURL(url);
      if (!out.w || !out.h) reject(new Error("That file has no video picture.")); else resolve(out);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that video — try MP4 or WebM.")); };
  });
}

export function SplitControls({
  videoRef, mediaEls, split, onChange, srcW, srcH, outW, outH, allowMedia = true, frameUrl,
}: {
  videoRef: React.RefObject<FrameSource | null>;
  mediaEls: MediaEls;
  split: SplitConfig;
  onChange: (s: SplitConfig) => void;
  srcW: number; srcH: number; outW: number; outH: number;
  allowMedia?: boolean;   // offer "another video" per screen (editor yes, Auto-Pilot no)
  frameUrl?: string;      // remote still to analyse instead of grabbing the frame (cross-origin thumbnails)
}) {
  const [selected, setSelected] = useState(0);
  const [uploading, setUploading] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLCanvasElement>(null);
  // move: drag the box body. resize: drag a corner — the opposite corner (ax,ay,
  // in source fractions) stays pinned and the box scales, aspect-locked.
  type Drag =
    | { mode: "move"; i: number; x: number; y: number; start: SplitPanel; w: number; h: number }
    | { mode: "resize"; i: number; ax: number; ay: number; sx: number; sy: number };
  const dragRef = useRef<Drag | null>(null);
  const slots = splitSlots(split);
  const sel = Math.min(selected, slots.length - 1);
  const selPanel = split.panels[sel];

  // The source map shows the SELECTED screen's source (the clip, or that
  // screen's own video) with the boxes of every screen sharing that source.
  const mapKey = selPanel.media?.url ?? "clip";
  const keyOf = (p: SplitPanel) => p.media?.url ?? "clip";
  const mapDims = panelSrcDims(selPanel, srcW, srcH);
  const cropOf = (i: number) => {
    const d = panelSrcDims(split.panels[i], srcW, srcH);
    return splitCropRect(split.panels[i], slots[i], outW, outH, d.w, d.h);
  };

  // Scroll over a box (or anywhere on the map, for the selected screen) to resize it.
  useWheel(mapRef, (e) => {
    e.preventDefault();
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-panel]");
    const i = hit ? Number(hit.dataset.panel) : sel;
    setSelected(i);
    setPanel(i, { zoom: wheelZoom(split.panels[i].zoom, e.deltaY) });
  });

  // Live thumbnail of the selected source behind the crop boxes.
  useFrameLoop(() => {
    const cv = thumbRef.current;
    const v = sourceEl(selPanel, videoRef.current, mediaEls);
    if (!cv || !ready(v)) return;
    const W = 320, H = Math.round(320 * (mapDims.h / mapDims.w));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cv.getContext("2d")?.drawImage(v, 0, 0, W, H);
  });

  function setPanel(i: number, patch: Partial<SplitPanel>) {
    onChange({ ...split, panels: split.panels.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  }

  async function detectFacecam() {
    const i = sel;
    setDetecting(true); setDetectMsg(null);
    const r = await detectFacecamSplit({
      source: sourceEl(split.panels[i], videoRef.current, mediaEls), frameUrl,
      split, slotIndex: i, srcW, srcH, outW, outH,
    });
    if (r.split) onChange(r.split);
    setDetectMsg({ ok: !!r.split, text: r.text });
    setDetecting(false);
  }

  function pickLayout(layout: SplitLayoutKey) {
    if (layout === split.layout) return;
    setSelected(0);
    // Keep each screen's own video when switching layouts (fresh framing),
    // as long as at least one screen still shows the clip.
    const next = defaultSplit(layout);
    next.panels = next.panels.map((p, i) => {
      const media = split.panels[i]?.media;
      return media ? { cx: 0.5, cy: 0.5, zoom: 1, media } : p;
    });
    if (clipScreens(next) === 0) next.panels[0] = { ...SPLIT_LAYOUTS[layout].defaults[0] };
    onChange(next);
  }

  async function onPickFile(file: File) {
    const i = sel;
    setUploadError(""); setUploading(i);
    try {
      const dims = await probeVideo(file);
      const url = await uploadFile(file, "upload");
      // A fresh video starts fully framed; the user then crops it like the clip.
      setPanel(i, {
        cx: 0.5, cy: 0.5, zoom: 1,
        media: { url, name: file.name, w: dims.w, h: dims.h, duration: dims.duration, offset: 0 },
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  }

  function onBoxDown(e: React.PointerEvent, i: number) {
    e.preventDefault(); e.stopPropagation();
    setSelected(i);
    const r = mapRef.current?.getBoundingClientRect();
    if (!r) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode: "move", i, x: e.clientX, y: e.clientY, start: split.panels[i], w: r.width, h: r.height };
  }

  // corner: sx/sy = which way the dragged corner points (-1 = left/top, +1 = right/bottom).
  function onHandleDown(e: React.PointerEvent, i: number, sx: number, sy: number) {
    e.preventDefault(); e.stopPropagation();
    setSelected(i);
    const c = cropOf(i);
    // Pin the opposite corner of the box as it currently sits (post-clamp).
    const ax = sx > 0 ? c.x : c.x + c.w;
    const ay = sy > 0 ? c.y : c.y + c.h;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode: "resize", i, ax, ay, sx, sy };
  }

  function onBoxMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "move") {
      // Boxes move WITH the pointer here (we're dragging the window over the source).
      setPanel(d.i, {
        cx: clamp01(d.start.cx + (e.clientX - d.x) / d.w),
        cy: clamp01(d.start.cy + (e.clientY - d.y) / d.h),
      });
      return;
    }
    const r = mapRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    // Full-size (zoom 1) capture for this screen; its w/h ratio (in source
    // fractions) is the aspect lock. Size follows whichever axis the pointer
    // pulled further, so diagonal drags feel natural.
    const dims = panelSrcDims(split.panels[d.i], srcW, srcH);
    const base = splitCropRect({ cx: 0.5, cy: 0.5, zoom: 1 }, slots[d.i], outW, outH, dims.w, dims.h);
    const lock = base.w / base.h;
    const wantW = Math.max(Math.abs(px - d.ax), Math.abs(py - d.ay) * lock);
    const zoom = clampZoom(base.w / Math.max(1e-4, wantW));
    const w = base.w / zoom, h = base.h / zoom;
    // Grow away from the pinned corner, toward the pointer.
    setPanel(d.i, { zoom, cx: clamp01(d.ax + d.sx * w / 2), cy: clamp01(d.ay + d.sy * h / 2) });
  }
  function onBoxUp(e: React.PointerEvent) {
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  // The last screen showing the clip can't switch to another video.
  const canUseVideo = !!selPanel.media || clipScreens(split) > 1;

  return (
    <div className="space-y-2.5">
      <input ref={fileRef} type="file" accept="video/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f); e.target.value = ""; }} />

      {/* Layout presets */}
      <div className="grid grid-cols-5 gap-1">
        {SPLIT_LAYOUT_KEYS.map((key) => {
          const active = split.layout === key;
          return (
            <button key={key} type="button" onClick={() => pickLayout(key)} title={SPLIT_LAYOUTS[key].label}
              aria-label={SPLIT_LAYOUTS[key].label} aria-pressed={active}
              className={`flex flex-col items-center gap-1 py-1.5 rounded-lg border transition-all duration-200 ${
                active
                  ? "bg-violet-600/15 border-violet-500/35"
                  : "bg-white/[0.02] border-white/[0.05] hover:border-white/[0.09] hover:bg-white/[0.04]"
              }`}>
              <LayoutGlyph layout={key} active={active} />
              <span className={`text-[7px] font-semibold uppercase tracking-wide leading-none ${active ? "text-violet-300" : "text-white/25"}`}>
                {SPLIT_LAYOUTS[key].label.replace(" stacked", "").replace("Facecam top", "Cam")}
              </span>
            </button>
          );
        })}
      </div>

      {/* Screen picker — the source + crop controls below apply to this one */}
      <div className="flex gap-1">
        {slots.map((_, i) => (
          <button key={i} type="button" onClick={() => setSelected(i)}
            className={`flex-1 flex items-center justify-center gap-1 py-1 text-[11px] rounded-md font-semibold border transition-all duration-200 ${
              i === sel ? "text-white border-transparent" : "bg-white/[0.03] text-white/30 border-white/[0.05] hover:text-white/55"
            }`}
            style={i === sel ? { background: `${PANEL_COLORS[i]}55`, borderColor: PANEL_COLORS[i] } : undefined}>
            {split.panels[i].media && <Film size={10} />}
            Screen {i + 1}
          </button>
        ))}
      </div>

      {/* Source for the selected screen */}
      {allowMedia && <div className="space-y-1.5">
        <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">Screen {sel + 1} shows</span>
        <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
          <button type="button" onClick={() => selPanel.media && setPanel(sel, { media: null, cx: 0.5, cy: 0.5, zoom: 1 })}
            className={`flex-1 py-1.5 text-[11px] font-semibold transition-colors ${
              !selPanel.media ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
            }`}>
            The clip
          </button>
          <button type="button" disabled={!canUseVideo || uploading !== null}
            onClick={() => fileRef.current?.click()}
            title={canUseVideo ? undefined : "At least one screen has to show the clip"}
            className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
              selPanel.media ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
            }`}>
            {uploading === sel ? <Loader2 size={10} className="animate-spin" /> : <Upload size={10} />}
            {uploading === sel ? "Uploading…" : selPanel.media ? "Replace video" : "Another video"}
          </button>
        </div>
        {!canUseVideo && (
          <p className="text-[10px] text-white/25 leading-relaxed">This is the only screen showing the clip — switch another screen to the clip first.</p>
        )}
        {uploadError && <p className="text-[11px] text-red-400">{uploadError}</p>}
        {selPanel.media && (
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-2 space-y-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <Film size={10} className="text-white/40 flex-shrink-0" />
              <span className="text-[11px] text-white/70 truncate flex-1" title={selPanel.media.name}>
                {selPanel.media.name ?? "Video"}
              </span>
              <button type="button" aria-label="Remove video — show the clip"
                onClick={() => setPanel(sel, { media: null, cx: 0.5, cy: 0.5, zoom: 1 })}
                className="text-white/30 hover:text-white/70"><X size={11} /></button>
            </div>
            {selPanel.media.duration > 1 && (
              <DSlider label="Start this video at" value={Math.round(selPanel.media.offset * 10) / 10}
                min={0} max={Math.max(0.1, Math.floor(selPanel.media.duration * 10) / 10 - 0.1)} step={0.1}
                onChange={(v) => setPanel(sel, { media: { ...selPanel.media!, offset: v } })}
                format={(v) => `${v.toFixed(1)}s`} />
            )}
            <p className="text-[10px] text-white/25 leading-relaxed">
              Plays in sync with the clip, muted, and loops if it&apos;s shorter. Use “Start at” to line it up.
            </p>
          </div>
        )}
      </div>}

      {/* Auto facecam: AI finds the webcam overlay and frames the selected screen on it */}
      {!selPanel.media && (
        <div className="space-y-1">
          <button type="button" onClick={detectFacecam} disabled={detecting}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[12px] font-semibold border transition-colors disabled:opacity-50
              bg-gradient-to-r from-violet-600/20 to-fuchsia-600/15 border-violet-500/35 text-violet-200 hover:from-violet-600/30 hover:to-fuchsia-600/25">
            {detecting ? <Loader2 size={12} className="animate-spin" /> : <ScanFace size={12} />}
            {detecting ? "Finding the facecam…" : `Detect facecam → Screen ${sel + 1}`}
          </button>
          {detectMsg && (
            <p role="status" className={`text-[11px] leading-relaxed ${detectMsg.ok ? "text-emerald-300/80" : "text-amber-300/80"}`}>{detectMsg.text}</p>
          )}
        </div>
      )}

      {/* Source map: the selected source with one draggable box per screen using it */}
      <div>
        <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
          {selPanel.media ? "Crop of the video" : "What each screen shows"}
        </span>
        {/* No overflow-hidden: corner handles of a box flush with the edge must
            stay fully grabbable (boxes themselves are clamped inside). */}
        <div ref={mapRef} className="relative mt-1.5 rounded-md bg-black border border-white/[0.08] select-none touch-none"
          style={{ aspectRatio: `${mapDims.w} / ${mapDims.h}` }}>
          <canvas ref={thumbRef} className="absolute inset-0 w-full h-full opacity-60 rounded-md" />
          {slots.map((_, i) => {
            if (keyOf(split.panels[i]) !== mapKey) return null;
            const c = cropOf(i);
            const isSel = i === sel;
            return (
              <div key={i} data-panel={i}
                onPointerDown={(e) => onBoxDown(e, i)} onPointerMove={onBoxMove} onPointerUp={onBoxUp} onPointerCancel={onBoxUp}
                className="absolute cursor-move rounded-[3px]"
                style={{
                  left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%`,
                  border: `${isSel ? 2 : 1.5}px solid ${PANEL_COLORS[i]}`,
                  background: `${PANEL_COLORS[i]}${isSel ? "33" : "1a"}`,
                  zIndex: isSel ? 10 : 1,
                }}>
                <span className="absolute -top-px -left-px px-1 text-[10px] font-bold text-white leading-[12px] rounded-br-[3px]"
                  style={{ background: PANEL_COLORS[i] }}>
                  {i + 1}
                </span>
                {/* Corner handles — drag to resize the capture (aspect-locked). The
                    hit area is larger than the visible dot so it's easy to grab on touch. */}
                {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([sx, sy]) => (
                  <span key={`${sx}${sy}`}
                    onPointerDown={(e) => onHandleDown(e, i, sx, sy)}
                    onPointerMove={onBoxMove} onPointerUp={onBoxUp} onPointerCancel={onBoxUp}
                    className="absolute w-4 h-4 -m-2 flex items-center justify-center"
                    style={{
                      left: sx < 0 ? 0 : "100%", top: sy < 0 ? 0 : "100%",
                      cursor: sx === sy ? "nwse-resize" : "nesw-resize",
                      zIndex: 20,
                    }}>
                    <span className="block rounded-[2px] border border-white"
                      style={{ width: isSel ? 8 : 6, height: isSel ? 8 : 6, background: PANEL_COLORS[i] }} />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-violet-400/50 font-medium flex items-center gap-1 mt-1.5">
          <Move size={10} className="text-violet-400" /> Drag a box to move it · drag a corner or scroll to resize
        </p>
      </div>

      {/* Same value as the box size, expressed as how much of the source it captures. */}
      <DSlider label={`Screen ${sel + 1} capture size`} value={Math.round(100 / selPanel.zoom)}
        min={Math.ceil(100 / SPLIT_MAX_ZOOM)} max={100}
        onChange={(pct) => setPanel(sel, { zoom: clampZoom(100 / pct) })} format={(v) => `${v}%`} />
      {splitResizable(split.layout) && (
        <DSlider label="Top screen height" value={Math.round((split.topH ?? SPLIT_LAYOUTS[split.layout].slots[0].h) * 100)}
          min={Math.round(SPLIT_TOP_MIN * 100)} max={Math.round(SPLIT_TOP_MAX * 100)}
          resetTo={Math.round(SPLIT_LAYOUTS[split.layout].slots[0].h * 100)}
          onChange={(pct) => onChange({ ...split, topH: pct / 100 })} format={(v) => `${v}%`} />
      )}
      <p className="text-[10px] text-white/25 leading-relaxed">
        Each screen is its own crop — of the clip, or of another video like a separate webcam recording. Motion crop and zoom keyframes don&apos;t apply in split mode.
      </p>
    </div>
  );
}
