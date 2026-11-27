// Shared AI virality scoring — the model SEES the clip (sampled frames +
// optional transcript) and rates its short-form viral potential 0-100 with a
// verdict, hook strength, reasons, and fixes. Used by the interactive editor
// route (/api/clips/virality) and by the Auto-Pilot engine as a final gate
// before a clip is allowed to auto-post.
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import path from "path";
import os from "os";
import { unlink, readFile } from "fs/promises";
import { resolveToTempFile } from "./storage";
import { GEMINI_MODELS, isTransient } from "./ai";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

export function viralityAvailable(): boolean {
  return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

export type TimedFrame = { data: Buffer; t: number };

export async function extractViralityFrames(videoPath: string, start: number, end: number, count = 6): Promise<TimedFrame[]> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const span = Math.max(1, end - start);
  // Weight the front — the hook lives in the first seconds.
  // Weighted to the front (hook) by default; a cut plan needs even coverage
  // to see where the payoff ends.
  const fracs = count === 6 ? [0.04, 0.12, 0.25, 0.45, 0.7, 0.92] : Array.from({ length: count }, (_, i) => (i + 0.5) / count);
  const times = fracs.map((f) => start + span * f);
  const frames: TimedFrame[] = [];
  for (let i = 0; i < times.length; i++) {
    const out = path.join(os.tmpdir(), `vybe-vir-frame-${Date.now()}-${i}.jpg`);
    try {
      await run(ffmpegPath, [
        "-ss", times[i].toFixed(2), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "6", "-y", out,
      ], { timeout: 30_000 });
      frames.push({ data: await readFile(out), t: times[i] });
    } catch { /* a missing frame isn't fatal */ }
    await unlink(out).catch(() => {});
  }
  return frames;
}

/** Small mono speech-optimized audio track for the analyzed range, or null. */
async function extractAudioTrack(videoPath: string, start: number, end: number): Promise<Buffer | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const out = path.join(os.tmpdir(), `vybe-vir-audio-${Date.now()}.mp3`);
  try {
    const args = ["-ss", Math.max(0, start).toFixed(2)];
    if (end > start) args.push("-to", end.toFixed(2));
    args.push("-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", out);
    await run(ffmpegPath, args, { timeout: 60_000 });
    return await readFile(out);
  } catch {
    return null; // silent/missing audio isn't fatal — score from frames alone
  } finally {
    await unlink(out).catch(() => {});
  }
}

export const viralitySchema = z.object({
  score: z.number().describe("Overall short-form viral potential, 0-100. Be calibrated and honest — most raw clips are 40-70; reserve 85+ for genuinely scroll-stopping moments."),
  verdict: z.string().describe("A punchy 3-6 word verdict, e.g. 'Strong hook — post it' or 'Slow start, needs trimming'."),
  hookStrength: z.number().describe("How gripping the first ~3 seconds are, 0-100 (the single biggest driver of short-form performance)."),
  reasons: z.array(z.string()).describe("2-4 short bullet reasons behind the score — what works AND what hurts. Be specific to THIS clip."),
  fixes: z.array(z.string()).describe("1-3 short, concrete edits that would raise the score (e.g. 'Trim the first 4s of setup', 'Add karaoke subtitles', 'Punch-in on the reaction'). Empty if it's already strong."),
  hookStartSec: z.number().describe("Seconds into the ANALYZED RANGE where the clip should start so it opens on the hook (skipping dead setup). 0 if it already opens on the hook. Ground this in the frame timestamps and audio; never larger than half the analyzed length."),
});

// Extra fields when the caller also wants the AI to plan the cut (Auto-Pilot):
// where the payoff ends, a post title, and on-video hook text — one call, since
// the model is already watching the frames and hearing the audio.
export const cutPlanSchema = viralitySchema.extend({
  endSec: z.number().describe("Seconds into the ANALYZED RANGE where the clip should END: right after the payoff/reaction lands (keep the laugh or punchline, cut the dead aftermath). Use the full length if the moment runs to the end."),
  title: z.string().describe("YouTube Shorts / TikTok title for this clip, 30-70 chars, about what actually happens (no hashtags, no quotes, at most one emoji, no 'You won't believe'). Use the streamer's name only if it adds recognition."),
  hookCaption: z.string().describe("Short on-video hook text shown over the first seconds, 8-36 chars, meme-literate reaction/setup — not a description. Empty string if the moment speaks for itself."),
});

export type CutPlan = { endSec: number; title: string; hookCaption: string };

export type ViralityResult = {
  score: number;
  hookStrength: number;
  verdict: string;
  reasons: string[];
  fixes: string[];
  // Seconds into the analyzed range where the hook actually starts (0 = opens
  // on it already) — lets callers trim dead setup off the front automatically.
  hookStartSec: number;
  model: string;
  usedFrames: number;
  usedAudio: boolean;
  plan?: CutPlan;   // only with planCut
};

export type ViralityClipMeta = { title: string; platform: string; duration: number; streamer: string };

function buildSystem(clip: ViralityClipMeta): string {
  return `You are a short-form virality analyst for Vybe. You are shown sampled frames (chronological, front-weighted) and the transcript of a creator/streamer clip, and you rate how likely it is to perform as a vertical short (TikTok / Reels / YouTube Shorts).

Clip: "${clip.title}" — ${clip.platform}, ${clip.streamer || "unknown creator"}, ${clip.duration.toFixed(1)}s.

Judge on what actually drives short-form: HOOK (does the first ~3s stop the scroll?), pacing/dead-air, emotional payoff or stakes, clarity of the moment, visual interest, and whether it feels complete and satisfying. Trends and relatability help. Penalize slow starts, confusing context, and low energy.

Be CALIBRATED and honest — do not inflate. Most raw clips land 40-70; 85+ is for genuinely exceptional moments. Base everything on what you can actually see and read; never invent events. Keep reasons and fixes short and specific to THIS clip.`;
}

/**
 * Score a clip's viral potential. `videoUrl` may be a server-resolvable URL or
 * local /uploads path; frames are extracted between trimStart/trimEnd (or the
 * whole duration). With `includeAudio`, the clip's audio track rides along so
 * the model hears pacing, energy, and dead air directly — use it when there's
 * no transcript (e.g. Auto-Pilot). Throws on total AI failure — callers decide
 * whether that blocks (route: surface error) or degrades (auto-pilot: skip the
 * gate).
 */
export async function scoreClipVirality(input: {
  videoUrl?: string;
  clip: ViralityClipMeta;
  transcript?: string;
  trimStart?: number;
  trimEnd?: number;
  includeAudio?: boolean;
  planCut?: boolean;
}): Promise<ViralityResult> {
  const { videoUrl, clip, transcript = "", trimStart = 0, trimEnd = 0, includeAudio = false, planCut = false } = input;

  let frames: TimedFrame[] = [];
  let audio: Buffer | null = null;
  const start = Math.max(0, trimStart);
  const end = trimEnd > trimStart ? trimEnd : (clip.duration || 30);
  const tmpPath = path.join(os.tmpdir(), `vybe-vir-${Date.now()}.mp4`);
  if (videoUrl && !videoUrl.startsWith("blob:")) {
    try {
      await resolveToTempFile(videoUrl, tmpPath);
      frames = await extractViralityFrames(tmpPath, start, end, planCut ? 10 : 6);
      if (includeAudio) audio = await extractAudioTrack(tmpPath, start, end);
    } catch { /* proceed without frames */ }
    await unlink(tmpPath).catch(() => {});
  }

  // Timestamps relative to the analyzed range, so hookStartSec is grounded.
  const frameTimes = frames.map((f) => `${(f.t - start).toFixed(1)}s`).join(", ");
  const context = [
    `Length analyzed: ${(end - start).toFixed(1)}s (times below are relative to its start).`,
    transcript ? `Transcript:\n${transcript.slice(0, 4000)}` : "No transcript available.",
    frames.length > 0 ? `${frames.length} frames are attached in chronological order, sampled at: ${frameTimes}.` : "No frames available — judge from the transcript and metadata.",
    audio ? "The clip's audio track is attached — use it to judge energy, pacing, dead air, and where the hook starts." : "",
  ].filter(Boolean).join("\n");

  let lastErr: unknown;
  for (const modelId of GEMINI_MODELS) {
    try {
      const { object } = await generateObject({
        model: google(modelId),
        schema: planCut ? cutPlanSchema : viralitySchema,
        system: buildSystem(clip),
        messages: [{
          role: "user",
          content: [
            { type: "text" as const, text: `Rate this clip's viral potential.\n\n${context}` },
            ...frames.map((f) => ({ type: "image" as const, image: f.data })),
            ...(audio ? [{ type: "file" as const, data: new Uint8Array(audio), mediaType: "audio/mp3" }] : []),
          ],
        }],
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(28_000),
      });
      const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
      const span = Math.max(1, end - start);
      const rawHookStart = Number(object.hookStartSec) || 0;
      return {
        score: clamp(object.score),
        hookStrength: clamp(object.hookStrength),
        verdict: String(object.verdict ?? "").slice(0, 80),
        reasons: (object.reasons ?? []).map((r) => String(r).slice(0, 160)).slice(0, 4),
        fixes: (object.fixes ?? []).map((f) => String(f).slice(0, 160)).slice(0, 3),
        // Never trust a hook start past half the clip — that's a re-cut, not a trim.
        hookStartSec: Math.max(0, Math.min(rawHookStart, span / 2)),
        ...(planCut ? { plan: readPlan(object as z.infer<typeof cutPlanSchema>, span) } : {}),
        model: modelId,
        usedFrames: frames.length,
        usedAudio: !!audio,
      };
    } catch (err) {
      lastErr = err;
      console.error(`[virality] ${modelId} failed:`, err instanceof Error ? err.message : err);
      if (!isTransient(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "AI request failed"));
}

function readPlan(o: z.infer<typeof cutPlanSchema>, span: number): CutPlan {
  const end = Number(o.endSec);
  const clean = (v: unknown, max: number) => String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/#\S+/g, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim()
    .slice(0, max);
  return {
    endSec: Number.isFinite(end) && end > 0 ? Math.min(end, span) : span,
    title: clean(o.title, 90),
    hookCaption: clean(o.hookCaption, 40),
  };
}
