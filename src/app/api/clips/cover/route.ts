import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { recordAsset } from "@/lib/plan";
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { unlink, readFile } from "fs/promises";
import { resolveToTempFile, storeBuffer } from "@/lib/storage";
import { GEMINI_MODELS, isTransient, aiFailure } from "@/lib/ai";
import { escapeDrawtext, styleDrawOptions, DEFAULT_TEXT_STYLE, TEXT_FONTS, fontfileOpt } from "@/lib/clip-filters";

// AI cover/thumbnail generator: the model SEES sampled frames + the transcript,
// picks the single most scroll-stopping frame for a vertical cover, and writes a
// few punchy hook-text options. The server then renders a 1080×1920 cover with
// the chosen hook burned on (impact-style, heavy outline) — the still that wins
// the click on TikTok / Reels / Shorts. Two modes:
//   • analyze  — no `hook` given: AI picks the frame + writes hooks, renders #1.
//   • re-render — `hook` (and `frameTime`) given: skip the model, just re-render.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

export const maxDuration = 120;

const OUT_W = 1080;
const OUT_H = 1920;

// Covers use the bundled "impact" style font (Anton) — the bold, condensed
// look short-form covers use — so they look the same on every host.
function coverFont(): string {
  const p = path.join(process.cwd(), "public", "fonts", TEXT_FONTS.impact.file);
  return existsSync(p) ? p : "";
}

// Evenly spread candidate timestamps across the analyzed span, skipping the very
// first/last beats (usually transitions or mid-blink). Returns ~`n` times.
function candidateTimes(start: number, end: number, n = 8): number[] {
  const span = Math.max(1, end - start);
  return Array.from({ length: n }, (_, i) => start + span * (0.06 + (0.88 * i) / (n - 1)));
}

async function extractFrame(videoPath: string, t: number, scale: number): Promise<Buffer | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const out = path.join(os.tmpdir(), `vybe-cov-${Date.now()}-${Math.round(t * 1000)}.jpg`);
  try {
    await run(ffmpegPath, [
      "-ss", t.toFixed(2), "-i", videoPath,
      "-frames:v", "1", "-vf", `scale=${scale}:-2`, "-q:v", "5", "-y", out,
    ], { timeout: 30_000 });
    const buf = await readFile(out);
    return buf;
  } catch {
    return null;
  } finally {
    await unlink(out).catch(() => {});
  }
}

// Greedily wrap a hook into up to 3 short lines (cover text reads best big and
// stacked). Returns uppercase lines for punch.
function wrapHook(hook: string): string[] {
  const words = hook.toUpperCase().replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) > 16) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
    if (lines.length === 2 && (cur.length + 1) > 16) break; // 3rd line forming — stop wrapping
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

// Build the ffmpeg -vf chain: cover-fit to 1080×1920, then stacked centered
// drawtext lines with a heavy "pop" outline so the text reads on any frame.
function buildFilter(hook: string, font: string): string {
  const lines = wrapHook(hook);
  const maxLen = Math.max(8, ...lines.map((l) => l.length));
  // ~0.55 glyph-width ratio for the bold font; keep the longest line within 90%.
  const fontsize = Math.max(64, Math.min(150, Math.round((OUT_W * 0.9) / (0.55 * maxLen))));
  const lineH = Math.round(fontsize * 1.18);
  const startY = Math.round(OUT_H * 0.15);
  const fontOpt = fontfileOpt(font);
  const style = styleDrawOptions({ ...DEFAULT_TEXT_STYLE, font: "impact", template: "pop" }, fontsize);

  const draws = lines.map((line, i) => {
    const esc = escapeDrawtext(line);
    const y = startY + i * lineH;
    return `drawtext=${fontOpt}expansion=none:text=${esc}:x=(w-text_w)/2:y=${y}:fontsize=${fontsize}:${style}`;
  });

  return [
    `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase`,
    `crop=${OUT_W}:${OUT_H}`,
    ...draws,
  ].join(",");
}

async function renderCover(videoPath: string, t: number, hook: string): Promise<string> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const out = path.join(os.tmpdir(), `vybe-cover-out-${Date.now()}.jpg`);
  try {
    await run(ffmpegPath, [
      "-ss", t.toFixed(2), "-i", videoPath,
      "-frames:v", "1", "-vf", buildFilter(hook, coverFont()), "-q:v", "2", "-y", out,
    ], { timeout: 45_000 });
    const buf = await readFile(out);
    return storeBuffer(buf, `vybe-cover-${Date.now()}.jpg`, "image/jpeg");
  } finally {
    await unlink(out).catch(() => {});
  }
}

const coverSchema = z.object({
  bestFrame: z.number().int().describe("0-based index of the single most scroll-stopping frame for a cover — peak emotion, a clear expressive face, or dramatic action. Strongly prefer a clear human face/reaction over empty scenery or transitions."),
  hooks: z.array(z.string()).describe("Exactly 3 short, punchy cover-text hooks. Each ≤ 6 words / ~28 characters. Use curiosity, stakes, shock, or emotion. NO hashtags, NO quotes, NO emojis, NO trailing punctuation. Specific to THIS clip — never generic."),
  reason: z.string().describe("One short sentence on why the chosen frame works as a cover."),
});

function buildSystem(clip: { title: string; platform: string; duration: number; streamer: string }, nFrames: number): string {
  return `You design vertical cover images (thumbnails) for short-form video on Vybe. You are shown ${nFrames} sampled frames in chronological order (index 0 first) and the transcript of a creator/streamer clip. Pick the single best frame to stop the scroll, and write the cover text.

Clip: "${clip.title}" — ${clip.platform}, ${clip.streamer || "unknown creator"}, ${clip.duration.toFixed(1)}s.

A great cover frame shows a clear, expressive human face or a dramatic peak moment — not a blurry transition, a blink, an empty room, or a loading screen. A great hook is short, big-text-friendly, and creates an open loop (curiosity, stakes, or strong emotion). Base everything on what you can actually see and read; never invent events.`;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return NextResponse.json(
      { error: "AI isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart." },
      { status: 500 },
    );
  }

  const { videoUrl, clip, transcript = "", trimStart = 0, trimEnd = 0, hook, frameTime } =
    (await req.json()) as {
      videoUrl?: string;
      clip?: { title: string; platform: string; duration: number; streamer: string };
      transcript?: string;
      trimStart?: number;
      trimEnd?: number;
      hook?: string;       // re-render mode: render this exact hook
      frameTime?: number;  // re-render mode: at this exact source timestamp
    };

  if (!clip) return NextResponse.json({ error: "Missing clip" }, { status: 400 });
  if (!videoUrl || videoUrl.startsWith("blob:")) {
    return NextResponse.json({ error: "A cover needs the saved clip video. Save the clip first." }, { status: 400 });
  }

  const start = Math.max(0, trimStart);
  const end = trimEnd > trimStart ? trimEnd : (clip.duration || 30);

  const tmpPath = path.join(os.tmpdir(), `vybe-cover-src-${Date.now()}.mp4`);
  try {
    await resolveToTempFile(videoUrl, tmpPath);
  } catch {
    await unlink(tmpPath).catch(() => {});
    return NextResponse.json({ error: "Couldn't load the clip video for a cover." }, { status: 502 });
  }

  try {
    // ── Re-render mode: caller already chose a hook (and frame). Skip the model. ──
    if (typeof hook === "string" && hook.trim()) {
      const t = typeof frameTime === "number" && frameTime >= 0 ? frameTime : (start + end) / 2;
      const url = await renderCover(tmpPath, t, hook.trim().slice(0, 80));
      await recordAsset(session.userId, url);
      return NextResponse.json({ url, chosenHook: hook.trim().slice(0, 80), frameTime: t });
    }

    // ── Analyze mode: sample frames, let the model pick the frame + write hooks. ──
    const times = candidateTimes(start, end);
    const frames: { t: number; buf: Buffer }[] = [];
    for (const t of times) {
      const buf = await extractFrame(tmpPath, t, 512);
      if (buf) frames.push({ t, buf });
    }
    if (frames.length === 0) {
      return NextResponse.json({ error: "Couldn't read frames from this clip." }, { status: 502 });
    }

    const context = [
      `Length analyzed: ${start.toFixed(1)}s → ${end.toFixed(1)}s`,
      transcript ? `Transcript:\n${transcript.slice(0, 4000)}` : "No transcript available.",
      `${frames.length} frames attached in chronological order (index 0 first).`,
    ].join("\n");

    let lastErr: unknown;
    for (const modelId of GEMINI_MODELS) {
      try {
        const { object } = await generateObject({
          model: google(modelId),
          schema: coverSchema,
          system: buildSystem(clip, frames.length),
          messages: [{
            role: "user",
            content: [
              { type: "text" as const, text: `Pick the best cover frame and write the hooks.\n\n${context}` },
              ...frames.map((f) => ({ type: "image" as const, image: f.buf })),
            ],
          }],
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(30_000),
        });

        const idx = Math.max(0, Math.min(frames.length - 1, Math.round(object.bestFrame)));
        const hooks = (object.hooks ?? [])
          .map((h) => String(h).replace(/["']/g, "").trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 3);
        const chosenHook = hooks[0] ?? clip.title.slice(0, 40);
        const frameT = frames[idx].t;
        const url = await renderCover(tmpPath, frameT, chosenHook);
        await recordAsset(session.userId, url);

        return NextResponse.json({
          url,
          hooks,
          chosenHook,
          frameTime: frameT,
          reason: String(object.reason ?? "").slice(0, 160),
          model: modelId,
        });
      } catch (err) {
        lastErr = err;
        console.error(`[cover] ${modelId} failed:`, err instanceof Error ? err.message : err);
        if (!isTransient(err)) break;
      }
    }

    const fail = aiFailure(lastErr);
    return NextResponse.json({ error: fail.error }, { status: fail.status });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
