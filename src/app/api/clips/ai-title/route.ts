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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

export const maxDuration = 120;

const suggestionSchema = z.object({
  suggestions: z.array(z.string()).min(3).max(6).describe(
    "5 distinct suggestions for this clip, ordered best first.",
  ),
});

const hashtagSchema = z.object({
  suggestions: z.array(z.string()).min(6).max(15).describe(
    "10–12 hashtags for this post, ordered most valuable first, each starting with #.",
  ),
});

const SYSTEMS = {
  // Clip title — metadata shown alongside the post.
  title: `You title short-form streamer clips (TikTok / Shorts / Reels style) for the Vybe app.
Write titles that make someone stop scrolling, based on what actually happens in the clip.

Rules:
- 30–70 characters each. No surrounding quotes, no hashtags, no emoji spam (one emoji is fine when it earns its place).
- Use the streamer's name when it adds recognition value, not in every title.
- Never invent events you can't see in the frames or transcript — hype what's actually there, don't lie.
- Vary the angle across the 5: one descriptive, one reaction/hype, one funny, one curiosity-gap, one short punchy.
- Plain language over clickbait clichés ("You won't believe" is banned).`,

  // On-video caption — the big text overlay burned into the clip itself.
  caption: `You write the on-video hook text (the big caption overlay burned into the clip) for short-form streamer clips for the Vybe app.
This text sits ON the video while it plays — it sets up or reacts to the moment, it does not narrate or describe it like a news headline.

Rules:
- 8–45 characters each. Short hits harder.
- Reaction-style, meme-literate, like a friend captioning the moment. ALL CAPS for emphasis is fine, one emoji max.
- Never invent events you can't see in the frames or transcript.
- No hashtags, no surrounding quotes, don't lead with the streamer's name in every one.
- Vary the angle across the 5: shocked reaction, deadpan/dry, hype, a question to the viewer, one ultra-short (1–4 words).`,

  // Hashtags for the post that carries the clip.
  hashtags: `You pick hashtags for short-form social posts (TikTok / Shorts / Reels / X) for the Vybe app.
Suggest 10–12 hashtags grounded in what's actually in the clip and post.

Rules:
- Each starts with #, no spaces inside, keep natural casing for readability (#GamingClips not #gamingclips when it helps).
- Mix reach levels: 2–3 broad (#gaming, #streamer), 4–5 specific to the content (game name, streamer name, what happens), 2–3 platform/format tags (#shorts, #fyp, #viral) matched to the target platforms when given.
- No banned-bait or irrelevant trend tags. Never invent a game or event you can't see in the context.
- Order by value: content-specific first, generic filler last.`,
} as const;

// A few small frames across the trim window so the model can see what
// actually happens in the clip, not just read metadata about it.
async function extractFrames(videoPath: string, start: number, end: number): Promise<Buffer[]> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const span = Math.max(1, end - start);
  const times = [0.1, 0.35, 0.65, 0.9].map((f) => start + span * f);
  const frames: Buffer[] = [];
  for (let i = 0; i < times.length; i++) {
    const out = path.join(os.tmpdir(), `vybe-title-frame-${Date.now()}-${i}.jpg`);
    try {
      await run(ffmpegPath, [
        "-ss", times[i].toFixed(2), "-i", videoPath,
        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "6", "-y", out,
      ], { timeout: 30_000 });
      frames.push(await readFile(out));
    } catch { /* a missing frame isn't fatal — the model works with fewer */ }
    await unlink(out).catch(() => {});
  }
  return frames;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return NextResponse.json(
      { error: "AI titles aren't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart." },
      { status: 500 },
    );
  }

  const { videoUrl, title, streamer, platform, duration, trimStart = 0, trimEnd = 0, transcript = "", postText = "", kind: rawKind } =
    await req.json() as {
      videoUrl?: string; title?: string; streamer?: string; platform?: string;
      duration?: number; trimStart?: number; trimEnd?: number; transcript?: string;
      postText?: string; kind?: string;
    };
  const kind: keyof typeof SYSTEMS = rawKind === "caption" || rawKind === "hashtags" ? rawKind : "title";

  // Frames are the best signal but optional — a blob: URL (local file import)
  // can't be fetched server-side, and metadata alone still produces titles.
  let frames: Buffer[] = [];
  const tmpPath = path.join(os.tmpdir(), `vybe-title-${Date.now()}.mp4`);
  if (videoUrl && !videoUrl.startsWith("blob:")) {
    try {
      await resolveToTempFile(videoUrl, tmpPath);
      const end = trimEnd > trimStart ? trimEnd : (duration || 30);
      frames = await extractFrames(tmpPath, Math.max(0, trimStart), end);
    } catch { /* no frames — proceed with text context only */ }
    await unlink(tmpPath).catch(() => {});
  }

  const context = [
    streamer && streamer !== "local" ? `Streamer / creator: ${streamer}` : "",
    platform ? `Source platform: ${platform}` : "",
    title ? `Original title (often junk chat-speak — improve on it, don't copy it): "${title}"` : "",
    duration ? `Clip length: ${Math.round(duration)}s` : "",
    postText ? `Post caption/description written so far:\n${postText.slice(0, 2000)}` : "",
    transcript ? `Transcript of what's said:\n${transcript.slice(0, 4000)}` : "",
    frames.length > 0 ? `${frames.length} frames from the clip are attached, in chronological order.` : "",
  ].filter(Boolean).join("\n");

  let lastErr: unknown;
  for (const modelId of GEMINI_MODELS) {
    try {
      const ask = kind === "caption" ? "on-video captions" : kind === "hashtags" ? "hashtags" : "titles";
      const { object } = await generateObject({
        model: google(modelId),
        schema: kind === "hashtags" ? hashtagSchema : suggestionSchema,
        system: SYSTEMS[kind],
        messages: [{
          role: "user",
          content: [
            { type: "text" as const, text: `Suggest ${ask} for this clip.\n\n${context}` },
            ...frames.map((f) => ({ type: "image" as const, image: f })),
          ],
        }],
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(25_000),
      });
      const suggestions = kind === "hashtags"
        ? [...new Set(object.suggestions
            .map((t) => "#" + t.trim().replace(/^#+/, "").replace(/\s+/g, ""))
            .filter((t) => t.length > 1))].slice(0, 12)
        : object.suggestions.map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean).slice(0, 5);
      return NextResponse.json({ suggestions, model: modelId, usedFrames: frames.length });
    } catch (err) {
      lastErr = err;
      console.error(`[ai-title] ${modelId} failed:`, err instanceof Error ? err.message : err);
      if (!isTransient(err)) break;
    }
  }

  const fail = aiFailure(lastErr);
  return NextResponse.json({ error: fail.error }, { status: fail.status });
}
