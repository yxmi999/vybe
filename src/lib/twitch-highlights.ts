// Twitch VOD highlight scanning — extracted so both the interactive route
// (/api/auto-clipper/twitch-vod-highlights) and the Auto-Pilot engine can run
// the exact same detection.
//
// Twitch's chat-replay GQL query returns ~50 comments forward from an offset,
// each stamped with its exact second in the VOD. The time those comments span
// gives the chat rate at that point: 50 comments in 4 seconds is a hype wall,
// 50 comments in 3 minutes is dead chat. GQL accepts batched operations, so we
// sample the whole timeline with a handful of HTTP requests.
//
// Chat alone is a proxy, though — it reacts on a delay, and a low-viewer VOD
// may never generate enough messages to spike at all. A second, independent
// signal (src/lib/audio-signal.ts) scans the VOD's own audio loudness across
// the whole timeline for real crowd/streamer reactions, and both channels are
// combined additively before quality-boosting so an audio-only moment (or a
// chat-only one) can still surface — see mergeCandidateTimes/fuse below.
import { getChatPages, type ChatSample } from "./twitch-gql";
import {
  isHype, isClipRequest, matchesKeywords, cleanMessage, smooth, pickPeaks, pMap, sharpnessFactor, median, fuse,
  uniqueChatterFactor, HYPE_WEIGHT, CLIP_REQUEST_WEIGHT, KEYWORD_WEIGHT,
  percentile, normalize01, nearestIndex, mergeCandidateTimes, pickTopSpaced, resortShortlist,
  AUDIO_SIGNAL_WEIGHT, AUDIO_MERGE_WINDOW_SEC,
} from "./chat-highlights";
import { tagKeywordMatches } from "./keyword-verify";
import { tagReactions } from "./reaction-verify";
import { scanVodAudioEnergy, type LoudnessScan } from "./audio-signal";

const MAX_SAMPLES = 480;   // ≈ one per minute on an 8h VOD
const BATCH = 10;          // GQL operations per HTTP request
const CONCURRENCY = 5;     // batches in flight

export type HighlightMoment = {
  rank: number;
  t: number;               // VOD-relative seconds of the moment
  score: number;
  msgsPer5: number;
  sampleMessages: string[];
  clipRequested?: boolean; // chat explicitly asked to clip this moment (!clip / "clip it")
  keywordHit?: boolean;        // chat mentioned one of the requested keywords
  keywordMatch?: boolean;      // transcript-confirmed: a keyword was actually said
  matchedKeywords?: string[];  // which requested keywords were confirmed
  audioLevel?: number;         // 0-100 normalized audio energy near this moment (absent if the audio pass failed)
  audioSpike?: boolean;        // this candidate came from an audio spike with little/no chat contribution
  reactionKind?: string;       // AI-classified reaction ("laughter", "crowd_cheer", "shock_gasp", "hype_yelling", "none")
  reactionIntensity?: number;  // 0-100
  reactionConfirmed?: boolean; // genuine reaction confirmed by the AI audio check
};

export type ScanResult =
  | {
      ok: true;
      moments: HighlightMoment[];
      scanned: number;
      stepSec: number;
      // Median chat rate (msgs/5s) across the whole VOD — the "normal level" the
      // engine measures each moment against to decide it's a genuine spike and
      // not just the loudest point of a quiet stream.
      baselineMsgsPer5: number;
    }
  | { ok: false; status: number; error: string };

type PageScore = {
  score: number; msgsPer5: number; hypeRatio: number; clipRatio: number; clipRequested: boolean;
  keywordRatio: number; keywordHit: boolean;
};

const ZERO_SCORE: PageScore = { score: 0, msgsPer5: 0, hypeRatio: 0, clipRatio: 0, clipRequested: false, keywordRatio: 0, keywordHit: false };

/**
 * Rate score (msgs/5s) boosted by three signal channels: hype spam (counted
 * double), explicit clip requests (counted heavily — chat voting "clip this"),
 * and mentions of the user's own requested keywords (counted heaviest — a
 * direct match against what they said they're looking for). Also returns each
 * channel's share of the window for fusion.
 */
function scorePage(page: ChatSample[], keywords: string[] = []): PageScore {
  if (page.length < 2) {
    const clip = page.some((m) => isClipRequest(m.text));
    const kw = page.some((m) => matchesKeywords(m.text, keywords));
    return {
      score: page.length, msgsPer5: page.length, hypeRatio: 0, clipRatio: clip ? 1 : 0, clipRequested: clip,
      keywordRatio: kw ? 1 : 0, keywordHit: kw,
    };
  }
  const span = Math.max(1, page[page.length - 1].offset - page[0].offset);
  const per5 = (page.length * 5) / Math.max(span, 5);
  const hypeCount = page.filter((m) => isHype(m.text)).length;
  const clipCount = page.filter((m) => isClipRequest(m.text)).length;
  const keywordCount = page.filter((m) => matchesKeywords(m.text, keywords)).length;
  const hypePer5 = (hypeCount * 5) / Math.max(span, 5);
  const clipPer5 = (clipCount * 5) / Math.max(span, 5);
  const keywordPer5 = (keywordCount * 5) / Math.max(span, 5);
  // Same rate from 40 distinct chatters ≫ same rate from 3 spammers; neutral
  // (×1) when the replay doesn't expose authors.
  const diversity = uniqueChatterFactor(page.map((m) => m.author));
  return {
    score: (per5 + hypePer5 * HYPE_WEIGHT + clipPer5 * CLIP_REQUEST_WEIGHT + keywordPer5 * KEYWORD_WEIGHT) * diversity,
    msgsPer5: Math.round(per5),
    hypeRatio: hypeCount / page.length,
    clipRatio: clipCount / page.length,
    clipRequested: clipCount > 0,
    keywordRatio: keywordCount / page.length,
    keywordHit: keywordCount > 0,
  };
}

/** Sample chat pages at many offsets, batched; null = that sample failed. */
async function samplePages(videoId: string, offsets: number[]): Promise<(ChatSample[] | null)[]> {
  const chunks: number[][] = [];
  for (let i = 0; i < offsets.length; i += BATCH) chunks.push(offsets.slice(i, i + BATCH));
  const results = await pMap(
    chunks,
    (chunk) => getChatPages(videoId, chunk).catch(() => chunk.map(() => null)),
    CONCURRENCY,
  );
  return results.flat();
}

/** Normalized [0,1] loudness series + its sample offsets, ready for peak-picking/lookup. */
function prepareAudio(scan: LoudnessScan): { offsets: number[]; smoothed: number[]; norm: number[] } {
  const { levels, windowSec } = scan;
  const start = scan.startSec ?? 0;
  const offsets = levels.map((_, w) => start + w * windowSec + windowSec / 2);
  const min = Math.min(...levels);
  const positive = levels.map((v) => v - min + 1);
  const smoothed = smooth(positive);
  return { offsets, smoothed, norm: normalize01(smoothed) };
}

/**
 * Scan a Twitch VOD's chat replay and audio track for the top `count`
 * clippable moments. Returns a discriminated result so callers can map
 * failures to HTTP codes (route) or just skip the run (engine).
 */
export async function scanTwitchVodHighlights(
  videoId: string,
  durationSec: number,
  count = 10,
  keywords: string[] = [],
  // Live mode: scan only [from, to] of a still-recording VOD (the part not
  // scanned by an earlier pass). Omitted = the whole VOD, as before.
  range?: { from: number; to: number },
): Promise<ScanResult> {
  const vid = String(videoId ?? "").trim();
  const dur = Number(durationSec);
  const want = Math.max(1, Math.min(20, Number(count) || 10));

  if (!/^\d+$/.test(vid) || !Number.isFinite(dur)) {
    return { ok: false, status: 400, error: "videoId and durationSec are required" };
  }
  const from = range ? Math.max(0, range.from) : 0;
  const to = range ? Math.min(dur, range.to) : dur;
  if (range ? to - from < 120 : dur < 300) {
    return { ok: false, status: 400, error: range ? "Not enough new stream to scan yet." : "This VOD is too short to scan — open it in the editor directly." };
  }

  // ── Coarse pass: sample chat across the whole timeline, and scan the audio
  // track for loudness, concurrently — independent signals, independent work.
  // A live window samples denser (it's short), so spikes aren't missed. ──
  const span = to - from;
  // A short window (Live mode's 3–45 min) is sampled densely; a long range
  // (a marathon's recorded-so-far) like a whole VOD.
  const shortWindow = !!range && span <= 3600;
  const step = shortWindow ? Math.max(20, Math.ceil(span / 60)) : Math.max(60, Math.ceil(span / MAX_SAMPLES));
  const offsets: number[] = [];
  for (let t = Math.max(30, from); t < to - 10; t += step) offsets.push(t);

  const [samples, audioScan] = await Promise.all([
    (async () => {
      const s = await samplePages(vid, offsets);
      // Retry failed slots once so a dropped request can't hide a real spike.
      const failedIdx = s.flatMap((x, i) => (x === null ? [i] : []));
      if (failedIdx.length > 0 && failedIdx.length <= offsets.length / 2) {
        const retried = await samplePages(vid, failedIdx.map((i) => offsets[i]));
        failedIdx.forEach((i, j) => { s[i] = retried[j]; });
      }
      return s;
    })(),
    (range
      ? scanVodAudioEnergy("twitch", vid, span, { startSec: from })
      : scanVodAudioEnergy("twitch", vid, dur)).catch(() => null),
  ]);

  if (samples.filter((s) => s === null).length > offsets.length / 2) {
    return { ok: false, status: 502, error: "Chat replay isn't available for this VOD." };
  }

  const scored: PageScore[] = samples.map((s) => (s ? scorePage(s, keywords) : ZERO_SCORE));
  const chatDead = Math.max(...scored.map((x) => x.score)) === 0;
  const audio = audioScan ? prepareAudio(audioScan) : null;

  if (chatDead) {
    if (!audio) {
      return { ok: false, status: 404, error: "No chat activity found in this VOD — can't detect highlights from chat." };
    }
    // Low/no-chat VOD — fall back to ranking by audio energy alone (Rumble-style)
    // instead of failing outright.
    const minGap = Math.max(180, audioScan!.windowSec * 10);
    const peakIdx = pickPeaks(audio.smoothed, audio.offsets, minGap, want);
    const moments: HighlightMoment[] = peakIdx
      .map((w) => ({ t: Math.round(audio.offsets[w]), level: audio.norm[w] }))
      .sort((a, b) => b.level - a.level)
      .map((m, idx) => ({
        rank: idx + 1,
        t: m.t,
        score: Math.round(m.level * 100),
        msgsPer5: 0,
        sampleMessages: [],
        audioLevel: Math.round(m.level * 100),
        audioSpike: true,
      }));
    return finalizeShortlist(vid, moments, keywords, offsets.length, step, 0);
  }

  // The VOD's normal chat level — the floor a spike is measured against.
  const baselineMsgsPer5 = median(scored.map((x) => x.msgsPer5));
  // This VOD's own "typical strong chat moment" scale — used to weigh the
  // audio contribution proportionally instead of a fixed magic number.
  const chatReferenceScale = percentile(scored.map((x) => x.score).filter((s) => s > 0), 90);

  // ── Pick local maxima from chat, independently from audio, and merge ──
  const smoothed = smooth(scored.map((x) => x.score));
  // Live windows are short — allow closer peaks (still never overlapping clips).
  const minGap = shortWindow ? 90 : Math.max(180, step * 2);
  const chatPeakIdx = pickPeaks(smoothed, offsets, minGap, want * 2);
  const chatTimes = chatPeakIdx.map((i) => offsets[i]);

  let audioTimes: number[] = [];
  if (audio) {
    const audioMinGap = Math.max(180, audioScan!.windowSec * 10);
    audioTimes = pickPeaks(audio.smoothed, audio.offsets, audioMinGap, want * 2).map((i) => audio.offsets[i]);
  }
  const merged = mergeCandidateTimes(chatTimes, audioTimes, AUDIO_MERGE_WINDOW_SEC);

  // ── Refine: probe halfway between grid points around each chat-driven
  // candidate; audio-only candidates get one direct chat probe at their exact
  // time so they still carry real msgsPer5/hype/clip fields. ──
  const probeOffsets = merged.flatMap((c) => c.fromChat
    ? [c.t - Math.round(step / 2), c.t + Math.round(step / 2)].filter((p) => p >= from && p < to - 10)
    : []);
  const probePages = probeOffsets.length ? await samplePages(vid, probeOffsets) : [];
  const probeMap = new Map(probeOffsets.map((t, j) => [t, probePages[j]]));

  const refined = await pMap(merged, async (c) => {
    let t: number, page: ChatSample[], sc: PageScore;
    if (c.fromChat) {
      const gridIdx = nearestIndex(offsets, c.t);
      let best = { t: offsets[gridIdx], page: samples[gridIdx] ?? [], ...scored[gridIdx] };
      for (const p of [best.t - Math.round(step / 2), best.t + Math.round(step / 2)]) {
        const pg = probeMap.get(p);
        if (pg) {
          const s = scorePage(pg, keywords);
          if (s.score > best.score) best = { t: p, page: pg, ...s };
        }
      }
      t = best.t; page = best.page; sc = best;
    } else {
      t = Math.round(c.t);
      const pg = (await getChatPages(vid, [t]).catch(() => [null]))[0];
      page = pg ?? [];
      sc = scorePage(page, keywords);
    }

    const chatIdx = nearestIndex(offsets, t);
    const audioIdx = audio ? nearestIndex(audio.offsets, t) : -1;
    const audioTerm = audio && audioIdx >= 0 ? AUDIO_SIGNAL_WEIGHT * audio.norm[audioIdx] * chatReferenceScale : 0;
    const sharpness = audio && audioIdx >= 0
      ? Math.max(sharpnessFactor(smoothed, chatIdx), sharpnessFactor(audio.smoothed, audioIdx))
      : sharpnessFactor(smoothed, chatIdx);
    // Fuse the combined base signal with quality signals: how sharply this
    // point spikes above its neighbours, how much of the chat is actual hype
    // (not just fast), whether chat explicitly asked to clip it, and whether
    // chat mentioned a requested keyword. fuse() itself is unchanged — only
    // its first argument now folds in the audio contribution, so when audio
    // is unavailable (audioTerm === 0 for every candidate) the result is
    // identical to chat-only scoring.
    const base = sc.score + audioTerm;
    const fused = fuse(base, sharpness, sc.hypeRatio, sc.clipRatio, sc.keywordRatio);
    return {
      t, page, ...sc, fused,
      audioLevel: audioIdx >= 0 ? Math.round(audio!.norm[audioIdx] * 100) : undefined,
      audioSpike: c.fromAudio && !c.fromChat,
    };
  }, CONCURRENCY);

  // Re-space across the merged union — chat-only and audio-only peaks were
  // each spaced within their own channel but not against each other.
  const spaced = pickTopSpaced(refined, (c) => c.fused, minGap, want);

  const moments: HighlightMoment[] = spaced
    .sort((a, b) => b.fused - a.fused)
    .map((m, idx) => ({
      rank: idx + 1,
      t: m.t,
      score: Math.round(m.fused),
      msgsPer5: m.msgsPer5,
      sampleMessages: [...new Set(m.page.map((x) => cleanMessage(x.text)).filter(Boolean))].slice(0, 3),
      clipRequested: m.clipRequested,
      keywordHit: m.keywordHit,
      audioLevel: m.audioLevel,
      audioSpike: m.audioSpike,
    }));

  return finalizeShortlist(vid, moments, keywords, offsets.length, step, baselineMsgsPer5);
}

/**
 * Shared tail: transcript-confirm keyword mentions and classify genuine
 * audio reactions on the shortlist only (chat/audio text is cheap but noisy
 * — spam, sarcasm, game SFX; this catches moments chat never reacted to and
 * filters false positives), then apply the single final ordering pass.
 */
async function finalizeShortlist(
  vid: string,
  moments: HighlightMoment[],
  keywords: string[],
  scanned: number,
  stepSec: number,
  baselineMsgsPer5: number,
): Promise<ScanResult> {
  const [withKeywords, withReactions] = await Promise.all([
    keywords.length > 0 ? tagKeywordMatches("twitch", vid, moments, keywords) : Promise.resolve(moments),
    tagReactions("twitch", vid, moments),
  ]);
  const combined = moments.map((m, i) => ({ ...m, ...withKeywords[i], ...withReactions[i] }));
  const ranked = resortShortlist(combined).map((m, idx) => ({ ...m, rank: idx + 1 }));
  return { ok: true, moments: ranked, scanned, stepSec, baselineMsgsPer5 };
}
