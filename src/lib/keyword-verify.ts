// Secondary keyword-confirmation pass: chat text (or Rumble/heatmap's lack of
// any) only tells you what viewers reacted to, not what was actually said. For
// a shortlist of already-scored candidate moments, cut a short window and
// transcribe its audio directly, so a keyword the streamer said — but chat
// never reacted to — still surfaces, and a keyword chat spammed but nobody
// actually said doesn't get a false "match" badge. Opt-in and shortlist-only:
// never runs across a whole VOD, only the handful of moments already picked.
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
import { groqAvailable, transcribe, speechWords } from "./groq";

// Lowercase, strip punctuation/accents, collapse spaces.
function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}
// "skins" → "skin", "streamer's" → "streamer" — so obvious variants match.
const stem = (w: string) => w.replace(/(?:'s|s)$/, "");

/** Which keywords/phrases actually appear in a Whisper transcript. */
export function keywordsInTranscript(text: string, keywords: string[]): string[] {
  const words = norm(text).split(" ").filter(Boolean).map(stem);
  const hay = ` ${words.join(" ")} `;
  return keywords.filter((k) => {
    const phrase = norm(k).split(" ").filter(Boolean).map(stem).join(" ");
    return phrase.length > 0 && hay.includes(` ${phrase} `);
  });
}

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const schema = z.object({
  spoken: z.boolean().describe("Whether any of the requested keywords/phrases are genuinely said or unambiguously the topic of this audio."),
  matched: z.array(z.string()).describe("Which of the requested keywords/phrases matched — exact strings copied from the input list, not paraphrased. Empty if none did."),
});

export type KeywordVerifyResult = { matched: boolean; matchedKeywords: string[] };

const NO_MATCH: KeywordVerifyResult = { matched: false, matchedKeywords: [] };

/**
 * Cut a short window around a candidate moment, transcribe its audio, and
 * check whether the user's keywords are actually spoken there. Best-effort —
 * any failure (extraction, transcription, AI) quietly returns "no match"
 * rather than failing the whole scan.
 */
export async function verifyKeywordsInSection(
  platform: VodPlatform,
  ref: string,
  t: number,
  keywords: string[],
  windowSec = 20,
): Promise<KeywordVerifyResult> {
  if (keywords.length === 0 || (!groqAvailable() && !process.env.GOOGLE_GENERATIVE_AI_API_KEY)) return NO_MATCH;

  const start = Math.max(0, t - windowSec / 2);
  const id = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const tmpPath = path.join(os.tmpdir(), `vybe-kw-${id}.mp4`);
  const audioPath = path.join(os.tmpdir(), `vybe-kw-${id}.mp3`);
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

    // Whisper transcript + exact matching: what was actually said, no model
    // judgement call. Falls through to Gemini if Groq is unavailable/limited.
    if (groqAvailable()) {
      try {
        const t = await transcribe(audio);
        const said = speechWords(t).map((w) => w.word).join(" ");
        const matchedKeywords = keywordsInTranscript(said, keywords);
        return { matched: matchedKeywords.length > 0, matchedKeywords };
      } catch (err) {
        console.error("[keyword-verify] Groq failed, falling back to Gemini:", err instanceof Error ? err.message : err);
        if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) return NO_MATCH;
      }
    }

    const { object } = await generateObject({
      model: google("gemini-2.5-flash"),
      schema,
      system:
        "You check whether specific keywords or phrases are genuinely said (or are unambiguously the topic) " +
        "in a short audio clip. Only mark a keyword matched if it, or an obvious variant of it, is actually " +
        "spoken or clearly discussed — not just loosely related.",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `Keywords to check for: ${keywords.join(", ")}` },
          { type: "file", data: new Uint8Array(audio), mediaType: "audio/mp3" },
        ],
      }],
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(25_000),
    });

    const matchedKeywords = (object.matched ?? []).map((k) => String(k)).filter(Boolean);
    return { matched: !!object.spoken && matchedKeywords.length > 0, matchedKeywords };
  } catch {
    return NO_MATCH;
  } finally {
    await unlink(tmpPath).catch(() => {});
    await unlink(audioPath).catch(() => {});
    if (videoUrl) await deleteStored(videoUrl).catch(() => {});
  }
}

/**
 * Run keyword verification across an already-ranked shortlist and tag each
 * moment with the result — no reordering. Split out so a caller that also
 * runs reaction verification (src/lib/reaction-verify.ts) can combine both
 * tags into one final ordering pass instead of each pass fighting over
 * reordering. No-op when no keywords were requested.
 */
export async function tagKeywordMatches<T extends { t: number }>(
  platform: VodPlatform,
  ref: string,
  moments: T[],
  keywords: string[],
  concurrency = 3,
): Promise<(T & { keywordMatch?: boolean; matchedKeywords?: string[] })[]> {
  if (keywords.length === 0) return moments;

  const tagged = new Array<T & { keywordMatch?: boolean; matchedKeywords?: string[] }>(moments.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, moments.length) }, async () => {
      while (next < moments.length) {
        const i = next++;
        const result = await verifyKeywordsInSection(platform, ref, moments[i].t, keywords);
        tagged[i] = { ...moments[i], keywordMatch: result.matched, matchedKeywords: result.matchedKeywords };
      }
    }),
  );
  return tagged;
}

/**
 * Tag + reorder so confirmed matches float to the top (stable within each
 * group — original ranking is preserved otherwise). No-op when no keywords
 * were requested. Kept for callers with only this one verification signal
 * (e.g. Rumble, which has no reaction signal in play).
 */
export async function applyKeywordVerification<T extends { t: number }>(
  platform: VodPlatform,
  ref: string,
  moments: T[],
  keywords: string[],
  concurrency = 3,
): Promise<(T & { keywordMatch?: boolean; matchedKeywords?: string[] })[]> {
  if (keywords.length === 0) return moments;
  const tagged = await tagKeywordMatches(platform, ref, moments, keywords, concurrency);
  const confirmed = tagged.filter((m) => m.keywordMatch);
  const rest = tagged.filter((m) => !m.keywordMatch);
  return [...confirmed, ...rest];
}
