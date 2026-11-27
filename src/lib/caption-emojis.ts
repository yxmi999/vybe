import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import { GEMINI_MODELS, isTransient, aiFailure } from "./ai";
import { groqAvailable, chatJSON } from "./groq";

// Auto-emoji captions: given the transcript words (in order), the model picks a
// sparse set of impactful keywords and assigns each a single reinforcing emoji —
// the Opus Clip / CapCut look. Text-only (no audio), so it runs on Groq's free
// text models first and only falls back to Gemini if Groq is unavailable.
// Shared by /api/clips/caption-emojis (editor) and the styled batch renderer.
const schema = z.object({
  assignments: z.array(z.object({
    index: z.number().int().describe("the 0-based index of the word (from the numbered list) the emoji attaches to"),
    emoji: z.string().describe("a SINGLE emoji character that visually reinforces that word"),
  })).describe("a SPARSE set of word→emoji picks — only the most impactful keywords, never one per word"),
});

export class CaptionEmojiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// First whole emoji of a string. Grapheme-aware, so multi-code-point emoji
// (❤️, 👍🏽, 🤦‍♂️) stay intact instead of being cut to their first code point.
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
function firstEmoji(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const g = segmenter ? segmenter.segment(t)[Symbol.iterator]().next().value?.segment : Array.from(t)[0];
  // Must actually be pictographic — models occasionally answer with a word.
  return g && /\p{Extended_Pictographic}/u.test(g) ? g : "";
}

// Keep only in-range picks with a real emoji; one emoji per word (first wins);
// never more than `cap`.
function clean(assignments: { index: number; emoji: string }[], wordCount: number, cap: number) {
  const seen = new Set<number>();
  return assignments
    .filter((a) => Number.isInteger(a.index) && a.index >= 0 && a.index < wordCount)
    .map((a) => ({ index: a.index, emoji: firstEmoji(String(a.emoji ?? "")) }))
    .filter((a) => a.emoji && (seen.has(a.index) ? false : (seen.add(a.index), true)))
    .slice(0, cap);
}

export async function pickCaptionEmojis(rawWords: string[]): Promise<{ index: number; emoji: string }[]> {
  const words = rawWords.map((w) => String(w ?? "")).slice(0, 600);
  if (words.length === 0) return [];
  if (!groqAvailable() && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new CaptionEmojiError("AI isn't configured. Add GROQ_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) to .env.local and restart.", 500);
  }

  // One emoji per ~6 words feels punchy without clutter; always allow at least one.
  const cap = Math.max(1, Math.round(words.length / 6));
  const numbered = words.map((w, i) => `${i}:${w}`).join(" ");

  const system =
    "You add emoji to short-form video captions (TikTok / Reels / Shorts), the lively Opus Clip / CapCut look. " +
    "You are given the spoken words in order, each as `index:word`. " +
    "Pick the MOST IMPACTFUL keywords and give each ONE emoji that visually reinforces it — " +
    "concrete nouns (money 💰, fire 🔥, time ⏰), strong emotions (😱 😂 ❤️), and payoff/punch words. " +
    `Be SPARSE: choose at most ${cap} word(s) for this clip, never more than one emoji per word, ` +
    "and skip filler words (the, and, is, a, to, of, um). Prefer one emoji per sentence at the punchy beat. " +
    "Only assign an emoji when a clear, fitting one exists — return an empty list if nothing fits. " +
    "Use the exact index numbers from the list.";

  // Groq first (free, fast). Any failure — limit, bad JSON — falls to Gemini.
  if (groqAvailable()) {
    try {
      const out = await chatJSON(
        system + ' Reply ONLY with JSON {"assignments": [{"index": number, "emoji": string}, ...]}.',
        `Words:\n${numbered}`,
        schema,
      );
      return clean(out.assignments ?? [], words.length, cap);
    } catch (err) {
      console.error("[caption-emojis] Groq failed, falling back to Gemini:", err instanceof Error ? err.message : err);
      if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        throw new CaptionEmojiError("Couldn't pick emoji right now — try again in a moment.", 503);
      }
    }
  }

  let lastErr: unknown;
  for (const model of GEMINI_MODELS) {
    try {
      const { object } = await generateObject({
        model: google(model), schema, system, prompt: `Words:\n${numbered}`,
        maxRetries: 1, abortSignal: AbortSignal.timeout(25_000),
      });
      return clean(object.assignments ?? [], words.length, cap);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) break;
    }
  }
  const { error, status } = aiFailure(lastErr);
  throw new CaptionEmojiError(error, status);
}
