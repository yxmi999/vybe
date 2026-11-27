// Secondary reaction-confirmation pass: chat rate and raw audio loudness both
// only hint that *something* happened at a moment — neither tells you it was
// a genuine laugh, crowd cheer, or shocked gasp versus just loud game audio
// or a busy chat. For a shortlist of already-scored candidate moments, cut a
// short window and classify its audio directly. Shortlist-only, same as
// keyword-verify.ts: never runs across a whole VOD, only the handful of
// moments already picked.
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import path from "path";
import os from "os";
import { unlink, readFile } from "fs/promises";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { extractVodSection, type VodPlatform } from "./vod-extract";
import { resolveToTempFile, deleteStored } from "./storage";
import { MAX_REACTION_CHECKS } from "./chat-highlights";
import { groqAvailable, transcribe, chatJSON } from "./groq";

// Loudness of the window (ffmpeg volumedetect): mean and peak in dBFS. A real
// reaction is usually a burst well above the window's average.
async function loudness(file: string): Promise<{ mean: number; max: number } | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  try {
    const r = await promisify(execFile)(ffmpegInstaller.path,
      ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { timeout: 20_000 });
    return parseVol(String(r.stderr));
  } catch (err) {
    return parseVol(String((err as { stderr?: string }).stderr ?? ""));
  }
}
function parseVol(out: string) {
  const mean = out.match(/mean_volume:\s*(-?[\d.]+) dB/), max = out.match(/max_volume:\s*(-?[\d.]+) dB/);
  return mean && max ? { mean: Number(mean[1]), max: Number(max[1]) } : null;
}

// Groq path: Whisper transcript (what was said, incl. "LMAO", "NO WAY",
// "hahaha", screamed lines) + the loudness burst, judged by a text model.
// It can't hear a wordless laugh the way an audio model can — a known trade.
async function classifyFromTranscript(audioPath: string, audio: Buffer): Promise<ReactionVerifyResult> {
  const [t, vol] = await Promise.all([transcribe(audio), loudness(audioPath)]);
  const lines = t.segments
    .filter((seg) => seg.noSpeechProb < 0.8)
    .map((seg) => `[${seg.start.toFixed(1)}s] ${seg.text}`)
    .join("\n");
  const r = await chatJSON(
    "You judge whether a short livestream audio clip contains a genuine audible reaction: real laughter, a crowd " +
    "cheering, a shocked gasp, or excited/hype yelling. You get its transcript and its loudness. Laughter often shows " +
    "as 'haha', 'LMAO', or broken half-words; shock as 'no way', 'what', 'oh my god'; hype as shouted repeated words. " +
    "A big gap between peak and mean loudness (over ~18 dB) suggests a burst. Normal talking, commentary or calm " +
    "speech is 'none'. Reply ONLY with JSON {\"reaction\": \"laughter\"|\"crowd_cheer\"|\"shock_gasp\"|\"hype_yelling\"|\"none\", \"intensity\": 0-100}.",
    `Transcript:\n${lines || "(no clear speech)"}\n\nLoudness: mean ${vol?.mean ?? "?"} dBFS, peak ${vol?.max ?? "?"} dBFS.`,
    schema,
  );
  const intensity = Math.max(0, Math.min(100, Math.round(r.intensity ?? 0)));
  const reaction = r.reaction ?? "none";
  return { reaction, intensity, confirmed: reaction !== "none" && intensity >= 40 };
}

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const REACTION_WINDOW_SEC = 12;

const schema = z.object({
  reaction: z.enum(["laughter", "crowd_cheer", "shock_gasp", "hype_yelling", "none"])
    .describe("The dominant genuine audible reaction in this clip, or 'none' if it's just normal talking, background noise, or music."),
  intensity: z.number().min(0).max(100)
    .describe("How intense/genuine the reaction is. 0 = none, 100 = explosive and unmistakable."),
});

export type ReactionVerifyResult = { reaction: string; intensity: number; confirmed: boolean };
const NO_REACTION: ReactionVerifyResult = { reaction: "none", intensity: 0, confirmed: false };

/**
 * Cut a short window around a candidate moment and classify whether it
 * contains a genuine audible reaction. Best-effort — any failure (extraction,
 * decode, AI) quietly returns "no reaction" rather than failing the whole scan.
 */
export async function verifyReactionInSection(
  platform: VodPlatform,
  ref: string,
  t: number,
  windowSec = REACTION_WINDOW_SEC,
): Promise<ReactionVerifyResult> {
  if (!groqAvailable() && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) return NO_REACTION;

  const start = Math.max(0, t - windowSec / 2);
  const id = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const tmpPath = path.join(os.tmpdir(), `vybe-rx-${id}.mp4`);
  const audioPath = path.join(os.tmpdir(), `vybe-rx-${id}.mp3`);
  let videoUrl: string | undefined;

  try {
    const section = await extractVodSection(platform, ref, start, windowSec);
    videoUrl = section.videoUrl;
    await resolveToTempFile(videoUrl, tmpPath);

    await new Promise<void>((resolve, reject) => {
      ffmpeg(tmpPath)
        .noVideo()
        .audioChannels(1)
        .audioFrequency(16000)
        .audioBitrate("48k")
        .format("mp3")
        .on("end", () => resolve())
        .on("error", reject)
        .save(audioPath);
    });

    const audio = await readFile(audioPath);

    if (groqAvailable()) {
      try {
        return await classifyFromTranscript(audioPath, audio);
      } catch (err) {
        console.error("[reaction-verify] Groq failed, falling back to Gemini:", err instanceof Error ? err.message : err);
        if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) return NO_REACTION;
      }
    }

    const { object } = await generateObject({
      model: google("gemini-2.5-flash"),
      schema,
      system:
        "You check whether a short audio clip contains a genuine audible reaction — real laughter, a crowd " +
        "cheering, a shocked gasp, or excited yelling. Only classify a reaction as present if it's clearly " +
        "audible and genuine, not just loud game audio, music, or normal excited talking.",
      messages: [{
        role: "user",
        content: [
          { type: "file", data: new Uint8Array(audio), mediaType: "audio/mp3" },
        ],
      }],
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(25_000),
    });

    const intensity = Math.max(0, Math.min(100, Math.round(object.intensity ?? 0)));
    const reaction = object.reaction ?? "none";
    return { reaction, intensity, confirmed: reaction !== "none" && intensity >= 40 };
  } catch {
    return NO_REACTION;
  } finally {
    await unlink(tmpPath).catch(() => {});
    await unlink(audioPath).catch(() => {});
    if (videoUrl) await deleteStored(videoUrl).catch(() => {});
  }
}

/**
 * Run reaction verification across the top of an already-ranked shortlist
 * and tag each moment — no reordering (see chat-highlights.ts's
 * resortShortlist for the combined final ordering pass). Capped at
 * MAX_REACTION_CHECKS regardless of shortlist size, independent of the
 * keyword-verification pass, to keep the shortlist-only cost/latency bound
 * tight even when a caller requests a large `count`.
 */
export async function tagReactions<T extends { t: number }>(
  platform: VodPlatform,
  ref: string,
  moments: T[],
  concurrency = 3,
): Promise<(T & { reactionKind?: string; reactionIntensity?: number; reactionConfirmed?: boolean })[]> {
  const checkCount = Math.min(moments.length, MAX_REACTION_CHECKS);
  const results = new Array<ReactionVerifyResult>(checkCount);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, checkCount) }, async () => {
      while (next < checkCount) {
        const i = next++;
        results[i] = await verifyReactionInSection(platform, ref, moments[i].t);
      }
    }),
  );

  return moments.map((m, i) => (
    i < checkCount
      ? { ...m, reactionKind: results[i].reaction, reactionIntensity: results[i].intensity, reactionConfirmed: results[i].confirmed }
      : m
  ));
}
