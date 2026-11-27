import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { unlink, readFile } from "fs/promises";
import path from "path";
import os from "os";
import { resolveToTempFile } from "@/lib/storage";
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import { groqAvailable, transcribe, speechWords, chatJSON, type WhisperWord } from "@/lib/groq";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Language label for the translate instruction. "original" = keep spoken language.
const LANGS: Record<string, string> = {
  original: "the original spoken language",
  en: "English", es: "Spanish", fr: "French", ar: "Arabic", de: "German",
  pt: "Portuguese", hi: "Hindi", ja: "Japanese", it: "Italian", ru: "Russian",
  zh: "Chinese (Simplified)", ko: "Korean", tr: "Turkish", nl: "Dutch", pl: "Polish",
};

const responseSchema = z.object({
  segments: z.array(z.object({
    start: z.number().describe("start time in seconds (decimal)"),
    end: z.number().describe("end time in seconds (decimal)"),
    text: z.string().describe("the spoken words for this segment"),
    words: z.array(z.object({
      word: z.string().describe("a single spoken word (no spaces)"),
      start: z.number().describe("when this word starts, seconds (decimal)"),
      end: z.number().describe("when this word ends, seconds (decimal)"),
    })).describe("per-word timings for this segment, in order — powers word-level animated captions"),
  })),
});

export type SubtitleGenerationInput = { videoUrl: string; language?: string };

// Core logic behind /api/clips/subtitles, extracted so both the direct
// synchronous route (web) and the async job wrapper (mobile) call the same
// implementation instead of duplicating it.
export type SubtitleSegment = { start: number; end: number; text: string; words?: { word: string; start: number; end: number }[] };

// Caption-sized lines from Whisper's word timings: ≤8 words / ≤3.5s, broken
// at pauses and sentence ends — the same shape the Gemini path asks for.
function groupWords(words: WhisperWord[]): SubtitleSegment[] {
  const out: SubtitleSegment[] = [];
  let cur: WhisperWord[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const ws = cur.map((w) => ({ word: w.word, start: w.start, end: Math.max(w.end, w.start + 0.05) }));
    out.push({ start: ws[0].start, end: Math.max(ws[ws.length - 1].end, ws[0].start + 0.3), text: ws.map((w) => w.word).join(" "), words: ws });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      const tooLong = w.end - cur[0].start > 3.5;
      const sentenceEnd = /[.?!]$/.test(prev.word) && cur.length >= 3;
      if (cur.length >= 8 || tooLong || gap >= 0.6 || sentenceEnd) flush();
    }
    cur.push(w);
  }
  flush();
  // Whisper's word times can overlap a little (e.g. a repeated phrase), which
  // would show two caption lines at once — trim each line to end where the
  // next begins.
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i], next = out[i + 1];
    if (next.start < cur.end) {
      cur.end = Math.max(cur.start + 0.2, next.start);
      next.start = Math.max(next.start, cur.end);
      cur.words = cur.words?.map((w) => ({ ...w, start: Math.min(w.start, cur.end), end: Math.min(w.end, cur.end) }));
    }
  }
  return out;
}

// Whisper path: real word timestamps (much more accurate than asking an LLM
// to estimate them). Translation, when asked for, re-words each line with a
// Groq text model and keeps the line timings; translated lines carry no
// per-word times (the renderer spreads the words evenly within each line).
async function whisperSubtitles(audio: Buffer, language: string): Promise<{ segments: SubtitleSegment[] }> {
  const t = await transcribe(audio);
  const segments = groupWords(speechWords(t));
  if (language === "original" || segments.length === 0) return { segments };
  const target = LANGS[language] ?? language;
  const { lines } = await chatJSON(
    `Translate each subtitle line into ${target}. Keep it short, natural and spoken (these are video captions). ` +
    `Reply ONLY with JSON {"lines": [string, ...]} containing exactly ${segments.length} lines, in the same order.`,
    JSON.stringify(segments.map((s) => s.text)),
    z.object({ lines: z.array(z.string()) }),
  );
  if (lines.length !== segments.length) throw new Error("Translation returned the wrong number of lines");
  return { segments: segments.map((s, i) => ({ start: s.start, end: s.end, text: lines[i].trim() || s.text })) };
}

export async function generateSubtitles({ videoUrl, language = "original" }: SubtitleGenerationInput) {
  if (!videoUrl) throw new Error("videoUrl is required");
  if (!groqAvailable() && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error("AI isn't configured. Add GROQ_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) to .env.local and restart.");
  }

  const id = Date.now();
  const inputPath = path.join(os.tmpdir(), `vybe-sub-in-${id}.mp4`);
  const audioPath = path.join(os.tmpdir(), `vybe-sub-${id}.mp3`);

  try {
    await resolveToTempFile(String(videoUrl), inputPath);

    // Extract a small mono speech-optimized audio track.
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
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

    // Prefer Whisper (Groq); fall back to Gemini if it's unavailable/limited.
    if (groqAvailable()) {
      try {
        return await whisperSubtitles(audio, language);
      } catch (err) {
        console.error("[subtitles] Groq Whisper failed, falling back to Gemini:", err instanceof Error ? err.message : err);
        if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw err;
      }
    }

    const langLabel = LANGS[language] ?? language;
    const translateNote = language === "original"
      ? "Transcribe in the original spoken language."
      : `Translate the spoken words into ${langLabel} (do not keep the original language).`;

    const { object } = await generateObject({
      model: google("gemini-2.5-flash"),
      schema: responseSchema,
      system:
        `You generate burned-in subtitle segments from speech audio. ${translateNote} ` +
        "Split into short segments of at most ~8 words and ~3.5 seconds, broken at natural pauses. " +
        "Give accurate start and end times in seconds (decimals are fine). " +
        "For EACH segment also provide a `words` array with per-word timings (word, start, end), in order, " +
        "covering the segment's text — these drive word-level animated captions, so make the per-word " +
        "times as accurate as you can and keep them within the segment's start/end. " +
        "Only include spoken words — no sound effects, music notes, or speaker labels. " +
        "If there is no clear speech, return an empty segments array.",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Generate subtitle segments for this audio." },
          { type: "file", data: new Uint8Array(audio), mediaType: "audio/mp3" },
        ],
      }],
    });

    const segments = (object.segments ?? [])
      .filter((s) => typeof s.start === "number" && typeof s.end === "number" && s.text?.trim())
      .map((s) => {
        const segStart = Math.max(0, s.start);
        const segEnd = Math.max(segStart + 0.3, s.end);
        // Keep only in-order, in-bounds word timings; drop the array if unusable
        // so the renderer falls back to even distribution across the segment.
        const words = (Array.isArray(s.words) ? s.words : [])
          .filter((w) => w && typeof w.word === "string" && w.word.trim()
            && typeof w.start === "number" && typeof w.end === "number")
          .map((w) => ({
            word: w.word.trim(),
            start: Math.min(segEnd, Math.max(segStart, w.start)),
            end: Math.min(segEnd, Math.max(segStart, w.end)),
          }))
          .sort((a, b) => a.start - b.start);
        return { start: segStart, end: segEnd, text: s.text.trim(), words: words.length ? words : undefined };
      })
      .sort((a, b) => a.start - b.start);

    return { segments };
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(audioPath).catch(() => {});
  }
}
