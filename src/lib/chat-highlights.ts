// Shared chat-spike highlight detection, used by the Kick and Twitch
// VOD-scanning routes. Both sample chat rate across a VOD's timeline; the
// spikes — boosted when chat is spamming hype — are the clippable moments.

// Emote spam and hype phrases that mark a clippable moment. Kick renders
// emotes as "[emote:123:KEKW]" so matching the name catches both forms.
const HYPE_RE = /KEKW|OMEGALUL|LULW?|LMF?A+O+|WTF|NO ?WAY|INSANE|HOLY|POGG?(ERS)?|PEPELAUGH|ICANT|HUH+|COOKED|😂|💀/i;
const W_SPAM_RE = /^[wW]+$/;

// An explicit ask for chat to clip THIS moment — the strongest human signal a
// moment is clip-worthy (much stronger than generic hype). Covers the `!clip`
// chat command (Twitch/Kick), "clip it/that/this", "clipped/clippable",
// "someone/pls/mods clip", "need(s) a clip", and "clip pls/now/asap". Kept
// deliberately request-shaped so it doesn't fire on "nice clip" / "that clip".
const CLIP_REQ_RE = /(?:^|\s)!clips?\b|\bclip(?:\s+(?:it|that|this|him|her|them))\b|\bclip(?:ped|able)\b|\b(?:someone|somebody|some1|pls|plz|please|mods?)\s+clip\b|\bneed(?:s|ed)?\s+(?:a\s+)?clip\b|\bclip\s+(?:pls|plz|please|now|asap)\b/i;

export function isHype(content: string): boolean {
  return HYPE_RE.test(content) || W_SPAM_RE.test(content.trim());
}

/** True when a message is asking for the moment to be clipped (incl. `!clip`). */
export function isClipRequest(content: string): boolean {
  return CLIP_REQ_RE.test(content);
}

// Signal weights for window scoring (shared by the Twitch + Kick scorers so
// they rank moments the same way). A hype message counts double a plain one; an
// explicit clip request counts far more — it's chat literally voting "clip this".
export const HYPE_WEIGHT = 2;
export const CLIP_REQUEST_WEIGHT = 5;
// A chat message mentioning one of the user's own requested keywords — weighted
// even heavier than a generic clip request, since it's a direct match against
// what the user explicitly said they're looking for.
export const KEYWORD_WEIGHT = 6;

// How much of the VOD's own "typical strong chat moment" scale one maxed-out
// audio-energy spike is worth when added into a candidate's base score
// (src/lib/audio-signal.ts). Chat is an explicit human signal; audio is more
// prone to false positives (game SFX, music), so it's weighted below 1.
export const AUDIO_SIGNAL_WEIGHT = 0.8;
// Max gap (seconds) to treat a chat-driven peak and an audio-driven peak as
// the same real-world moment rather than two separate candidates.
export const AUDIO_MERGE_WINDOW_SEC = 20;
// Cap on how many shortlist candidates get the AI reaction check
// (src/lib/reaction-verify.ts), independent of how many moments were
// requested — keeps the shortlist-only cost/latency bound tight.
export const MAX_REACTION_CHECKS = 8;
// Max fractional score boost a confirmed reaction (laughter/crowd cheer/etc)
// gives at intensity 100, applied in resortShortlist().
export const REACTION_BOOST = 0.5;

/** Case-insensitive substring match against any of the given keywords/phrases. */
export function matchesKeywords(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = content.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * Parse a user-supplied keyword list (array or comma-separated string) into a
 * trimmed, deduped, capped list. Blank entries are dropped; capped at 8 so a
 * pasted paragraph can't blow up per-window scoring or the transcript-check pass.
 */
export function parseKeywords(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const k = String(item ?? "").trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= 8) break;
  }
  return out;
}

/** Strip emote markup and trim for display in the UI. */
export function cleanMessage(content: string): string {
  return content.replace(/\[emote:\d+:(\w+)\]/g, "$1").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * How sharply the window at `idx` rises above its local surroundings. A sharp,
 * isolated spike (a real event) scores high; a broad plateau ("chat was just
 * busy for ten minutes") scores ~1. Used as a multiplier so fusion favours
 * moments that actually stand out, not stretches of sustained activity.
 * Returns a bounded factor in [1, 2.5].
 */
export function sharpnessFactor(smoothed: number[], idx: number, radius = 6): number {
  let sum = 0, c = 0;
  for (let j = idx - radius; j <= idx + radius; j++) {
    if (j >= 0 && j < smoothed.length && j !== idx) { sum += smoothed[j]; c++; }
  }
  if (c === 0) return 1;
  const localMean = sum / c;
  if (localMean <= 0) return 2.5;
  return Math.max(1, Math.min(2.5, smoothed[idx] / localMean));
}

/** Median of a numeric list (robust baseline for "this VOD's normal level"). */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Fuse a moment's raw chat rate with its quality signals: how sharply it spikes
 * above its surroundings, how hype-dense the chat is, whether chat explicitly
 * asked to clip it, and whether chat mentioned one of the user's requested
 * keywords. A sharp, hype-heavy, clip-requested, keyword-matching moment
 * outranks one that's merely fast. `clipRatio`/`keywordRatio` are each 0 by
 * default — keeps the basic rate×sharpness×hype behaviour unchanged.
 */
export function fuse(rateScore: number, sharpness: number, hypeRatio: number, clipRatio = 0, keywordRatio = 0): number {
  return rateScore * sharpness * (1 + hypeRatio) * (1 + clipRatio * 3) * (1 + keywordRatio * 4);
}

/**
 * Damping for chatter diversity: the same message rate means much more coming
 * from forty different people than from three spammers (or one bot) flooding.
 * Uses the share of distinct authors among messages with a known author, on a
 * sqrt curve so normal hype walls (people repeat themselves when excited,
 * ratio ~0.4-0.7) are barely touched while true low-diversity spam sinks.
 * Returns 1 (neutral) when author data is missing for most of the window, so
 * sources that don't expose usernames rank exactly as before.
 */
export function uniqueChatterFactor(authors: (string | null | undefined)[]): number {
  const known = authors.filter((a): a is string => !!a);
  if (known.length === 0 || known.length < authors.length / 2) return 1;
  const ratio = new Set(known).size / known.length;
  return 0.5 + 0.5 * Math.sqrt(ratio);
}

/**
 * How far a value rises above the baseline. Infinity when there's no baseline
 * but the value is real (any activity in a silent VOD genuinely stands out); 0
 * when the value itself is empty.
 */
export function lift(value: number, baseline: number): number {
  if (baseline > 0) return value / baseline;
  return value > 0 ? Infinity : 0;
}

/** Smooth so a single noisy window doesn't outrank a sustained spike. */
export function smooth(counts: number[]): number[] {
  return counts.map((c, i) => {
    const prev = counts[i - 1] ?? c;
    const next = counts[i + 1] ?? c;
    return (prev + 2 * c + next) / 4;
  });
}

/**
 * Indices of the strongest local maxima, best first, no two closer than
 * minGap (in the same units as offsets).
 */
export function pickPeaks(smoothed: number[], offsets: number[], minGap: number, max: number): number[] {
  const byScore = smoothed
    .map((s, i) => ({ i, s }))
    .filter(({ i, s }) => s > 0 && s >= (smoothed[i - 1] ?? 0) && s >= (smoothed[i + 1] ?? 0))
    .sort((a, b) => b.s - a.s);

  const picked: number[] = [];
  for (const { i } of byScore) {
    if (picked.length >= max) break;
    if (picked.every((j) => Math.abs(offsets[j] - offsets[i]) >= minGap)) picked.push(i);
  }
  return picked;
}

/** p-th percentile (0..100) of a numeric list, linearly interpolated. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * Min-max normalize to [0, 1], clipping the top/bottom `clipPct` fraction
 * first so a single outlier (one silent gap, one spam wall) doesn't squash
 * the rest of the series into a narrow band.
 */
export function normalize01(xs: number[], clipPct = 0.02): number[] {
  if (xs.length === 0) return [];
  const s = [...xs].sort((a, b) => a - b);
  const lo = s[Math.floor(s.length * clipPct)] ?? s[0];
  const hi = s[Math.ceil(s.length * (1 - clipPct)) - 1] ?? s[s.length - 1];
  const range = hi - lo;
  if (range <= 0) return xs.map(() => 0);
  return xs.map((v) => Math.max(0, Math.min(1, (v - lo) / range)));
}

/** Index of the offset closest to `t` in a sorted offsets array. */
export function nearestIndex(offsets: number[], t: number): number {
  let lo = 0, hi = offsets.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(offsets[lo - 1] - t) <= Math.abs(offsets[lo] - t)) return lo - 1;
  return lo;
}

export type MergedCandidate = { t: number; fromChat: boolean; fromAudio: boolean };

/**
 * Union two independently-picked peak-time lists into one candidate set,
 * merging times that land within `mergeWindowSec` of each other (kept once,
 * tagged with which channel(s) it came from) so a chat spike and an audio
 * spike for the same real event don't produce two overlapping suggestions.
 */
export function mergeCandidateTimes(
  chatTimes: number[],
  audioTimes: number[],
  mergeWindowSec: number,
): MergedCandidate[] {
  const merged: MergedCandidate[] = chatTimes.map((t) => ({ t, fromChat: true, fromAudio: false }));
  for (const at of audioTimes) {
    const near = merged.find((m) => Math.abs(m.t - at) <= mergeWindowSec);
    if (near) near.fromAudio = true;
    else merged.push({ t: at, fromChat: false, fromAudio: true });
  }
  return merged;
}

/**
 * Greedy top-N selection over an already-scored, sparse candidate list,
 * enforcing a minimum time gap between picks — the sparse-list counterpart
 * to pickPeaks (which operates on a dense, evenly-sampled series).
 */
export function pickTopSpaced<T extends { t: number }>(
  candidates: T[],
  score: (c: T) => number,
  minGap: number,
  max: number,
): T[] {
  const ranked = [...candidates].sort((a, b) => score(b) - score(a));
  const picked: T[] = [];
  for (const c of ranked) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p.t - c.t) >= minGap)) picked.push(c);
  }
  return picked;
}

/**
 * The single final ordering pass over a shortlist once optional verification
 * passes have tagged it. Keyword confirmation stays the strongest signal (a
 * direct match against what the user explicitly asked for) and buckets
 * first; reaction confirmation acts as a continuous score multiplier within/
 * across that bucket rather than its own partition, so it differentiates
 * without a second blunt "float to top" flattening real score gaps.
 */
export function resortShortlist<T extends {
  score: number; keywordMatch?: boolean; reactionConfirmed?: boolean; reactionIntensity?: number;
}>(moments: T[]): T[] {
  return moments
    .map((m) => ({
      m,
      boosted: m.score * (1 + (m.reactionConfirmed ? REACTION_BOOST * (m.reactionIntensity ?? 0) / 100 : 0)),
    }))
    .sort((a, b) => (Number(!!b.m.keywordMatch) - Number(!!a.m.keywordMatch)) || (b.boosted - a.boosted))
    .map(({ m }) => m);
}

export async function pMap<T, R>(items: T[], fn: (x: T) => Promise<R>, limit: number): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}
