// Groq: Whisper speech-to-text (with real per-word timestamps) and fast open
// text models, via its OpenAI-compatible API. Used for subtitles, keyword
// checks and reaction checks; callers fall back to Gemini when this is
// unavailable or rate-limited. Server-only.
import { z } from "zod";
import { groqPool, poolFetch } from "./ai-keys";

const API = "https://api.groq.com/openai/v1";
// Whisper large-v3-turbo: near large-v3 accuracy, much faster. Word-level
// timestamps come back in verbose_json.
const WHISPER_MODEL = "whisper-large-v3-turbo";
// Text models available on the account, best-first (Qwen translates more
// naturally; gpt-oss is the fallback).
const TEXT_MODELS = ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"];

export function groqAvailable(): boolean {
  return groqPool().keys.length > 0;
}

export type WhisperWord = { word: string; start: number; end: number };
export type WhisperSegment = { start: number; end: number; text: string; noSpeechProb: number; avgLogprob: number };
export type Transcript = { text: string; language: string; duration: number; words: WhisperWord[]; segments: WhisperSegment[] };

class GroqError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  // Through the key pool: a used-up/limited key hands over to the next one.
  const res = await poolFetch(groqPool(), `${API}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) },
    (h, key) => h.set("Authorization", `Bearer ${key}`));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } }).error?.message ?? `Groq request failed (${res.status})`;
    throw new GroqError(msg, res.status);
  }
  return body;
}

/** Transcribe speech audio (mp3/wav/…) with per-word timestamps. */
export async function transcribe(audio: Buffer | Uint8Array, opts: { language?: string; filename?: string } = {}): Promise<Transcript> {
  if (!groqAvailable()) throw new GroqError("GROQ_API_KEY is not set", 0);
  // FormData bodies are re-sendable, so a key switch can retry the upload.
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), opts.filename ?? "audio.mp3");
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  if (opts.language && opts.language !== "original") form.append("language", opts.language);
  const r = await call("/audio/transcriptions", { method: "POST", body: form }, 60_000) as {
    text?: string; language?: string; duration?: number;
    words?: { word: string; start: number; end: number }[];
    segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }[];
  };
  return {
    text: (r.text ?? "").trim(),
    language: r.language ?? "",
    duration: r.duration ?? 0,
    words: (r.words ?? []).filter((w) => w.word?.trim()).map((w) => ({ word: w.word.trim(), start: w.start, end: w.end })),
    segments: (r.segments ?? []).map((s) => ({
      start: s.start, end: s.end, text: (s.text ?? "").trim(),
      noSpeechProb: s.no_speech_prob ?? 0, avgLogprob: s.avg_logprob ?? 0,
    })),
  };
}

/**
 * Whisper's known failure mode: on music/silence it "hears" stock phrases
 * ("Thanks for watching!"). Keep only words that sit inside segments Whisper
 * itself is confident contain speech.
 */
export function speechWords(t: Transcript): WhisperWord[] {
  if (t.segments.length === 0) return t.words;
  // Whisper's own silence rule: a segment is non-speech only when it's BOTH
  // likely silent AND low-confidence (either signal alone drops real words).
  const silent = (s: WhisperSegment) => s.noSpeechProb > 0.6 && s.avgLogprob < -1.0;
  return t.words.filter((w) => {
    // Word and segment timings don't line up exactly, so attach each word to
    // the segment it overlaps most (or the nearest one) and keep it unless
    // that segment is silent.
    let best: WhisperSegment | null = null, bestScore = -Infinity;
    for (const s of t.segments) {
      const overlap = Math.min(w.end, s.end) - Math.max(w.start, s.start);
      const score = overlap > 0 ? overlap : -Math.min(Math.abs(w.start - s.end), Math.abs(s.start - w.end));
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return !best || !silent(best);
  });
}

/** Ask a Groq text model for JSON and validate it. Tries each model in turn. */
export async function chatJSON<T>(system: string, user: string, schema: z.ZodType<T>, timeoutMs = 30_000): Promise<T> {
  if (!groqAvailable()) throw new GroqError("GROQ_API_KEY is not set", 0);
  let lastErr: unknown;
  for (const model of TEXT_MODELS) {
    try {
      const r = await call("/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      }, timeoutMs) as { choices?: { message?: { content?: string } }[] };
      const content = r.choices?.[0]?.message?.content ?? "";
      // Some models wrap JSON in prose or think-tags; take the outermost object.
      const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
      return schema.parse(JSON.parse(json));
    } catch (err) {
      lastErr = err;
      // Bad JSON or a model-specific failure → try the next model.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Groq text request failed");
}
