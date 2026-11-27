// Shared clip-editor filter math, used by BOTH the in-browser FFmpeg path
// (src/app/clips/page.tsx) and the server route (src/app/api/clips/process).
// Keeping it in one place means the preview, the wasm export and the server
// export all agree on framing, zoom and captions.

export type AspectKey = "original" | "9:16" | "1:1" | "4:5" | "16:9";

// Canonical (standardized) output resolutions per format. `ar` is width/height.
export const ASPECTS: Record<AspectKey, { label: string; sub: string; ar: number | null; w: number; h: number }> = {
  original: { label: "Original", sub: "Source",    ar: null,   w: 0,    h: 0    },
  "9:16":   { label: "9:16",     sub: "Vertical",  ar: 9 / 16, w: 1080, h: 1920 },
  "1:1":    { label: "1:1",      sub: "Square",    ar: 1,      w: 1080, h: 1080 },
  "4:5":    { label: "4:5",      sub: "Portrait",  ar: 4 / 5,  w: 1080, h: 1350 },
  "16:9":   { label: "16:9",     sub: "Landscape", ar: 16 / 9, w: 1920, h: 1080 },
};

export const ASPECT_KEYS: AspectKey[] = ["original", "9:16", "1:1", "4:5", "16:9"];

// time = source-relative seconds; x = 0..100 horizontal position; z = zoom factor (>=1)
export type CropKeyframe = { id?: string; time: number; x: number };
export type ZoomKeyframe = { id?: string; time: number; z: number };

const even = (n: number) => {
  const r = Math.round(n);
  return Math.max(2, r % 2 === 0 ? r : r - 1);
};

// Build a piecewise FFmpeg expression for a value that changes over time.
// `tv` is the time expression ("t" for normal filters, "(on/fps)" inside zoompan,
// whose input-timestamp var isn't available in every FFmpeg build).
// `smooth` pans/eases linearly between keyframes; otherwise it snaps (hard cut).
function pieceExpr(keys: { T: number; V: number }[], smooth: boolean, tv: string, fallback: number): string {
  if (keys.length === 0) return fallback.toFixed(4);
  if (keys.length === 1) return keys[0].V.toFixed(4);
  let e = keys[keys.length - 1].V.toFixed(4); // value once past the last keyframe
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    const dt = (b.T - a.T) || 0.0001;
    const seg = smooth
      ? `(${a.V.toFixed(4)}+(${(b.V - a.V).toFixed(4)})*(${tv}-${a.T.toFixed(3)})/${dt.toFixed(3)})`
      : a.V.toFixed(4);
    e = `if(between(${tv},${a.T.toFixed(3)},${b.T.toFixed(3)}),${seg},${e})`;
  }
  e = `if(lt(${tv},${keys[0].T.toFixed(3)}),${keys[0].V.toFixed(4)},${e})`; // before the first
  return e;
}

// Canonical output dimensions for the chosen aspect (falls back to even source
// size). `maxShortSide` caps the shorter dimension (e.g. 720 for "720p") by
// downscaling proportionally — never upscales. Used to enforce per-plan limits.
export function outputDims(aspect: AspectKey, srcW: number, srcH: number, maxShortSide?: number): { w: number; h: number } {
  const a = ASPECTS[aspect];
  let w: number, h: number;
  if (a.ar == null) { w = even(srcW || 1080); h = even(srcH || 1920); }
  else { w = a.w; h = a.h; }

  if (maxShortSide && maxShortSide > 0) {
    const short = Math.min(w, h);
    if (short > maxShortSide) {
      const f = maxShortSide / short;
      w = even(w * f); h = even(h * f);
    }
  }
  return { w, h };
}

// The crop window (in source pixels) for an aspect ratio, fit inside the source.
export function cropWindow(ar: number, srcW: number, srcH: number): { cw: number; ch: number; x0: number; y0: number } {
  let cw = Math.min(srcW, srcH * ar);
  let ch = cw / ar;
  if (ch > srcH) { ch = srcH; cw = ch * ar; }
  cw = even(cw); ch = even(ch);
  return { cw, ch, x0: Math.max(0, srcW - cw), y0: Math.max(0, Math.round((srcH - ch) / 2)) };
}

// ── Split screen (multi-panel layout) ──────────────────────────────────
// The output frame is divided into 2–4 slots (a layout preset); each slot
// shows its own crop of the source — e.g. the facecam corner on top and the
// middle of the gameplay below. A panel's crop is aspect-locked to its slot
// so nothing stretches: the user only picks its center and zoom.
//
// Slot rects are fractions of the OUTPUT frame; panel cx/cy are fractions
// of the SOURCE frame (crop center); zoom 1 = the largest slot-shaped crop
// that fits the source, 2 = half that width, etc.
export type SplitLayoutKey = "stack2" | "facecam" | "stack3" | "top1bottom2" | "grid4";
// A screen shows the clip by default; `media` swaps in another video (e.g. a
// separate webcam recording or a second clip). Its crop uses the media's own
// w/h. It starts `offset` seconds in, plays in sync with the clip, and loops
// if shorter. `path` is the server-resolved local file — set ONLY by
// renderClip after downloading `url`, never trusted from input (it is spliced
// into the filtergraph).
export type SplitMedia = { url: string; name?: string; w: number; h: number; duration: number; offset: number; path?: string };
export type SplitPanel = { cx: number; cy: number; zoom: number; media?: SplitMedia | null };
// topH: height of the top screen (fraction of the frame) for the 2-screen
// stacked layouts — set by facecam detection so the cam screen takes the
// cam's own shape, or by hand. Unset = the layout's default split.
export type SplitConfig = { layout: SplitLayoutKey; panels: SplitPanel[]; topH?: number };
type Rect = { x: number; y: number; w: number; h: number };

export const SPLIT_LAYOUTS: Record<SplitLayoutKey, { label: string; slots: Rect[]; defaults: SplitPanel[] }> = {
  stack2: {
    label: "2 stacked",
    slots: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }],
    defaults: [{ cx: 0.5, cy: 0.5, zoom: 1 }, { cx: 0.5, cy: 0.5, zoom: 1.6 }],
  },
  facecam: {
    label: "Facecam top",
    slots: [{ x: 0, y: 0, w: 1, h: 0.35 }, { x: 0, y: 0.35, w: 1, h: 0.65 }],
    // Facecams usually sit in a top corner of the stream; gameplay below.
    defaults: [{ cx: 0.13, cy: 0.12, zoom: 3.6 }, { cx: 0.5, cy: 0.5, zoom: 1 }],
  },
  stack3: {
    label: "3 stacked",
    slots: [0, 1, 2].map((i) => ({ x: 0, y: i / 3, w: 1, h: 1 / 3 })),
    defaults: [{ cx: 0.15, cy: 0.15, zoom: 3 }, { cx: 0.5, cy: 0.5, zoom: 1 }, { cx: 0.85, cy: 0.85, zoom: 3 }],
  },
  top1bottom2: {
    label: "1 + 2",
    slots: [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
    defaults: [{ cx: 0.5, cy: 0.5, zoom: 1 }, { cx: 0.15, cy: 0.15, zoom: 2.5 }, { cx: 0.85, cy: 0.15, zoom: 2.5 }],
  },
  grid4: {
    label: "2 × 2 grid",
    slots: [
      { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
    defaults: [
      // zoom 2 so each tile frames its own quadrant of the stream (at zoom 1 a
      // tall tile spans the full source height and rows look identical).
      { cx: 0.25, cy: 0.25, zoom: 2 }, { cx: 0.75, cy: 0.25, zoom: 2 },
      { cx: 0.25, cy: 0.75, zoom: 2 }, { cx: 0.75, cy: 0.75, zoom: 2 },
    ],
  },
};
export const SPLIT_LAYOUT_KEYS = Object.keys(SPLIT_LAYOUTS) as SplitLayoutKey[];
export const SPLIT_MAX_ZOOM = 6;
export const SPLIT_TOP_MIN = 0.2, SPLIT_TOP_MAX = 0.6;
const RESIZABLE_LAYOUTS: SplitLayoutKey[] = ["facecam", "stack2"];
export function splitResizable(layout: SplitLayoutKey) { return RESIZABLE_LAYOUTS.includes(layout); }
const clampTop = (h: number) => Math.max(SPLIT_TOP_MIN, Math.min(SPLIT_TOP_MAX, h));

export function defaultSplit(layout: SplitLayoutKey = "facecam"): SplitConfig {
  return { layout, panels: SPLIT_LAYOUTS[layout].defaults.map((p) => ({ ...p })) };
}

// Validate untrusted input (request body / AI output / saved state) into a
// well-formed config, or null. Missing panels fall back to layout defaults.
export function sanitizeSplit(raw: unknown): SplitConfig | null {
  const r = raw as { layout?: unknown; panels?: unknown } | null;
  if (!r || typeof r.layout !== "string" || !(r.layout in SPLIT_LAYOUTS)) return null;
  const layout = r.layout as SplitLayoutKey;
  const incoming = Array.isArray(r.panels) ? r.panels : [];
  const clamp01 = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
  const panels = SPLIT_LAYOUTS[layout].defaults.map((d, i) => {
    const p = (incoming[i] ?? {}) as Partial<SplitPanel>;
    const zoom = typeof p.zoom === "number" && isFinite(p.zoom) ? Math.max(1, Math.min(SPLIT_MAX_ZOOM, p.zoom)) : d.zoom;
    return { cx: clamp01(p.cx, d.cx), cy: clamp01(p.cy, d.cy), zoom, media: sanitizeMedia(p.media) };
  });
  const t = (r as { topH?: unknown }).topH;
  const topH = splitResizable(layout) && typeof t === "number" && isFinite(t) ? clampTop(t) : undefined;
  return topH != null ? { layout, panels, topH } : { layout, panels };
}

const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);

// Keep only the client-owned fields; `path` is deliberately dropped.
function sanitizeMedia(raw: unknown): SplitMedia | null {
  const m = raw as Partial<SplitMedia> | null | undefined;
  if (!m || typeof m.url !== "string" || !m.url || m.url.length > 2048) return null;
  // The server downloads this URL — and resolveToTempFile reads any non-http
  // value straight off local disk. Only accept our own uploads (a bare file
  // name under /uploads/, no traversal) or an https URL.
  const ownUpload = /^\/uploads\/[A-Za-z0-9._-]+$/.test(m.url) && !m.url.includes("..");
  if (!ownUpload && !m.url.startsWith("https://")) return null;
  const w = Math.round(num(m.w, 0)), h = Math.round(num(m.h, 0));
  if (w < 16 || h < 16 || w > 8192 || h > 8192) return null;
  return {
    url: m.url,
    name: typeof m.name === "string" ? m.name.slice(0, 120) : undefined,
    w, h,
    duration: Math.max(0, num(m.duration, 0)),
    offset: Math.max(0, num(m.offset, 0)),
  };
}

// The frame a panel crops from: its own media, or the clip.
export function panelSrcDims(panel: SplitPanel | undefined, srcW: number, srcH: number) {
  return panel?.media ? { w: panel.media.w, h: panel.media.h } : { w: srcW, h: srcH };
}

// Escape a file path for a single-quoted filter option value (same rules the
// libass `subtitles=f='…'` path uses): forward slashes, escaped drive colon.
// The colon MUST be escaped: unescaped, `fontfile='D:/…'` is split at the
// drive colon and drawtext silently falls back to a default font (this is why
// every caption style used to render in the same font).
export function filterPath(p: string) {
  return p.replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:");
}

// `fontfile='…':` option for drawtext (empty when no font resolved).
export function fontfileOpt(fontPath: string): string {
  return fontPath ? `fontfile='${filterPath(fontPath)}':` : "";
}

// Snap fractional edges to whole pixels so neighbouring slots tile exactly
// (no 1px gaps/overlaps from independent rounding).
function slotPixels(s: Rect, outW: number, outH: number): Rect {
  const x0 = Math.round(s.x * outW), x1 = Math.round((s.x + s.w) * outW);
  const y0 = Math.round(s.y * outH), y1 = Math.round((s.y + s.h) * outH);
  return { x: x0, y: y0, w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) };
}

// The source crop for one panel, as fractions of the source frame. Shared by
// the live preview (CSS) and the export (pixels) so they frame identically.
export function splitCropRect(panel: SplitPanel, slot: Rect, outW: number, outH: number, srcW: number, srcH: number): Rect {
  const slotAR = (slot.w * outW) / (slot.h * outH);
  let cw = Math.min(srcW, srcH * slotAR);
  let ch = cw / slotAR;
  if (ch > srcH) { ch = srcH; cw = ch * slotAR; }
  const z = Math.max(1, Math.min(SPLIT_MAX_ZOOM, panel.zoom || 1));
  cw /= z; ch /= z;
  const x = Math.max(0, Math.min(srcW - cw, panel.cx * srcW - cw / 2));
  const y = Math.max(0, Math.min(srcH - ch, panel.cy * srcH - ch / 2));
  return { x: x / srcW, y: y / srcH, w: cw / srcW, h: ch / srcH };
}

// One filtergraph string: split the frame N ways, crop + scale each panel to
// its slot, and lay them out on a canvas of exactly outW×outH. It has one
// unlabeled input and one unlabeled output, so it slots into a comma-joined
// chain (`eq,…,<this>,vignette,…`) in both `-vf` and `-filter_complex` — the
// internal `;`-separated chains are valid in either.
export function splitFilterGraph(split: SplitConfig, srcW: number, srcH: number, outW: number, outH: number): string {
  const slots = splitSlots(split);
  const n = slots.length;
  const panels = slots.map((_, i) => split.panels[i] ?? SPLIT_LAYOUTS[split.layout].defaults[i]);
  // Only screens showing the clip consume a branch of the input; screens with
  // their own video read it through a `movie=` source (no extra -i needed, so
  // this stays a one-in/one-out graph). A media panel without a resolved
  // `path` falls back to the clip.
  const fromClip = panels.map((p) => !p.media?.path);
  // At least one screen must show the clip: it's what consumes the input and
  // (via shortest=1) ends the render — looping panel videos never end.
  if (!fromClip.some(Boolean)) fromClip[0] = true;
  const clipCount = fromClip.filter(Boolean).length;
  const parts: string[] = [
    clipCount === 1 ? "null[sp0]" : `split=${clipCount}${Array.from({ length: clipCount }, (_, i) => `[sp${i}]`).join("")}`,
  ];
  let clipIdx = 0;
  panels.forEach((panel, i) => {
    const slot = slots[i];
    const px = slotPixels(slot, outW, outH);
    const dims = panelSrcDims(fromClip[i] ? undefined : panel, srcW, srcH);
    // A media panel forced back to the clip keeps its framing numbers but
    // crops the clip — same as the preview, which shows the clip there too.
    const c = splitCropRect(panel, slot, outW, outH, dims.w, dims.h);
    const cw = Math.max(2, Math.round(c.w * dims.w)), ch = Math.max(2, Math.round(c.h * dims.h));
    const cx = Math.min(dims.w - cw, Math.round(c.x * dims.w)), cy = Math.min(dims.h - ch, Math.round(c.y * dims.h));
    const fit = `crop=${cw}:${ch}:${Math.max(0, cx)}:${Math.max(0, cy)},scale=${px.w}:${px.h}:flags=bicubic,setsar=1`;
    let head: string;
    if (fromClip[i]) {
      head = `[sp${clipIdx++}]${fit}`;
    } else {
      const m = panel.media!;
      // loop=0 = loop forever; the composite ends with the clip (shortest=1 below).
      // Timestamps must be rebuilt from the frame count: `movie` restarts PTS
      // on every loop, and non-monotonic PTS stall the overlay forever (the
      // render hangs). FRAME_RATE can be NaN for variable-frame-rate phone/
      // webcam recordings, hence the 30fps fallback.
      const seek = m.offset > 0 ? `:seek_point=${m.offset.toFixed(3)}` : "";
      head = `movie=filename='${filterPath(m.path!)}':loop=0${seek},` +
        `setpts='N/if(isnan(FRAME_RATE),30,FRAME_RATE)/TB',format=yuv420p,${fit}`;
    }
    // Panel 0 becomes the full-size canvas (padded with black); the rest are
    // overlaid onto it at their slot position.
    parts.push(i === 0 ? `${head},pad=${outW}:${outH}:${px.x}:${px.y}:black[sb0]` : `${head}[sq${i}]`);
  });
  for (let i = 1; i < n; i++) {
    const px = slotPixels(slots[i], outW, outH);
    // shortest=1: a looping panel video never ends, so the clip decides the length.
    parts.push(`[sb${i - 1}][sq${i}]overlay=${px.x}:${px.y}:shortest=1${i < n - 1 ? `[sb${i}]` : ""}`);
  }
  return parts.join(";");
}

// A detected facecam box (fractions of the source frame) → the framing of the
// screen that should show it: centred on the cam and zoomed so the cam FILLS
// the screen edge to edge ("cover"), with a small inset that trims the
// overlay's own border. The old "contain" fit left strips of gameplay / chat
// widgets around the cam, which reads as a sloppy crop. When the cam's shape
// is very different from the slot's, full cover would cut off too much of it
// (e.g. the top of the streamer's head), so the zoom is capped partway
// between contain and cover. Used by the editor's "Detect facecam" and
// Auto-Pilot's per-clip auto facecam.
export type FacecamBox = { x: number; y: number; w: number; h: number };
const FACECAM_INSET = 1.015;      // trim <1% per side — just the overlay's own frame/border
const FACECAM_MAX_OVERCROP = 1.3; // cover may crop at most ~23% of the cam's long side
export function panelForFacecam(box: FacecamBox, layout: SplitLayoutKey | SplitConfig, slotIndex: number, outW: number, outH: number, srcW: number, srcH: number): SplitPanel {
  const slots = splitSlots(layout);
  const slot = slots[slotIndex] ?? slots[0];
  const base = splitCropRect({ cx: 0.5, cy: 0.5, zoom: 1 }, slot, outW, outH, srcW, srcH); // largest crop (zoom 1)
  const contain = Math.min(base.w / box.w, base.h / box.h);
  const cover = Math.max(base.w / box.w, base.h / box.h) * FACECAM_INSET;
  const zoom = Math.max(1, Math.min(SPLIT_MAX_ZOOM, cover, contain * FACECAM_MAX_OVERCROP));
  // A cover crop narrower than the box must stay inside it: centre on the
  // box, and when cropping vertically keep the upper part (faces sit high).
  const cropH = base.h / zoom;
  const spareH = Math.max(0, box.h - cropH);
  const cy = box.y + cropH / 2 + spareH * 0.35;
  return { cx: Math.max(0, Math.min(1, box.x + box.w / 2)), cy: Math.max(0, Math.min(1, cy)), zoom };
}

// The gameplay screen of a split: crop away letterbox bars (a cutscene's
// black bands otherwise show as dead strips across the screen) and keep the
// facecam overlay out of it — showing the cam twice looks broken. `content`
// is the non-black row band and `avoid` the facecam box, both fractions of
// the source; `panel` is the saved framing to start from.
export function panelForGameplay(
  panel: SplitPanel, content: { top: number; bottom: number } | null, avoid: FacecamBox | null,
  layout: SplitLayoutKey | SplitConfig, slotIndex: number, outW: number, outH: number, srcW: number, srcH: number,
): SplitPanel {
  const slots = splitSlots(layout);
  const slot = slots[slotIndex] ?? slots[0];
  const base = splitCropRect({ cx: 0.5, cy: 0.5, zoom: 1 }, slot, outW, outH, srcW, srcH);
  let { cx, cy, zoom } = panel;
  if (content) {
    const band = content.bottom - content.top;
    if (band > 0.3 && band < 0.995) {
      // Zoom just enough that the crop's height fits inside the content band.
      const need = base.h / band;
      if (need > zoom) zoom = Math.min(SPLIT_MAX_ZOOM, need * 1.01);
      const halfH = base.h / zoom / 2;
      cy = Math.max(content.top + halfH, Math.min(content.bottom - halfH, cy));
    }
  }
  if (avoid) {
    const halfW = base.w / zoom / 2, halfH = base.h / zoom / 2;
    const overlapsY = cy - halfH < avoid.y + avoid.h && cy + halfH > avoid.y;
    const left = cx - halfW, right = cx + halfW;
    if (overlapsY && left < avoid.x + avoid.w && right > avoid.x) {
      // Slide away from the cam — but only a little: the action is usually
      // centred, so a cam that sits mid-frame stays rather than losing it.
      const camCx = avoid.x + avoid.w / 2;
      const target = camCx < cx ? avoid.x + avoid.w + halfW : avoid.x - halfW;
      if (Math.abs(target - cx) <= 0.12 && target - halfW >= 0 && target + halfW <= 1) cx = target;
    }
  }
  return { ...panel, cx, cy, zoom };
}

// Slot rects as fractions (preview tiles, export graph, framing). Pass the
// config to honour a custom top-screen height; a bare layout gives defaults.
export function splitSlots(s: SplitLayoutKey | SplitConfig): Rect[] {
  const layout = typeof s === "string" ? s : s.layout;
  const topH = typeof s === "string" ? undefined : s.topH;
  if (topH == null || !splitResizable(layout)) return SPLIT_LAYOUTS[layout].slots;
  const h = clampTop(topH);
  return [{ x: 0, y: 0, w: 1, h }, { x: 0, y: h, w: 1, h: 1 - h }];
}

/**
 * Frame a split on a detected facecam so the WHOLE cam shows, edge to edge:
 * in the 2-screen stacked layouts the cam screen's height is set to the cam's
 * own aspect ratio (so "cover" crops nothing but the overlay border), then
 * the cam screen is framed on it. Other layouts keep their fixed slots.
 */
export function fitSplitToFacecam(
  split: SplitConfig, box: FacecamBox, slotIndex: number, outW: number, outH: number, srcW: number, srcH: number,
): SplitConfig {
  let next: SplitConfig = split;
  if (slotIndex === 0 && splitResizable(split.layout) && box.h > 0) {
    const camAR = (box.w * srcW) / (box.h * srcH);
    next = { ...split, topH: clampTop(outW / camAR / outH) };
  }
  const panel = panelForFacecam(box, next, slotIndex, outW, outH, srcW, srcH);
  return { ...next, panels: next.panels.map((p, i) => (i === slotIndex ? { ...p, ...panel, media: p.media } : p)) };
}

// ── Color filter presets ──────────────────────────────────────────────
// `ff` is the FFmpeg filter (export); `css` is the closest CSS-filter
// equivalent for the live preview. bw/sepia match exactly; warm/cool are
// near approximations.
export type ColorFilterKey = "none" | "bw" | "sepia" | "vivid" | "warm" | "cool" | "faded";
export const COLOR_FILTERS: Record<ColorFilterKey, { label: string; ff: string; css: string }> = {
  none:  { label: "None",  ff: "", css: "" },
  bw:    { label: "B&W",   ff: "hue=s=0", css: "grayscale(1)" },
  sepia: { label: "Sepia", ff: "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131", css: "sepia(0.95)" },
  vivid: { label: "Vivid", ff: "eq=saturation=1.35:contrast=1.08", css: "saturate(1.35) contrast(1.08)" },
  warm:  { label: "Warm",  ff: "eq=gamma_r=1.12:gamma_b=0.88:saturation=1.06", css: "sepia(0.2) saturate(1.22) hue-rotate(-8deg)" },
  cool:  { label: "Cool",  ff: "eq=gamma_r=0.9:gamma_b=1.12:saturation=1.04", css: "saturate(1.04) hue-rotate(10deg) brightness(1.02)" },
  faded: { label: "Faded", ff: "eq=saturation=0.72:contrast=0.88:brightness=0.04", css: "saturate(0.72) contrast(0.88) brightness(1.04)" },
};
export const COLOR_FILTER_KEYS = Object.keys(COLOR_FILTERS) as ColorFilterKey[];

// ── Timed effect segments ─────────────────────────────────────────────
// Each segment applies a look only between start..end (source-relative
// seconds, like crop/zoom keyframes). All filters used here support
// FFmpeg timeline editing (enable=), so they can be windowed safely.
export type EffectKey = "flash" | "blur" | "bw" | "vivid" | "warm" | "cool" | "invert" | "dim" | "punch";
export const EFFECTS: Record<EffectKey, { label: string; ff: string; css: string }> = {
  flash: { label: "Flash", ff: "eq=brightness=0.4", css: "brightness(1.9)" },
  blur:  { label: "Blur",  ff: "boxblur=8:1", css: "blur(7px)" },
  bw:    { label: "B&W",   ff: "hue=s=0", css: "grayscale(1)" },
  vivid: { label: "Vivid", ff: "eq=saturation=1.5:contrast=1.1", css: "saturate(1.5) contrast(1.1)" },
  warm:  { label: "Warm",  ff: "eq=gamma_r=1.15:gamma_b=0.85", css: "sepia(0.25) saturate(1.2) hue-rotate(-8deg)" },
  cool:  { label: "Cool",  ff: "eq=gamma_r=0.85:gamma_b=1.15", css: "saturate(1.05) hue-rotate(12deg) brightness(1.02)" },
  // Each ff here must be ONE timeline-capable filter WITH an =option list —
  // ":enable=..." is appended to it.
  invert: { label: "Invert", ff: "negate=negate_alpha=0", css: "invert(1)" },
  dim:    { label: "Dim",    ff: "eq=brightness=-0.22:saturation=0.8", css: "brightness(0.62) saturate(0.8)" },
  punch:  { label: "Punch",  ff: "eq=contrast=1.35:saturation=1.4", css: "contrast(1.35) saturate(1.4)" },
};
export const EFFECT_KEYS = Object.keys(EFFECTS) as EffectKey[];
export type EffectSegment = { id?: string; type: EffectKey; start: number; end: number };

// Volume keyframes — v is 0..100 (% of original loudness, can exceed 100 up to 200).
export type VolumeKeyframe = { id?: string; time: number; v: number };

export type FilterOpts = {
  srcW: number; srcH: number; fps: number;
  aspect: AspectKey;
  cropX: number; cropKeys: CropKeyframe[]; cropSmooth: boolean;
  zoom: number; zoomKeys: ZoomKeyframe[]; zoomSmooth: boolean;
  trimStart: number;
  brightness: number; contrast: number; speed: number;
  saturation?: number;            // -50..50, 0 = unchanged
  colorFilter?: ColorFilterKey;   // preset look
  mirror?: boolean;               // flip the framed output horizontally
  fadeIn?: number;                // seconds of fade from black (output timeline)
  fadeOut?: number;               // seconds of fade to black (output timeline)
  trimEnd?: number;               // needed to place the fade-out
  effects?: EffectSegment[];      // timed effect windows
  vignette?: boolean;             // darkened frame edges
  maxShortSide?: number;          // cap shorter output side (per-plan resolution limit)
  split?: SplitConfig | null;     // multi-panel layout; replaces crop + zoom when set
};

// The full ordered video-filter chain (excluding caption, which is server-only).
// Order: eq/look → crop (clip-relative `t`) → scale → zoompan → setpts(speed)
// → hflip → fades. Mirror and fades come last so they act on the framed output,
// matching the preview (which mirrors/fades the stage, not the source).
export function buildVideoFilters(o: FilterOpts): { filters: string[]; outW: number; outH: number } {
  const filters: string[] = [];
  // Split screen needs a target aspect; each panel has its own crop + zoom,
  // so the single-crop and zoom stages are skipped entirely.
  const split = o.split && o.aspect !== "original" ? o.split : null;
  const cropEnabled = o.aspect !== "original" && !split;
  const zoomActive = !split && (o.zoom > 1.001 || o.zoomKeys.length > 0);
  const { w: outW, h: outH } = outputDims(o.aspect, o.srcW, o.srcH, o.maxShortSide);
  const saturation = o.saturation ?? 0;

  if (o.brightness !== 0 || o.contrast !== 0 || saturation !== 0) {
    const eq = [
      `brightness=${(o.brightness / 100).toFixed(3)}`,
      `contrast=${(1 + o.contrast / 100).toFixed(3)}`,
    ];
    if (saturation !== 0) eq.push(`saturation=${Math.max(0, 1 + saturation / 100).toFixed(3)}`);
    filters.push(`eq=${eq.join(":")}`);
  }
  const preset = COLOR_FILTERS[o.colorFilter ?? "none"];
  if (preset.ff) filters.push(preset.ff);

  // Timed effect windows. They run before crop/zoom, so `t` is clip-relative
  // (post -ss) source time — the same timeline crop keyframes use.
  for (const seg of o.effects ?? []) {
    const fx = EFFECTS[seg.type];
    if (!fx) continue;
    const a = Math.max(0, seg.start - o.trimStart);
    const b = Math.max(a + 0.05, seg.end - o.trimStart);
    filters.push(`${fx.ff}:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`);
  }

  if (split) {
    filters.push(splitFilterGraph(split, o.srcW, o.srcH, outW, outH));
  } else if (cropEnabled) {
    const ar = ASPECTS[o.aspect].ar!;
    const { cw, ch, x0, y0 } = cropWindow(ar, o.srcW, o.srcH);
    const ck = o.cropKeys
      .map((k) => ({ T: Math.max(0, k.time - o.trimStart), V: Math.max(0, Math.min(1, k.x / 100)) }))
      .sort((a, b) => a.T - b.T);
    if (ck.length === 0) {
      const fx = Math.max(0, Math.min(1, o.cropX / 100));
      filters.push(`crop=${cw}:${ch}:${Math.round(x0 * fx)}:${y0}`);
    } else {
      filters.push(`crop=${cw}:${ch}:'${x0}*(${pieceExpr(ck, o.cropSmooth, "t", o.cropX / 100)})':${y0}`);
    }
    filters.push(`scale=${outW}:${outH}:flags=bicubic`, "setsar=1");
  } else if (zoomActive) {
    // Normalize to even dimensions so zoompan has a known input size to work from.
    filters.push(`scale=${outW}:${outH}:flags=bicubic`, "setsar=1");
  }

  if (zoomActive) {
    const fxStatic = Math.max(0, Math.min(1, o.cropX / 100));
    if (o.zoomKeys.length === 0) {
      // Constant zoom: crop a smaller window centered on the crop position, then
      // upscale back to full size. Pure numeric math — no time expressions needed.
      const z = Math.max(1, o.zoom);
      const cw = even(outW / z);
      const ch = even(outH / z);
      const x = Math.round((outW - cw) * fxStatic);
      const y = Math.round((outH - ch) / 2);
      filters.push(`crop=${cw}:${ch}:${x}:${y}`, `scale=${outW}:${outH}:flags=bicubic`);
    } else {
      // Time-keyframed zoom via zoompan. The ramp is driven by clip time, but
      // zoompan's input-timestamp var (`it`/`in_time`) isn't defined in every
      // FFmpeg build — `on` (output frame index) is. With d=1 and a fixed fps,
      // clip time = on/fps, so we use that as the time variable.
      const zfps = o.fps || 30;
      const tv = `(on/${zfps})`;
      const zk = o.zoomKeys
        .map((k) => ({ T: Math.max(0, k.time - o.trimStart), V: Math.max(1, k.z) }))
        .sort((a, b) => a.T - b.T);
      const zExpr = pieceExpr(zk, o.zoomSmooth, tv, Math.max(1, o.zoom));
      // Zoom focus follows the crop position horizontally; vertically centered.
      const ck = o.cropKeys
        .map((k) => ({ T: Math.max(0, k.time - o.trimStart), V: Math.max(0, Math.min(1, k.x / 100)) }))
        .sort((a, b) => a.T - b.T);
      const fxExpr = ck.length ? pieceExpr(ck, o.cropSmooth, tv, o.cropX / 100) : fxStatic.toFixed(4);
      const z = `max(1,${zExpr})`;
      filters.push(
        `zoompan=z='${z}':x='(iw-iw/(${z}))*(${fxExpr})':y='(ih-ih/(${z}))/2':d=1:s=${outW}x${outH}:fps=${zfps}`
      );
    }
  }

  if (o.vignette) filters.push("vignette=PI/4");

  if (o.speed !== 1) filters.push(`setpts=PTS/${o.speed}`);

  if (o.mirror) filters.push("hflip");

  // Fades live on the output timeline (after the speed change). They run
  // before the caption is burned in, so overlay text stays at full strength —
  // same as the preview, where the fade layer sits under the caption.
  const fadeIn  = Math.max(0, o.fadeIn ?? 0);
  const fadeOut = Math.max(0, o.fadeOut ?? 0);
  const outDur  = o.trimEnd && o.trimEnd > o.trimStart ? (o.trimEnd - o.trimStart) / o.speed : 0;
  if (fadeIn > 0) filters.push(`fade=t=in:st=0:d=${fadeIn.toFixed(2)}`);
  if (fadeOut > 0 && outDur > 0) {
    filters.push(`fade=t=out:st=${Math.max(0, outDur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`);
  }

  return { filters, outW, outH };
}

// Volume over time. With keyframes, builds a per-frame volume expression
// (smooth ramps between keys — audio "ducking"); without, a static volume.
// Place BEFORE atempo so `t` is clip-relative source time like crop/zoom keys.
export function audioVolumeFilters(volumeKeys: VolumeKeyframe[], trimStart: number, fallbackVol: number): string[] {
  if (volumeKeys.length === 0) {
    return fallbackVol !== 100 ? [`volume=${(fallbackVol / 100).toFixed(3)}`] : [];
  }
  const vk = volumeKeys
    .map((k) => ({ T: Math.max(0, k.time - trimStart), V: Math.max(0, Math.min(2, k.v / 100)) }))
    .sort((a, b) => a.T - b.T);
  return [`volume='${pieceExpr(vk, true, "t", fallbackVol / 100)}':eval=frame`];
}

// The volume (0..200 %) at a given clip-relative time — used by the live preview.
export function volumeAt(volumeKeys: VolumeKeyframe[], time: number, fallbackVol: number): number {
  if (volumeKeys.length === 0) return fallbackVol;
  const vk = [...volumeKeys].sort((a, b) => a.time - b.time);
  if (time <= vk[0].time) return vk[0].v;
  for (let i = 0; i < vk.length - 1; i++) {
    const a = vk[i], b = vk[i + 1];
    if (time >= a.time && time <= b.time) {
      const f = (time - a.time) / ((b.time - a.time) || 0.0001);
      return a.v + (b.v - a.v) * f;
    }
  }
  return vk[vk.length - 1].v;
}

// Audio fades matching the video fades (same output-timeline placement).
export function audioFadeFilters(fadeIn: number, fadeOut: number, outDur: number): string[] {
  const out: string[] = [];
  if (fadeIn > 0) out.push(`afade=t=in:st=0:d=${fadeIn.toFixed(2)}`);
  if (fadeOut > 0 && outDur > 0) {
    out.push(`afade=t=out:st=${Math.max(0, outDur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`);
  }
  return out;
}

// Default caption font size = frame height / 24. `sizeMul` scales that.
export const CAPTION_BASE_DIVISOR = 24;

// Pitch-shift filters for the given number of semitones (no tempo change).
// Returns [] for 0. Works on any source rate by resampling to 44.1k first.
export function audioPitchFilters(semitones: number): string[] {
  if (!semitones) return [];
  const factor = Math.pow(2, semitones / 12); // >1 = higher pitch
  return [
    "aresample=44100",
    `asetrate=${Math.round(44100 * factor)}`,
    "aresample=44100",
    `atempo=${(1 / factor).toFixed(6)}`, // semitones in [-12,12] keep this in [0.5,2]
  ];
}

// ── Text fonts ──────────────────────────────────────────────────────────
// Every text style ships its own font file in public/fonts, so the server
// burn-in, the editor preview and every deploy target render the SAME glyphs
// (previously: whatever system font happened to exist — Arial/Comic Sans on
// Windows, all DejaVu on Linux, so styles looked identical and cheap).
//   file    — public/fonts/<file>, read by ffmpeg (drawtext + libass fontsdir)
//   family  — the font's internal family name (libass matches on this)
//   assBold — 1 only when the file IS the bold face of `family` (else libass
//             would fake-bold an already heavy font)
//   css     — @font-face family declared in globals.css for the live preview
export const FONT_KEYS = ["bold", "sans", "impact", "condensed", "serif", "round", "marker", "mono"] as const;
export type FontKey = (typeof FONT_KEYS)[number];
export const TEXT_FONTS: Record<FontKey, { label: string; file: string; family: string; assBold: 0 | 1; css: string }> = {
  bold:      { label: "Bold",   file: "Montserrat-ExtraBold.ttf",    family: "Montserrat ExtraBold", assBold: 0, css: "Vybe Bold" },
  sans:      { label: "Clean",  file: "Poppins-SemiBold.ttf",        family: "Poppins SemiBold",     assBold: 0, css: "Vybe Sans" },
  impact:    { label: "Impact", file: "Anton-Regular.ttf",           family: "Anton",                assBold: 0, css: "Vybe Impact" },
  condensed: { label: "Tall",   file: "BebasNeue-Regular.ttf",       family: "Bebas Neue",           assBold: 0, css: "Vybe Condensed" },
  serif:     { label: "Serif",  file: "DMSerifDisplay-Regular.ttf",  family: "DM Serif Display",     assBold: 0, css: "Vybe Serif" },
  round:     { label: "Round",  file: "LilitaOne-Regular.ttf",       family: "Lilita One",           assBold: 0, css: "Vybe Round" },
  marker:    { label: "Marker", file: "PermanentMarker-Regular.ttf", family: "Permanent Marker",     assBold: 0, css: "Vybe Marker" },
  mono:      { label: "Mono",   file: "SpaceMono-Bold.ttf",          family: "Space Mono",           assBold: 1, css: "Vybe Mono" },
};
// Brand type (matches the dashboard wordmark, Space Grotesk) for the watermark.
export const BRAND_FONTS = { bold: "SpaceGrotesk-Bold.ttf", medium: "SpaceGrotesk-Medium.ttf" } as const;

export function isFontKey(v: unknown): v is FontKey {
  return typeof v === "string" && (FONT_KEYS as readonly string[]).includes(v);
}

// CapCut-style text styling shared by captions and subtitles.
export type TextStyle = {
  font: FontKey;
  color: string;     // hex without '#', e.g. "FFFFFF"
  template: "outline" | "box" | "shadow" | "pop";
};
export const DEFAULT_TEXT_STYLE: TextStyle = { font: "bold", color: "FFFFFF", template: "outline" };

// The styling portion of a drawtext filter (color + outline / box / shadow).
export function styleDrawOptions(style: TextStyle, fontsize: number): string {
  const color = (style.color || "FFFFFF").replace(/[^0-9a-fA-F]/g, "").slice(0, 6).padEnd(6, "F");
  // A crisp, fairly thin stroke + a soft offset shadow reads as "designed";
  // the old fontsize/12 stroke made every font look blobby.
  const bw = Math.max(2, Math.round(fontsize / 16));
  const sh = Math.max(1, Math.round(fontsize / 22));
  const base = `fontcolor=0x${color}`;
  switch (style.template) {
    case "box":
      return `${base}:box=1:boxcolor=black@0.62:boxborderw=${Math.round(fontsize * 0.28)}`;
    case "shadow":
      return `${base}:shadowcolor=black@0.7:shadowx=${sh}:shadowy=${sh}`;
    case "pop":
      // Thicker stroke + hard drop shadow: the punchy meme/CapCut look.
      return `${base}:borderw=${Math.round(bw * 1.6)}:bordercolor=black:shadowcolor=black@0.9:shadowx=${sh + 1}:shadowy=${sh + 2}`;
    case "outline":
    default:
      return `${base}:borderw=${bw}:bordercolor=black:shadowcolor=black@0.35:shadowx=0:shadowy=${sh}`;
  }
}

// Escape user text for an UNQUOTED drawtext `text=…` value. ffmpeg parses the
// filter string in two passes (graph split on ,;[] then option split on :),
// each consuming one layer of backslash escapes — so graph-level specials get
// one backslash, option-level specials two, and a literal backslash four.
// Don't wrap the result in quotes: single-quoting breaks silently on
// apostrophes with the bundled ffmpeg 4.x (the text renders empty). Pair the
// filter with expansion=none so drawtext doesn't add a third escape layer.
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")      // literal \ → \\\\
    .replace(/'/g, "\\\\\\'")        // literal ' → \\\'
    .replace(/:/g, "\\\\:")          // option delimiter → \\:
    .replace(/([,;[\]])/g, "\\$1");  // graph delimiters → \, \; \[ \]
}

// drawtext filter for a caption centered on (xPct, yPct). Server-only (needs a font).
export function captionDrawtext(text: string, xPct: number, yPct: number, outH: number, fontPath: string, sizeMul = 1, style: TextStyle = DEFAULT_TEXT_STYLE): string {
  const esc = escapeDrawtext(text);
  const fontsize = Math.max(12, Math.round(((outH || 1920) / CAPTION_BASE_DIVISOR) * sizeMul));
  const cx = (Math.max(0, Math.min(100, xPct)) / 100).toFixed(4);
  const cy = (Math.max(0, Math.min(100, yPct)) / 100).toFixed(4);
  const font = fontfileOpt(fontPath);
  // No commas in x/y expressions, so this is safe to comma-join with other filters.
  return `drawtext=${font}expansion=none:text=${esc}:x=(w*${cx}-text_w/2):y=(h*${cy}-text_h/2):` +
    `fontsize=${fontsize}:${styleDrawOptions(style, fontsize)}`;
}

// Brand watermark — the "Vybe." wordmark in Space Grotesk Bold (the dashboard
// brand face), drawn the way a watermark should be: semi-transparent white
// with a soft shadow so it reads on any footage, plus the
// wordmark's accent period. Sits top-left, clear of the platform UI that
// covers the bottom/right of a Short/Reel/TikTok.
//
// Plain comma-joined drawtexts (no labels / extra inputs), so it slots into
// any filter chain. `boldFont` is a server file path.
// "Vybe" advance at drawtext's kerned, untracked layout, in em (measured from
// SpaceGrotesk-Bold.ttf) — places the period right after the word.
const WORDMARK_ADVANCE_EM = 2.437;
// Watermark geometry in px at a 1080 short side (scaled to the output). Shared
// with the in-app preview (auto-pilot ScheduleBuilder) so both stay identical.
// Sized to be legible on a phone screen at feed size; the leaderboard
// rewards videos that carry it, so it should actually be readable.
export const WATERMARK = {
  size: 72,          // "Vybe." wordmark font size
  x: 48,             // left inset
  topPct: 0.05,      // top of the mark, as a fraction of output height
  tagSize: 31,       // "clipped & edited" tagline
  tagGap: 16,        // gap from the wordmark baseline to the tagline
  shadow: 3,         // drop-shadow offset
  wordAlpha: 0.72,
  dotAlpha: 0.9,
  tagAlpha: 0.62,
  shadowAlpha: 0.35,
} as const;
export function watermarkGraph(outW: number, outH: number, boldFont: string): string {
  const W = WATERMARK;
  const u = Math.min(outW || 1080, outH || 1920) / 1080; // 1.0 at a 1080 short side
  const px = (n: number) => Math.max(1, Math.round(n * u));
  const size = px(W.size);
  const x = px(W.x);
  const y = Math.round((outH || 1920) * W.topPct);
  const font = fontfileOpt(boldFont);
  const shadow = `shadowcolor=black@${W.shadowAlpha}:shadowx=${px(W.shadow)}:shadowy=${px(W.shadow)}`;
  // drawtext's y is the top of each text's own box, so a lone "." would float
  // up like an apostrophe. Anchor both to one baseline via `ascent` (the
  // rendered text's height above its baseline): y = baseline - ascent.
  const baseline = y + Math.round(size * 0.95);
  const word = `drawtext=${font}expansion=none:text=Vybe:x=${x}:y=${baseline}-ascent:fontsize=${size}:fontcolor=white@${W.wordAlpha}:${shadow}`;
  const dotX = x + Math.round(size * (WORDMARK_ADVANCE_EM + 0.04));
  const dot = `drawtext=${font}expansion=none:text=.:x=${dotX}:y=${baseline}-ascent:fontsize=${size}:fontcolor=0x3EA6E6@${W.dotAlpha}:${shadow}`;
  // Tagline under the wordmark, left-aligned with it: smaller and quieter so
  // "Vybe." stays the mark. Its top sits a small gap below the wordmark's
  // baseline (plus room for descenders: drawtext's y is the box top).
  const tagSize = px(W.tagSize);
  const tagY = baseline + px(W.tagGap);
  const tag = `drawtext=${font}expansion=none:text='clipped & edited':x=${x + px(2)}:y=${tagY}:fontsize=${tagSize}:fontcolor=white@${W.tagAlpha}:${shadow}`;
  return `${word},${dot},${tag}`;
}

