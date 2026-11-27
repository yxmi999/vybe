import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import path from "path";
import os from "os";
import { unlink, readFile } from "fs/promises";
import { resolveToTempFile } from "@/lib/storage";
import { GEMINI_MODELS, isTransient, aiFailure } from "@/lib/ai";
import { ASPECTS, cropWindow, type AspectKey } from "@/lib/clip-filters";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

export const runtime = "nodejs";
export const maxDuration = 120;

// Auto face-tracking reframe. We sample frames across the clip, ask the model
// where the main speaker/subject sits horizontally in each, then emit motion-crop
// keyframes that keep them centered in a vertical frame. The output is the SAME
// `cropKeys` shape the manual motion-crop produces, so it renders, previews and
// undoes through the existing pipeline — no special-casing downstream.

const MAX_FRAMES = 12;

async function extractFrames(videoPath: string, start: number, span: number, n: number): Promise<{ t: number; buf: Buffer }[]> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const out: { t: number; buf: Buffer }[] = [];
  for (let i = 0; i < n; i++) {
    // Sample at frame centers so the first/last aren't exactly on a cut.
    const t = start + span * ((i + 0.5) / n);
    const file = path.join(os.tmpdir(), `vybe-reframe-${Date.now()}-${i}.jpg`);
    try {
      await run(ffmpegPath, [
        "-ss", t.toFixed(2), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=448:-2", "-q:v", "6", "-y", file,
      ], { timeout: 30_000 });
      out.push({ t, buf: await readFile(file) });
    } catch { /* a missing frame just becomes a gap the pan eases over */ }
    await unlink(file).catch(() => {});
  }
  return out;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return NextResponse.json(
      { error: "AI reframing isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart." },
      { status: 500 },
    );
  }

  const body = await req.json() as {
    videoUrl?: string;
    srcW?: number; srcH?: number;
    duration?: number; trimStart?: number; trimEnd?: number;
    cropAspect?: string;
  };
  const videoUrl = body.videoUrl;
  if (!videoUrl) return NextResponse.json({ error: "Missing videoUrl" }, { status: 400 });
  if (videoUrl.startsWith("blob:")) {
    return NextResponse.json(
      { error: "Auto-reframe needs the uploaded video on the server. Re-import or save the clip first, then try again." },
      { status: 422 },
    );
  }

  const srcW = Math.max(2, Number(body.srcW) || 1280);
  const srcH = Math.max(2, Number(body.srcH) || 720);
  const aspect: AspectKey = (body.cropAspect && body.cropAspect in ASPECTS && body.cropAspect !== "original")
    ? body.cropAspect as AspectKey : "9:16";

  // How much horizontal room the crop window has to travel. No room (portrait
  // source, or already-narrow) → tracking can't pan, so don't bother.
  const ar = ASPECTS[aspect].ar!;
  const { cw } = cropWindow(ar, srcW, srcH);
  const x0 = Math.max(0, srcW - cw);
  if (x0 < 2) {
    return NextResponse.json({
      error: "This video is already as narrow as the target frame — there's nothing to pan across. Just pick the aspect ratio.",
    }, { status: 422 });
  }
  // Subject center (0..1 of source width) → motion-crop keyframe value (0..100).
  const subjectToCropX = (sPct: number) => clamp01((clamp01(sPct / 100) * srcW - cw / 2) / x0) * 100;

  const dur = (body.duration && body.duration > 0) ? body.duration : 60;
  const start = Math.max(0, Number(body.trimStart) || 0);
  const end = (body.trimEnd && body.trimEnd > start) ? body.trimEnd : dur;
  const span = Math.max(0.5, end - start);
  const n = Math.max(3, Math.min(MAX_FRAMES, Math.round(span / 2.5) + 2));

  const tmpPath = path.join(os.tmpdir(), `vybe-reframe-src-${Date.now()}.mp4`);
  let frames: { t: number; buf: Buffer }[] = [];
  try {
    await resolveToTempFile(videoUrl, tmpPath);
    frames = await extractFrames(tmpPath, start, span, n);
  } catch {
    await unlink(tmpPath).catch(() => {});
    return NextResponse.json({ error: "Couldn't read the video to analyze it. Try re-importing the clip." }, { status: 422 });
  }
  await unlink(tmpPath).catch(() => {});

  if (frames.length < 2) {
    return NextResponse.json({ error: "Couldn't sample enough frames to track the subject." }, { status: 422 });
  }

  const schema = z.object({
    points: z.array(z.object({
      i: z.number().int().describe("0-based index of the frame this refers to"),
      x: z.number().min(0).max(100).describe("horizontal center of the main subject, 0=left edge, 50=middle, 100=right edge"),
      present: z.boolean().describe("true if a clear main subject/speaker is visible in this frame"),
    })),
  });

  const system = `You are an auto-reframe vision system for short-form video. You are given ${frames.length} frames sampled in chronological order from a landscape clip that will be cropped to a vertical ${aspect} frame. For EACH frame, locate the MAIN SUBJECT — the person speaking or the focal action the viewer should follow — and report the horizontal center of their face/body as a percentage of the frame width (0 = left edge, 50 = middle, 100 = right edge).

Rules:
- Return exactly one point per frame, with i = the frame's index (0..${frames.length - 1}).
- Track the SAME subject across frames so the crop follows them smoothly; don't jump to a different person unless the focus clearly shifts.
- If a frame has no clear single subject (wide shot, gameplay only, transition), set present=false and put x at your best guess (or 50).
- Estimate the FACE position when a face is visible; otherwise the torso/body center.
Be precise and consistent — small horizontal errors cause visible jitter.`;

  let lastErr: unknown;
  for (const modelId of GEMINI_MODELS) {
    try {
      const { object } = await generateObject({
        model: google(modelId),
        schema,
        system,
        messages: [{
          role: "user",
          content: [
            { type: "text" as const, text: `Locate the main subject's horizontal position in each of these ${frames.length} frames (index 0 first).` },
            ...frames.map((f) => ({ type: "image" as const, image: f.buf })),
          ],
        }],
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(40_000),
      });

      // Map model points back to frame times by index; keep only confident ones.
      const byIndex = new Map<number, { x: number; present: boolean }>();
      for (const p of object.points) {
        if (p.i >= 0 && p.i < frames.length) byIndex.set(p.i, { x: p.x, present: p.present });
      }
      const raw: { t: number; x: number }[] = [];
      for (let i = 0; i < frames.length; i++) {
        const p = byIndex.get(i);
        if (p && p.present) raw.push({ t: frames[i].t, x: subjectToCropX(p.x) });
      }
      if (raw.length < 2) {
        return NextResponse.json({
          error: "Couldn't lock onto a subject to follow (no clear speaker across the clip). Crop manually for this one.",
        }, { status: 422 });
      }

      // Light 3-tap smoothing to kill per-frame estimate jitter.
      const smoothed = raw.map((pt, i) => {
        const a = raw[Math.max(0, i - 1)].x, b = pt.x, c = raw[Math.min(raw.length - 1, i + 1)].x;
        return { t: pt.t, x: (a + 2 * b + c) / 4 };
      });

      // Collapse near-static stretches into endpoints so we ship a handful of
      // keyframes, not one per frame. First and last are always kept.
      const keys: { time: number; x: number }[] = [];
      for (let i = 0; i < smoothed.length; i++) {
        const pt = smoothed[i];
        if (i === 0 || i === smoothed.length - 1) { keys.push({ time: pt.t, x: pt.x }); continue; }
        if (Math.abs(pt.x - keys[keys.length - 1].x) >= 4) keys.push({ time: pt.t, x: pt.x });
      }
      const cropKeys = keys.map((k) => ({ time: Number(k.time.toFixed(2)), x: Math.round(k.x) }));

      return NextResponse.json({
        cropAspect: aspect,
        cropFill: "crop",
        cropSmooth: false,
        cropKeys,
        cropX: cropKeys[0].x,
        framesAnalyzed: frames.length,
        tracked: raw.length,
        model: modelId,
      });
    } catch (err) {
      lastErr = err;
      console.error(`[reframe] ${modelId} failed:`, err instanceof Error ? err.message : err);
      if (!isTransient(err)) break;
    }
  }

  const fail = aiFailure(lastErr);
  return NextResponse.json({ error: fail.error }, { status: fail.status });
}
