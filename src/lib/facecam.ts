// Facecam detection: find the streamer's webcam overlay in a stream frame
// with Gemini's object detection (it returns boxes as [ymin, xmin, ymax, xmax]
// normalised to 0–1000), then snap the AI's approximate box onto the overlay's
// real pixel edges. Server-only.
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import path from "path";
import os from "os";
import { readFile, unlink } from "fs/promises";
import { GEMINI_MODELS, isTransient } from "./ai";
import { resolveToTempFile } from "./storage";
import type { FacecamBox } from "./clip-filters";

export type FacecamResult =
  | { found: true; box: FacecamBox; refined?: boolean }
  | { found: false; reason: "no_camera" | "full_camera" | "unavailable" };

const schema = z.object({
  kind: z.enum(["overlay", "full_camera", "none"]).describe(
    "'overlay' = a webcam inset showing the streamer on top of other content (gameplay, desktop…); " +
    "'full_camera' = the whole frame IS the camera (just chatting / IRL, no separate overlay); 'none' = no person on camera.",
  ),
  box_2d: z.array(z.number()).describe(
    "For 'overlay': the webcam inset's full rectangle as [ymin, xmin, ymax, xmax], each normalised 0–1000. Empty array otherwise.",
  ),
});

const PROMPT =
  "This is a frame from a livestream. Find the streamer's webcam (facecam) feed: a rectangular inset of LIVE CAMERA " +
  "video showing a real person, usually in a corner, layered over gameplay or a desktop. Return a TIGHT box around just " +
  "that camera feed (include its border/frame if it has one). Do NOT include anything next to it: chat boxes, text " +
  "widgets, alerts, donation/sub goals, logos, timers or game HUD — these often sit right above or below the camera, " +
  "so stop the box where the camera picture ends. Ignore game characters and avatars. If the entire frame is the " +
  "camera, answer 'full_camera'. If there is no person on camera, answer 'none'.";

export function facecamAvailable() {
  return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

/** Detect the facecam overlay in one image. */
export async function detectFacecamInImage(image: Buffer | Uint8Array): Promise<FacecamResult> {
  if (!facecamAvailable()) return { found: false, reason: "unavailable" };
  let lastErr: unknown;
  for (const model of GEMINI_MODELS) {
    try {
      const { object } = await generateObject({
        model: google(model),
        schema,
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image", image }] }],
        temperature: 0,
        // A stalled connection must not hang an unattended Auto-Pilot run.
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(25_000),
      });
      if (object.kind !== "overlay" || object.box_2d.length !== 4) {
        return { found: false, reason: object.kind === "full_camera" ? "full_camera" : "no_camera" };
      }
      const [ymin, xmin, ymax, xmax] = object.box_2d.map((v) => Math.max(0, Math.min(1000, v)) / 1000);
      const box = { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
      // A real overlay is a modest inset — reject slivers and near-full-frame boxes.
      if (box.w < 0.04 || box.h < 0.04 || box.w > 0.75 || box.h > 0.75) return { found: false, reason: "no_camera" };
      return { found: true, box };
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Facecam detection failed");
}

// ─── Pixel edge snapping ─────────────────────────────────────────────────────
//
// The AI's box is roughly right but routinely a few percent off (it bleeds
// into a neighbouring chat widget, or stops short of the frame border), and
// at a 3–4× panel zoom a 2% miss is very visible: a strip of gameplay along
// the edge of the cam screen. A webcam overlay, though, has hard straight
// edges that stay put while the content on both sides moves. So for each
// side of the AI box we search nearby lines for the one whose gradient is
// strong along most of its length in EVERY sampled frame (min over frames —
// a gameplay edge that lines up in one frame won't in the others), and snap
// to it when it's clearly a real border.

type Gray = { data: Uint8Array; w: number; h: number };

const REF_W = 640, REF_H = 360;  // analysis resolution (16:9 source → exact)
const EDGE_GRAD = 18;            // luma step that counts as an edge pixel
const EDGE_MIN_COVERAGE = 0.6;   // mean edge fraction of the side's length that's always accepted
const EDGE_MIN_MEAN = 0.3;       // below this, never an edge
const EDGE_MIN_FRAME = 0.2;      // …and it must show in EVERY frame (static overlay, moving content)
const EDGE_PEAK_RATIO = 2.5;     // a faint line must beat every other line nearby by this much
const SEARCH = 0.07;             // search ± this fraction of the frame around each AI edge
const BORDER_SNAP = 0.012;       // AI edge this close to the frame border → snap to the border

/** Fraction of the line (vertical at column x, or horizontal at row y) that is a strong edge, over [a,b). */
function lineCoverage(g: Gray, vertical: boolean, pos: number, a: number, b: number): number {
  const { data, w } = g;
  let hits = 0, n = 0;
  for (let i = a; i < b; i++) {
    const at = (k: number) => (vertical ? data[i * w + pos + k] : data[(pos + k) * w + i]);
    const l = at(-1), c = at(0), r = at(1);
    // A step across 2px (catches an anti-aliased edge between two regions)
    // OR a ridge — a 1px border line brighter/darker than BOTH sides, which
    // a pure step test misses entirely (both sides of the line look alike).
    const step = Math.abs(l - r);
    const ridge = Math.min(Math.abs(c - l), Math.abs(c - r));
    if (Math.max(step, ridge) >= EDGE_GRAD) hits++;
    n++;
  }
  return n ? hits / n : 0;
}

/**
 * Snap each side of `box` (fractions) to the strongest persistent straight
 * edge near it. Sides at the frame border snap to the border. Returns the
 * refined box, or null if no side could be confirmed (keep the AI box).
 */
export function refineBoxToEdges(frames: Gray[], box: FacecamBox): { box: FacecamBox; snapped: number; confirmed: boolean } | null {
  if (frames.length === 0) return null;
  const { w: W, h: H } = frames[0];
  let x0 = box.x * W, x1 = (box.x + box.w) * W, y0 = box.y * H, y1 = (box.y + box.h) * H;
  let snapped = 0;
  // Sides away from the frame border, and how many of them found a real edge.
  let inner = 0, innerSnapped = 0;

  const best = (vertical: boolean, center: number, along0: number, along1: number, limit: number): number | null => {
    // Measure along the inner 70% of the side so corners (rounded frames,
    // a neighbouring widget touching the corner) don't dilute the line.
    const span = along1 - along0;
    const a = Math.max(1, Math.round(along0 + span * 0.15));
    const b = Math.min((vertical ? H : W) - 1, Math.round(along1 - span * 0.15));
    if (b - a < 8) return null;
    const r = Math.round(SEARCH * (vertical ? W : H));
    const lo = Math.max(2, Math.round(center) - r), hi = Math.min(limit - 3, Math.round(center) + r);
    if (hi < lo) return null;
    // Per candidate line: mean and weakest-frame coverage across frames.
    const mean: number[] = [], min: number[] = [];
    for (let p = lo; p <= hi; p++) {
      let s = 0, m = Infinity;
      for (const f of frames) { const c = lineCoverage(f, vertical, p, a, b); s += c; m = Math.min(m, c); }
      mean.push(s / frames.length); min.push(m);
    }
    let bestI = -1, bestScore = -Infinity;
    for (let i = 0; i < mean.length; i++) {
      // Present in every frame (persistent), and either a strong line or a
      // clear peak over everything else nearby — an overlay border against
      // similar-toned content (dark hoodie over dark gameplay) is faint but
      // still the sharpest line around.
      if (min[i] < EDGE_MIN_FRAME || mean[i] < EDGE_MIN_MEAN) continue;
      // Mild preference for staying close to the AI's answer when two lines tie.
      const score = mean[i] - Math.abs(lo + i - center) / (r * 20);
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    if (bestI < 0) return null;
    if (mean[bestI] < EDGE_MIN_COVERAGE) {
      let rival = 0;
      for (let i = 0; i < mean.length; i++) if (Math.abs(i - bestI) > 3) rival = Math.max(rival, mean[i]);
      if (mean[bestI] < rival * EDGE_PEAK_RATIO) return null;
    }
    return lo + bestI;
  };

  // Frame-border sides first (most cams sit flush in a corner).
  if (box.x < BORDER_SNAP) { x0 = 0; snapped++; }
  if (box.x + box.w > 1 - BORDER_SNAP) { x1 = W; snapped++; }
  if (box.y < BORDER_SNAP) { y0 = 0; snapped++; }
  if (box.y + box.h > 1 - BORDER_SNAP) { y1 = H; snapped++; }

  // Then the inner sides, each measured along the (current) extent of the box.
  if (x0 > 0) { inner++; const p = best(true, x0, y0, y1, W); if (p != null) { x0 = p; snapped++; innerSnapped++; } }
  if (x1 < W) { inner++; const p = best(true, x1, y0, y1, W); if (p != null) { x1 = p; snapped++; innerSnapped++; } }
  if (y0 > 0) { inner++; const p = best(false, y0, x0, x1, H); if (p != null) { y0 = p; snapped++; innerSnapped++; } }
  if (y1 < H) { inner++; const p = best(false, y1, x0, x1, H); if (p != null) { y1 = p; snapped++; innerSnapped++; } }

  const out = { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
  // Sanity: refinement may tighten/loosen, never reshape the box wildly.
  if (out.w < box.w * 0.6 || out.h < box.h * 0.6 || out.w > box.w * 1.5 || out.h > box.h * 1.5) return null;
  if (out.w < 0.04 || out.h < 0.04) return null;
  // confirmed: every side of the overlay is accounted for in the pixels
  // (frame border, or a real persistent edge) — strong enough to trust the
  // box without (or with only one) AI vote.
  return snapped > 0 ? { box: out, snapped, confirmed: inner > 0 && innerSnapped === inner } : null;
}

/**
 * Letterbox detection: rows of the source that are persistently black across
 * the centre of the frame in every sampled frame (cinematic cutscenes, games
 * running at a wider aspect). Measured on the middle 40% of columns so chat /
 * cam overlays drawn over the bars at the sides don't count as content.
 * Returns the content band as fractions of the frame height.
 */
export function detectContentRows(frames: Gray[]): { top: number; bottom: number } {
  if (frames.length === 0) return { top: 0, bottom: 1 };
  const { w: W, h: H } = frames[0];
  const a = Math.round(W * 0.3), b = Math.round(W * 0.7);
  const dark = (y: number) => frames.every((f) => {
    let n = 0;
    for (let x = a; x < b; x++) if (f.data[y * W + x] > 24) n++;
    return n / (b - a) < 0.02;
  });
  let top = 0;
  while (top < H * 0.2 && dark(top)) top++;
  let bottom = H;
  while (bottom > H * 0.8 && dark(bottom - 1)) bottom--;
  // Ignore a 1–2px sliver (encoder edge noise) — only real bars matter.
  return { top: top >= 3 ? top / H : 0, bottom: H - bottom >= 3 ? bottom / H : 1 };
}

const iou = (a: FacecamBox, b: FacecamBox) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

/**
 * Detect the facecam in a server-resolvable video around `t` seconds. One AI
 * look varies frame to frame (e.g. an attached chat box sometimes gets
 * included), so three frames spread around `t` are checked in parallel, the
 * per-edge MEDIAN box wins (outliers that don't overlap it are dropped) — at
 * least two agreeing detections are required — and the result is snapped to
 * the overlay's real pixel edges.
 */
export type VideoFacecamResult = FacecamResult & { content?: { top: number; bottom: number }; viaHint?: boolean };
export async function detectFacecamInVideo(videoUrl: string, t: number, hint?: FacecamBox): Promise<VideoFacecamResult> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const src = path.join(os.tmpdir(), `vybe-fc-${id}.mp4`);
  const times = [t - 8, t - 4, t, t + 4, t + 8].map((x) => Math.max(0, x));
  const jpgs = times.map((_, i) => path.join(os.tmpdir(), `vybe-fc-${id}-${i}.jpg`));
  const raws = times.map((_, i) => path.join(os.tmpdir(), `vybe-fc-${id}-${i}.gray`));
  try {
    await resolveToTempFile(videoUrl, src);
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(execFile);
    const grays: (Gray | null)[] = times.map(() => null);
    const aiErrors: unknown[] = [];
    const results = await Promise.all(times.map(async (tt, i) => {
      try {
        await run(ffmpegInstaller.path, [
          "-hide_banner", "-loglevel", "error", "-ss", tt.toFixed(2), "-i", src,
          "-frames:v", "1", "-filter_complex", `[0:v]split=2[a][b];[a]scale=1280:-2[j];[b]scale=${REF_W}:${REF_H},format=gray[g]`,
          "-map", "[j]", "-q:v", "3", "-y", jpgs[i],
          // -frames:v is per-output: without repeating it the raw output
          // dumps every frame to the end of the section (hundreds of MB).
          "-map", "[g]", "-frames:v", "1", "-f", "rawvideo", "-y", raws[i],
        ], { timeout: 30_000 });
        const g = await readFile(raws[i]).catch(() => null);
        if (g && g.length === REF_W * REF_H) grays[i] = { data: new Uint8Array(g), w: REF_W, h: REF_H };
      } catch {
        return null; // a missing frame (e.g. past the end) just doesn't vote
      }
      // AI looks at 3 of the 5 frames (free-tier per-minute limits are tight
      // and edge snapping does the fine work); all 5 feed the pixel analysis.
      if (i % 2 === 1) return undefined;
      try {
        return await detectFacecamInImage(await readFile(jpgs[i]));
      } catch (err) {
        aiErrors.push(err);
        return null;
      }
    }));
    // Looks that errored (rate limit, overloaded model) get one more try,
    // one at a time so the retry doesn't hit the same per-minute wall.
    for (let i = 0; i < results.length; i++) {
      if (results[i] !== null || i % 2 === 1) continue;
      try { results[i] = await detectFacecamInImage(await readFile(jpgs[i])); } catch { /* still no vote */ }
    }
    return voteFacecam(results, grays.filter((g): g is Gray => !!g), aiErrors, hint);
  } finally {
    await unlink(src).catch(() => {});
    await Promise.all([...jpgs, ...raws].map((j) => unlink(j).catch(() => {})));
  }
}

/**
 * Combine per-frame AI looks (null = errored, undefined = not asked) with the
 * pixel analysis of every frame into one answer. Shared by the Auto-Pilot
 * (frames pulled from a video file) and the editor (frames grabbed in the
 * browser and uploaded).
 */
function voteFacecam(
  results: (FacecamResult | null | undefined)[], frames: Gray[], aiErrors: unknown[], hint?: FacecamBox,
): VideoFacecamResult {
    const content = detectContentRows(frames);
    // Every AI look failed (quota, outage): that is NOT "no camera". With a
    // hint (where the cam was framed before) the pixels alone can still
    // confirm it — a real overlay's edges are there whether or not the AI
    // is. Otherwise throw so the caller fails open and keeps its framing.
    if (aiErrors.length > 0 && results.every((r) => r == null)) {
      const r = hint ? refineBoxToEdges(frames, hint) : null;
      if (r?.confirmed) return { found: true, box: r.box, refined: true, content, viaHint: true };
      throw aiErrors[0];
    }
    let boxes = results.flatMap((r) => (r?.found ? [r.box] : []));
    const answered = results.filter((r) => r != null).length;
    const full = results.filter((r) => r && !r.found && r.reason === "full_camera").length;
    // Normally two agreeing looks are required. A lone detection is accepted
    // only when it's the ONLY answer we got (the other looks errored, they
    // didn't disagree) and the overlay's edges are confirmed in the pixels.
    if (boxes.length === 1 && answered === 1) {
      const r = refineBoxToEdges(frames, boxes[0]);
      if (r?.confirmed) return { found: true, box: r.box, refined: true, content };
    }
    if (boxes.length < 2 || full > boxes.length) {
      return { found: false, reason: full >= 2 ? "full_camera" : "no_camera", content };
    }
    const med = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); return a[Math.floor((a.length - 1) / 2)]; };
    const median = (bs: FacecamBox[]): FacecamBox => {
      const x0 = med(bs.map((b) => b.x)), y0 = med(bs.map((b) => b.y));
      const x1 = med(bs.map((b) => b.x + b.w)), y1 = med(bs.map((b) => b.y + b.h));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    // Drop detections of some other rectangle (e.g. one frame picked a chat box).
    const first = median(boxes);
    const agreeing = boxes.filter((b) => iou(b, first) >= 0.5);
    if (agreeing.length >= 2) boxes = agreeing;
    const box = median(boxes);

    const refined = refineBoxToEdges(frames, box);
    return refined ? { found: true, box: refined.box, refined: true, content } : { found: true, box, content };
}

/**
 * Editor path: several JPEG frames grabbed around the playhead in the
 * browser. Same voting + pixel edge-snapping as detectFacecamInVideo, so the
 * box lands on the overlay's real borders instead of the AI's rough guess.
 * With a single frame there's nothing to vote with — that look is trusted,
 * and still snapped to the edges.
 */
export async function detectFacecamInFrames(jpegs: Buffer[]): Promise<VideoFacecamResult> {
  if (!facecamAvailable()) return { found: false, reason: "unavailable" };
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const files = jpegs.map((_, i) => path.join(os.tmpdir(), `vybe-fcf-${id}-${i}.jpg`));
  const raws = jpegs.map((_, i) => path.join(os.tmpdir(), `vybe-fcf-${id}-${i}.gray`));
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(execFile);
    const { writeFile } = await import("fs/promises");
    const grays: (Gray | null)[] = jpegs.map(() => null);
    const aiErrors: unknown[] = [];
    // AI looks at up to 3 frames spread across the set; all feed the pixels.
    const ask = new Set(jpegs.length <= 3 ? jpegs.map((_, i) => i) : [0, Math.floor(jpegs.length / 2), jpegs.length - 1]);
    const results = await Promise.all(jpegs.map(async (jpg, i) => {
      try {
        await writeFile(files[i], jpg);
        await run(ffmpegInstaller.path, [
          "-hide_banner", "-loglevel", "error", "-i", files[i],
          "-vf", `scale=${REF_W}:${REF_H},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-y", raws[i],
        ], { timeout: 20_000 });
        const g = await readFile(raws[i]).catch(() => null);
        if (g && g.length === REF_W * REF_H) grays[i] = { data: new Uint8Array(g), w: REF_W, h: REF_H };
      } catch { /* this frame just doesn't feed the pixel analysis */ }
      if (!ask.has(i)) return undefined;
      try { return await detectFacecamInImage(jpg); } catch (err) { aiErrors.push(err); return null; }
    }));
    const frames = grays.filter((g): g is Gray => !!g);
    const looks = results.filter((r): r is FacecamResult => r != null);
    if (looks.length === 1) {
      // One answer (single frame sent, or the other looks errored): trust it,
      // snapped to the edges when the pixels confirm them.
      const only = looks[0];
      if (!only.found) return { ...only, content: detectContentRows(frames) };
      const r = refineBoxToEdges(frames, only.box);
      return { found: true, box: r ? r.box : only.box, refined: !!r, content: detectContentRows(frames) };
    }
    return voteFacecam(results, frames, aiErrors);
  } finally {
    await Promise.all([...files, ...raws].map((f) => unlink(f).catch(() => {})));
  }
}
