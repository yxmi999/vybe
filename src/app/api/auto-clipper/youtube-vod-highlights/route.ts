import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { getVideoInfo, scanLiveChat, type HeatmapPoint, type ChatBuckets } from "@/lib/youtube";
import { smooth, pickPeaks, parseKeywords, KEYWORD_WEIGHT } from "@/lib/chat-highlights";
import { applyKeywordVerification } from "@/lib/keyword-verify";

export const maxDuration = 300;

// Two ways to find YouTube highlights, in order of preference:
//   1. The "most replayed" heatmap — ~100 points of relative replay intensity
//      (0–1), published once a video has enough views. The tallest points are
//      what viewers rewound to.
//   2. Live chat replay spikes — for streams that just ended, no heatmap exists
//      yet, but the chat-rate spikes mark the moments just like Kick/Twitch.
// Each picked peak is spaced apart so the suggested clips don't overlap.

/** Heatmap → ranked replay moments, or null if this video has no usable graph. */
function heatmapMoments(heatmap: HeatmapPoint[], want: number) {
  if (heatmap.length === 0) return null;
  const points = [...heatmap].sort((a, b) => a.start_time - b.start_time);
  const values = points.map((p) => p.value);
  const offsets = points.map((p) => (p.start_time + p.end_time) / 2);
  const maxVal = Math.max(...values);
  if (maxVal <= 0) return null;

  // Keep peaks at least two heatmap segments apart so adjacent bins don't both win.
  const segLen = points.length > 1 ? offsets[1] - offsets[0] : 30;
  const minGap = Math.max(45, Math.round(segLen * 2));
  const peaks = pickPeaks(smooth(values), offsets, minGap, want);

  return peaks
    .map((i) => ({ t: Math.round(offsets[i]), value: values[i] }))
    .sort((a, b) => b.value - a.value)
    .map((m, idx) => ({
      rank: idx + 1,
      t: m.t,
      score: Math.round((m.value / maxVal) * 100),
      intensity: Math.round((m.value / maxVal) * 100),
      kind: "replay" as const,
    }));
}

/** Bucketed live chat → ranked chat-spike moments, mirroring the Kick scanner. */
function chatMoments(buckets: ChatBuckets, want: number) {
  const { counts, hype, keyword, samples, windowSec } = buckets;
  const offsets = counts.map((_, w) => w * windowSec + windowSec / 2);
  const scores = counts.map((c, w) => c + hype[w] * 2 + keyword[w] * KEYWORD_WEIGHT);
  if (Math.max(...scores) === 0) return null;

  const minGap = Math.max(90, windowSec * 6);
  const peaks = pickPeaks(smooth(scores), offsets, minGap, want);

  return peaks
    .map((w) => ({ w, score: scores[w] }))
    .sort((a, b) => b.score - a.score)
    .map((m, idx) => ({
      rank: idx + 1,
      t: Math.round(offsets[m.w]),
      score: Math.round(m.score),
      // Normalize the window count to per-5s so the UI's ×12 reads as per-minute.
      msgsPer5: Math.round((counts[m.w] * 5) / windowSec),
      sampleMessages: samples[m.w],
      keywordHit: keyword[m.w] > 0,
      kind: "chat" as const,
    }));
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { videoId, count = 10, keywords } = await req.json();
  const vid = String(videoId ?? "").trim();
  const want = Math.max(1, Math.min(20, Number(count) || 10));
  const kw = parseKeywords(keywords);

  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) {
    return NextResponse.json({ error: "A valid videoId is required" }, { status: 400 });
  }

  try {
    const meta = await getVideoInfo(vid);

    // 1. Prefer the most-replayed heatmap.
    const replay = heatmapMoments(meta.heatmap, want);
    if (replay && replay.length > 0) {
      // The heatmap has no text signal, so keyword boosting can't happen during
      // scoring — but the transcript-confirmation pass still works (it listens
      // to the audio directly), so keywords still surface relevant moments first.
      const moments = kw.length > 0
        ? (await applyKeywordVerification("youtube", vid, replay, kw)).map((m, idx) => ({ ...m, rank: idx + 1 }))
        : replay;
      return NextResponse.json({ moments, source: "heatmap", scanned: meta.heatmap.length });
    }

    // 2. No heatmap (e.g. a stream that just ended) — fall back to chat replay.
    const buckets = await scanLiveChat(vid, meta.durationSec || 0, 10, kw);
    const chat = buckets ? chatMoments(buckets, want) : null;
    if (chat && chat.length > 0) {
      const verifiedChat = kw.length > 0
        ? (await applyKeywordVerification("youtube", vid, chat, kw)).map((m, idx) => ({ ...m, rank: idx + 1 }))
        : chat;
      // A truncated download only covers the start of a long stream — say so.
      const coveredSec = buckets!.counts.length * buckets!.windowSec;
      return NextResponse.json({
        moments: verifiedChat,
        source: "chat",
        partial: !buckets!.complete && meta.durationSec > 0 && coveredSec < meta.durationSec * 0.9,
        coveredSec,
        scanned: buckets!.counts.length,
      });
    }

    return NextResponse.json(
      {
        error:
          "No highlights found — YouTube hasn't published a “most replayed” graph for this video yet " +
          "(it needs more views), and there's no chat replay to scan. Try again in a day, or open it directly in the editor.",
      },
      { status: 404 },
    );
  } catch (err) {
    console.error("[auto-clipper/youtube-vod-highlights]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to scan the video" },
      { status: 500 },
    );
  }
}
