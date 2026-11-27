import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { kickGet } from "@/lib/kick";
import {
  isHype, isClipRequest, matchesKeywords, cleanMessage, smooth, pickPeaks, pMap, sharpnessFactor, median, fuse,
  uniqueChatterFactor, HYPE_WEIGHT, CLIP_REQUEST_WEIGHT, KEYWORD_WEIGHT, parseKeywords,
  percentile, normalize01, nearestIndex, mergeCandidateTimes, pickTopSpaced, resortShortlist,
  AUDIO_SIGNAL_WEIGHT, AUDIO_MERGE_WINDOW_SEC,
} from "@/lib/chat-highlights";
import { tagKeywordMatches } from "@/lib/keyword-verify";
import { tagReactions } from "@/lib/reaction-verify";
import { scanVodAudioEnergy, type LoudnessScan } from "@/lib/audio-signal";
import type { HighlightMoment } from "@/lib/twitch-highlights";

export const maxDuration = 300;

// Kick's chat-replay endpoint returns the messages for a fixed ~5-second
// window starting at the requested timestamp. That means one request = one
// chat-rate sample, which is what makes scanning an 8-hour VOD cheap: we
// sample the timeline on a grid, score each window, and the spikes are the
// moments a human clipper would have clipped.
//
// Chat alone is a proxy though (it reacts on a delay, and a low-viewer VOD
// may not generate enough messages to spike at all), so a second, independent
// signal — the VOD's own audio loudness — is scanned across the whole
// timeline too and combined additively, exactly the way twitch-highlights.ts
// does it, so both platforms keep ranking moments the same way.
const WINDOW_SEC = 5;
const MAX_SAMPLES = 480;   // ≈ one per minute on an 8h VOD
const CONCURRENCY = 16;

type ChatMessage = { content?: string; type?: string; sender?: { username?: string } };
type WindowMsg = { text: string; author?: string };

function isoAt(startMs: number, offsetSec: number): string {
  return new Date(startMs + offsetSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Messages in the ~5s chat window starting at startMs + offsetSec. */
async function chatWindow(channelId: number, startMs: number, offsetSec: number): Promise<WindowMsg[] | null> {
  const res = await kickGet(
    `v2/channels/${channelId}/messages?start_time=${encodeURIComponent(isoAt(startMs, offsetSec))}`,
  );
  if (!res.ok) return null;
  const body = res.data as { data?: { messages?: ChatMessage[] } };
  return (body.data?.messages ?? [])
    .filter((m) => m.type === "message" && typeof m.content === "string")
    .map((m) => ({ text: m.content as string, author: m.sender?.username || undefined }));
}

type WindowScore = {
  score: number; msgsPer5: number; hypeRatio: number; clipRatio: number; clipRequested: boolean;
  keywordRatio: number; keywordHit: boolean;
};

const ZERO_SCORE: WindowScore = { score: 0, msgsPer5: 0, hypeRatio: 0, clipRatio: 0, clipRequested: false, keywordRatio: 0, keywordHit: false };

// Window score = message count + hype (×2) + explicit clip requests (×5) +
// requested-keyword mentions (×6), damped by chatter diversity (the same rate
// from three spammers means far less than from forty people). A "!clip" /
// "clip that" is chat literally voting to clip this moment. Windows are a
// fixed ~5s, so the raw count IS the msgs/5s rate. Also returns each channel's
// share for fusion — the same shape the Twitch scanner uses, so both
// platforms rank moments identically.
function scoreWindow(msgs: WindowMsg[], keywords: string[] = []): WindowScore {
  const hype = msgs.filter((m) => isHype(m.text)).length;
  const clip = msgs.filter((m) => isClipRequest(m.text)).length;
  const keyword = msgs.filter((m) => matchesKeywords(m.text, keywords)).length;
  const diversity = uniqueChatterFactor(msgs.map((m) => m.author));
  return {
    score: (msgs.length + hype * HYPE_WEIGHT + clip * CLIP_REQUEST_WEIGHT + keyword * KEYWORD_WEIGHT) * diversity,
    msgsPer5: msgs.length,
    hypeRatio: msgs.length ? hype / msgs.length : 0,
    clipRatio: msgs.length ? clip / msgs.length : 0,
    clipRequested: clip > 0,
    keywordRatio: msgs.length ? keyword / msgs.length : 0,
    keywordHit: keyword > 0,
  };
}

/** Normalized [0,1] loudness series + its sample offsets, ready for peak-picking/lookup. */
function prepareAudio(scan: LoudnessScan): { offsets: number[]; smoothed: number[]; norm: number[] } {
  const { levels, windowSec } = scan;
  const offsets = levels.map((_, w) => w * windowSec + windowSec / 2);
  const min = Math.min(...levels);
  const positive = levels.map((v) => v - min + 1);
  const smoothed = smooth(positive);
  return { offsets, smoothed, norm: normalize01(smoothed) };
}

/** Shared tail: transcript-confirm keywords + classify genuine audio reactions on the shortlist only, then one final ordering pass. */
async function finalizeShortlist(vodRef: string | undefined, moments: HighlightMoment[], keywords: string[]) {
  const [withKeywords, withReactions] = await Promise.all([
    keywords.length > 0 && vodRef ? tagKeywordMatches("kick", vodRef, moments, keywords) : Promise.resolve(moments),
    vodRef ? tagReactions("kick", vodRef, moments) : Promise.resolve(moments),
  ]);
  const combined = moments.map((m, i) => ({ ...m, ...withKeywords[i], ...withReactions[i] }));
  return resortShortlist(combined).map((m, idx) => ({ ...m, rank: idx + 1 }));
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { channelId, startTime, durationSec, count = 10, keywords, vodRef } = await req.json();
  const chId = Number(channelId);
  const startMs = Date.parse(String(startTime ?? ""));
  const dur = Number(durationSec);
  const want = Math.max(1, Math.min(20, Number(count) || 10));
  const kw = parseKeywords(keywords);
  const ref: string | undefined = vodRef ? String(vodRef) : undefined;

  if (!chId || Number.isNaN(startMs) || !Number.isFinite(dur)) {
    return NextResponse.json({ error: "channelId, startTime, and durationSec are required" }, { status: 400 });
  }
  if (dur < 300) {
    return NextResponse.json({ error: "This VOD is too short to scan — open it in the editor directly." }, { status: 400 });
  }

  try {
    // ── Coarse pass: sample chat across the whole timeline, and scan the
    // audio track for loudness (if we have a VOD ref to fetch it), concurrently. ──
    const step = Math.max(60, Math.ceil(dur / MAX_SAMPLES));
    const offsets: number[] = [];
    for (let t = 30; t < dur - WINDOW_SEC; t += step) offsets.push(t);

    const [samples, audioScan] = await Promise.all([
      (async () => {
        const s = await pMap(offsets, (t) => chatWindow(chId, startMs, t), CONCURRENCY);
        // A failed window scores zero and can hide a real spike — retry them
        // once at lower concurrency before giving up on those slots.
        const failedIdx = s.flatMap((x, i) => (x === null ? [i] : []));
        if (failedIdx.length > 0 && failedIdx.length <= offsets.length / 2) {
          const retried = await pMap(failedIdx, (i) => chatWindow(chId, startMs, offsets[i]), 4);
          failedIdx.forEach((i, j) => { s[i] = retried[j]; });
        }
        return s;
      })(),
      ref ? scanVodAudioEnergy("kick", ref, dur).catch(() => null) : Promise.resolve(null),
    ]);

    const failed = samples.filter((s) => s === null).length;
    if (failed > offsets.length / 2) {
      return NextResponse.json(
        { error: "Kick's chat replay kept failing (Cloudflare). Try again in a moment." },
        { status: 502 },
      );
    }

    const scored = samples.map((s) => (s ? scoreWindow(s, kw) : ZERO_SCORE));
    const chatDead = Math.max(...scored.map((x) => x.score)) === 0;
    const audio = audioScan ? prepareAudio(audioScan) : null;

    if (chatDead) {
      if (!audio) {
        return NextResponse.json(
          { error: "No chat activity found in this VOD — can't detect highlights from chat." },
          { status: 404 },
        );
      }
      // Low/no-chat VOD — fall back to ranking by audio energy alone instead
      // of failing outright.
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
      const ranked = await finalizeShortlist(ref, moments, kw);
      return NextResponse.json({ moments: ranked, scanned: offsets.length, stepSec: step, baselineMsgsPer5: 0 });
    }

    // The VOD's normal chat level — the floor a spike is measured against.
    const baselineMsgsPer5 = median(scored.map((x) => x.msgsPer5));
    // This VOD's own "typical strong chat moment" scale — used to weigh the
    // audio contribution proportionally instead of a fixed magic number.
    const chatReferenceScale = percentile(scored.map((x) => x.score).filter((s) => s > 0), 90);

    // ── Pick local maxima from chat, independently from audio, and merge ──
    const smoothed = smooth(scored.map((x) => x.score));
    const minGap = Math.max(180, step * 2);
    const chatPeakIdx = pickPeaks(smoothed, offsets, minGap, want * 2);
    const chatTimes = chatPeakIdx.map((i) => offsets[i]);

    let audioTimes: number[] = [];
    if (audio) {
      const audioMinGap = Math.max(180, audioScan!.windowSec * 10);
      audioTimes = pickPeaks(audio.smoothed, audio.offsets, audioMinGap, want * 2).map((i) => audio.offsets[i]);
    }
    const merged = mergeCandidateTimes(chatTimes, audioTimes, AUDIO_MERGE_WINDOW_SEC);

    // ── Refine: probe halfway between grid points around each chat-driven
    // candidate; audio-only candidates get one direct chat probe at their
    // exact time so they still carry real msgsPer5/hype/clip fields. ──
    const refined = await pMap(
      merged,
      async (c) => {
        let t: number, msgs: WindowMsg[], sc: WindowScore;
        if (c.fromChat) {
          const gridIdx = nearestIndex(offsets, c.t);
          let best = { t: offsets[gridIdx], msgs: samples[gridIdx] ?? [], ...scored[gridIdx] };
          const probes = [best.t - Math.round(step / 2), best.t + Math.round(step / 2)].filter(
            (p) => p >= 0 && p < dur - WINDOW_SEC,
          );
          for (const p of probes) {
            const pmsgs = await chatWindow(chId, startMs, p);
            if (pmsgs) {
              const s = scoreWindow(pmsgs, kw);
              if (s.score > best.score) best = { t: p, msgs: pmsgs, ...s };
            }
          }
          t = best.t; msgs = best.msgs; sc = best;
        } else {
          t = Math.round(c.t);
          msgs = (await chatWindow(chId, startMs, t)) ?? [];
          sc = scoreWindow(msgs, kw);
        }

        const chatIdx = nearestIndex(offsets, t);
        const audioIdx = audio ? nearestIndex(audio.offsets, t) : -1;
        const audioTerm = audio && audioIdx >= 0 ? AUDIO_SIGNAL_WEIGHT * audio.norm[audioIdx] * chatReferenceScale : 0;
        const sharpness = audio && audioIdx >= 0
          ? Math.max(sharpnessFactor(smoothed, chatIdx), sharpnessFactor(audio.smoothed, audioIdx))
          : sharpnessFactor(smoothed, chatIdx);
        // Fuse rate with quality signals — sharpness of the spike, hype
        // density, explicit clip requests, and requested-keyword mentions —
        // exactly like the Twitch scanner. fuse() itself is unchanged; only
        // its first argument now folds in the audio contribution.
        const base = sc.score + audioTerm;
        const fused = fuse(base, sharpness, sc.hypeRatio, sc.clipRatio, sc.keywordRatio);
        return {
          t, msgs, ...sc, fused,
          audioLevel: audioIdx >= 0 ? Math.round(audio!.norm[audioIdx] * 100) : undefined,
          audioSpike: c.fromAudio && !c.fromChat,
        };
      },
      CONCURRENCY,
    );

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
        sampleMessages: [...new Set(m.msgs.map((x) => cleanMessage(x.text)).filter(Boolean))].slice(0, 3),
        clipRequested: m.clipRequested,
        keywordHit: m.keywordHit,
        audioLevel: m.audioLevel,
        audioSpike: m.audioSpike,
      }));

    // Transcript-confirm keyword mentions and classify genuine audio
    // reactions on the shortlist, using the VOD uuid if the client sent one
    // (Kick's chat-window scan doesn't need it, but cutting a section for
    // either verification pass does).
    const ranked = await finalizeShortlist(ref, moments, kw);

    return NextResponse.json({ moments: ranked, scanned: offsets.length, stepSec: step, baselineMsgsPer5 });
  } catch (err) {
    console.error("[auto-clipper/kick-vod-highlights]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to scan the VOD" },
      { status: 500 },
    );
  }
}
