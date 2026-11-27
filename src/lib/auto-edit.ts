import path from "path";
import os from "os";
import { unlink, readFile } from "fs/promises";
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import { resolveToTempFile } from "./storage";
import { GEMINI_MODELS, isTransient, aiFailure } from "./ai";
import { editSchema, type ClipEdits } from "./clip-edit-schema";
import { enforceStyle, styleToPrompt, type ClipStyle, type StyleExtras } from "./clip-style";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

// Core of one-click Auto-edit, shared by the editor route (/api/clips/auto-edit)
// and the batch paths (Schedule a week, Auto-Pilot) that now produce fully
// edited clips. The model WATCHES the clip (a compressed proxy with audio —
// Gemini ingests video natively) and returns a complete timed edit plan; an
// optional ClipStyle steers the plan and then pins the look.

// Gemini samples video at ~1 fps, so a low-fps, low-res proxy loses nothing the
// model would use — it just keeps the upload small. Audio stays (mono AAC):
// hearing the moment is how the model finds the hook and the payoff beat.
const PROXY_MAX_BYTES = 18 * 1024 * 1024; // stay under Gemini's inline limit

export async function makeVideoProxy(videoPath: string, start: number, end: number, opts: { height?: number; fps?: number } = {}): Promise<Buffer | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const out = path.join(os.tmpdir(), `vybe-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`);
  try {
    await run(ffmpegPath, [
      "-ss", Math.max(0, start).toFixed(2), "-i", videoPath,
      "-t", Math.max(1, end - start).toFixed(2),
      "-vf", `scale=-2:${opts.height ?? 360},fps=${opts.fps ?? 5}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
      "-movflags", "+faststart", "-y", out,
    ], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
    const buf = await readFile(out);
    return buf.length > 0 && buf.length <= PROXY_MAX_BYTES ? buf : null;
  } catch {
    return null;
  } finally {
    await unlink(out).catch(() => {});
  }
}

export async function extractFrames(videoPath: string, start: number, end: number, fractions = [0.08, 0.3, 0.5, 0.7, 0.92]): Promise<Buffer[]> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const span = Math.max(1, end - start);
  const frames: Buffer[] = [];
  for (let i = 0; i < fractions.length; i++) {
    const out = path.join(os.tmpdir(), `vybe-frame-${Date.now()}-${i}.jpg`);
    try {
      await run(ffmpegPath, [
        "-ss", (start + span * fractions[i]).toFixed(2), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "6", "-y", out,
      ], { timeout: 30_000 });
      frames.push(await readFile(out));
    } catch { /* a missing frame isn't fatal */ }
    await unlink(out).catch(() => {});
  }
  return frames;
}

// Auto-edit returns the full edit plus short human-readable notes on WHY —
// shown in the editor so the user can see (and trust) the decisions.
export const autoEditSchema = editSchema.extend({
  notes: z.array(z.string()).describe(
    "3-6 very short notes (≤60 chars each) explaining your key editing decisions WITH the timestamp, e.g. 'Opens on the scream at 41.2s', 'Snap zoom on his reaction (47s)', 'Cut before the energy drops at 63s'.",
  ),
});

export type ClipMeta = { title: string; platform: string; duration: number; streamer: string };

function buildSystem(clip: ClipMeta, winStart: number, winEnd: number, hasVideo: boolean, style?: ClipStyle | null): string {
  const media = hasVideo
    ? `You can SEE and HEAR the attached video. It begins at source time ${winStart.toFixed(1)}s — ADD ${winStart.toFixed(1)} to any moment you observe in it when writing timestamps.`
    : `You can see sampled frames (chronological) and read the transcript when given.`;
  const minLen = style?.pacing.targetMinSec ?? 15;
  const maxLen = style?.pacing.targetMaxSec ?? 40;

  return `You are an elite short-form video editor inside Vybe (think top TikTok/Shorts clippers). AUTO-EDIT this streamer/creator clip into a scroll-stopping vertical short. ${media} Ground every decision in what actually happens — never invent events.

Clip: "${clip.title}" — ${clip.platform}, ${clip.streamer || "unknown creator"}, ${clip.duration.toFixed(1)}s long. Every timestamp you output (trim, zoomKeys, cropKeys, effects, volumeKeys, caption timing) is SOURCE time on one shared timeline and must lie within ${winStart.toFixed(1)}–${winEnd.toFixed(1)}s. Do NOT restart the clock at your new trimStart: if you trim to 38.5–55 and the payoff hits 8s after the new start, the zoom keyframe time is 46.5, never 8.

First, silently map the clip: where is the HOOK (first gripping line/visual), the BUILD, the PAYOFF (peak reaction / punchline), and where does energy die? Then edit:

1. HOOK FIRST (the most important cut): viewers decide in under 2 seconds. Set trimStart so the clip OPENS mid-action or mid-sentence on the most gripping moment — no walk-up, no "so anyway", no silence before the first line. If the strongest moment comes later, open on the setup line that teases it.
2. TIGHT RUNTIME: aim for ${minLen}–${maxLen}s of kept footage unless the content clearly needs more. End 0.5–1.5s after the payoff — cut before the energy drops, never let it trail off.
3. VERTICAL FRAMING: cropAspect "9:16". Keep the subject (face / the action) on-frame with cropX (0=left, 100=right); if they move across the frame, follow with cropKeys. Use cropFill "blur" only when the full wide shot itself matters (gameplay with HUD, two people far apart); otherwise "crop".
4. CAPTIONS: if there is meaningful speech, set generateSubtitles=true, subtitleLanguage="original", subtitleStyle="karaoke", subtitleEmoji=true, captionFont="impact", captionTemplate="pop", captionColor="FFFFFF". No speech → all of those off/neutral.
5. PUNCH-INS ON BEATS: zoom punch-ins (zoomKeys) land EXACTLY on real beats — a reaction, a punchline, a key word. Each punch-in is a pair of keyframes: hold 1.0 just before the beat, jump to ≈1.2–1.4 on it; return to 1.0 a few seconds later if another beat follows. zoomSmooth=false snaps (hits harder); true ramps (tension builds). Never zoom on dead footage.
6. HOOK TEXT: when the clip needs setup, add a short ALL-CAPS static caption (≤40 chars) at the top (captionY≈12) that teases without spoiling ("HE HAD NO IDEA WHAT WAS COMING"). Use captionStart/captionEnd to show it only during the setup if it would sit over the payoff. Don't restate what the subtitles will say. No worthwhile hook → empty caption.
7. AUDIO: loudnorm=true always. Use volumeKeys only to duck genuinely grating stretches (ear-rape screams, mic peaking); keep videoVolume 100 otherwise.
8. RESTRAINT: clean cuts + captions + punch-ins beat effect clutter. No color filters, mirror, speed changes, intro/outro cards, or timed effects unless the content obviously calls for one (e.g. a single flash on a jump-scare beat).
${style ? `\n${styleToPrompt(style)}\nThe house style OVERRIDES the generic defaults above wherever they conflict.\n` : ""}
In "notes", explain your 3-6 key decisions with their timestamps. Fill EVERY other field — use neutral values (0, "none", false, empty string, empty arrays) for anything you leave alone.`;
}

// The editor keys every timestamp to the SOURCE timeline, but models routinely
// answer in the output clip's timeline (0 = the new trimStart) even when told
// otherwise. If the trim starts well into the clip and every keyed time fits
// inside the trim span, shift them back onto the source timeline; either way,
// clamp everything into the kept window so no keyframe lands on cut footage.
export function normalizeTimes(e: ClipEdits, winStart: number, winEnd: number): ClipEdits {
  e.trimStart = Math.max(winStart, Math.min(winEnd - 1, e.trimStart));
  e.trimEnd = Math.max(e.trimStart + 1, Math.min(winEnd, e.trimEnd));
  const span = e.trimEnd - e.trimStart;
  if (!(span > 0)) return e;
  const all = [
    ...e.zoomKeys.map((k) => k.time),
    ...e.cropKeys.map((k) => k.time),
    ...e.volumeKeys.map((k) => k.time),
    ...e.effects.flatMap((x) => [x.start, x.end]),
    ...(e.captionEnd > 0 ? [e.captionStart, e.captionEnd] : []),
  ];
  const offset = e.trimStart >= 3 && all.length > 0 && Math.max(...all) <= span * 1.1 ? e.trimStart : 0;
  const fix = (t: number) => Math.min(e.trimEnd, Math.max(e.trimStart, t + offset));

  e.zoomKeys = e.zoomKeys.map((k) => ({ ...k, time: fix(k.time) })).sort((a, b) => a.time - b.time);
  e.cropKeys = e.cropKeys.map((k) => ({ ...k, time: fix(k.time) })).sort((a, b) => a.time - b.time);
  e.volumeKeys = e.volumeKeys.map((k) => ({ ...k, time: fix(k.time) })).sort((a, b) => a.time - b.time);
  e.effects = e.effects
    .map((x) => ({ ...x, start: fix(x.start), end: fix(x.end) }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start);
  if (e.captionEnd > 0) {
    e.captionStart = fix(e.captionStart);
    e.captionEnd = fix(e.captionEnd);
    if (e.captionEnd <= e.captionStart) { e.captionStart = 0; e.captionEnd = 0; }
  }
  return e;
}

export type AutoEditInput = {
  videoUrl?: string;   // server-fetchable (stored path or http); blob: URLs are skipped
  clip: ClipMeta;
  transcript?: string;
  trimStart?: number;
  trimEnd?: number;
  style?: ClipStyle | null;
};

export type AutoEditResult = {
  edits: ClipEdits & Partial<StyleExtras>;
  notes: string[];
  model: string;
  usedVideo: boolean;
  usedFrames: number;
};

export class AutoEditError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function planAutoEdit(input: AutoEditInput): Promise<AutoEditResult> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new AutoEditError("AI editing isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart.", 500);
  }
  const { videoUrl, clip, transcript = "", trimStart = 0, trimEnd = 0, style } = input;
  const winStart = Math.max(0, trimStart);
  const winEnd = trimEnd > trimStart ? trimEnd : (clip.duration || 30);

  // Best signal first: a watchable proxy of the clip. A blob: URL (local file
  // import) can't be fetched server-side — fall back to frames, then metadata.
  let proxy: Buffer | null = null;
  let frames: Buffer[] = [];
  const tmpPath = path.join(os.tmpdir(), `vybe-auto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`);
  if (videoUrl && !videoUrl.startsWith("blob:")) {
    try {
      await resolveToTempFile(videoUrl, tmpPath);
      proxy = await makeVideoProxy(tmpPath, winStart, winEnd);
      if (!proxy) frames = await extractFrames(tmpPath, winStart, winEnd);
    } catch { /* proceed without media */ }
    await unlink(tmpPath).catch(() => {});
  }

  const context = [
    `Current trim: ${winStart.toFixed(1)}s → ${winEnd.toFixed(1)}s`,
    transcript ? `Transcript of what's said:\n${transcript.slice(0, 4000)}` : "",
    proxy
      ? "The clip itself is attached as a video — watch and listen before deciding."
      : frames.length > 0
        ? `${frames.length} frames from the clip are attached in chronological order.`
        : "No media available — decide from the transcript and metadata.",
  ].filter(Boolean).join("\n");

  const media = proxy
    ? [{ type: "file" as const, data: proxy, mediaType: "video/mp4" }]
    : frames.map((f) => ({ type: "image" as const, image: f }));

  let lastErr: unknown;
  for (const modelId of GEMINI_MODELS) {
    try {
      const { object } = await generateObject({
        model: google(modelId),
        schema: autoEditSchema,
        system: buildSystem(clip, winStart, winEnd, !!proxy, style),
        messages: [{
          role: "user",
          content: [
            { type: "text" as const, text: `Auto-edit this clip into the best short-form vertical you can.\n\n${context}` },
            ...media,
          ],
        }],
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(proxy ? 60_000 : 30_000),
      });
      const { notes, ...rest } = object;
      const timed = normalizeTimes(rest, winStart, winEnd);
      const edits = style ? enforceStyle(timed, style) : timed;
      return {
        edits,
        notes: (notes ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 6),
        model: modelId,
        usedVideo: !!proxy,
        usedFrames: frames.length,
      };
    } catch (err) {
      lastErr = err;
      console.error(`[auto-edit] ${modelId} failed:`, err instanceof Error ? err.message : err);
      if (!isTransient(err)) break;
    }
  }
  const fail = aiFailure(lastErr);
  throw new AutoEditError(fail.error, fail.status);
}
