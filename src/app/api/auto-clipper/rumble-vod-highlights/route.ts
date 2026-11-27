import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { parseRumbleUrl, getRumbleMediaUrls, scanLoudness } from "@/lib/rumble";
import { smooth, pickPeaks, parseKeywords } from "@/lib/chat-highlights";
import { applyKeywordVerification } from "@/lib/keyword-verify";

export const maxDuration = 300;

// Rumble has no replay graph or chat data, so highlights come from audio
// loudness: scan the whole audio for per-window RMS, then pick the loudest
// peaks (spaced apart so the suggested clips don't overlap).
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { videoUrl, durationSec, count = 10, keywords } = await req.json();
  const url = parseRumbleUrl(String(videoUrl ?? ""));
  const dur = Number(durationSec);
  const want = Math.max(1, Math.min(20, Number(count) || 10));
  const kw = parseKeywords(keywords);

  if (!url) return NextResponse.json({ error: "A valid Rumble video URL is required" }, { status: 400 });

  try {
    const { audioUrl } = await getRumbleMediaUrls(url);
    const scan = await scanLoudness(audioUrl, Number.isFinite(dur) ? dur : 0);
    if (!scan || scan.levels.length < 3) {
      return NextResponse.json(
        { error: "Couldn't read this video's audio to find loud moments." },
        { status: 404 },
      );
    }

    const { levels, windowSec } = scan;
    const offsets = levels.map((_, w) => w * windowSec + windowSec / 2);
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    if (max - min < 1) {
      return NextResponse.json(
        { error: "This video's audio is flat — no standout loud moments to detect." },
        { status: 404 },
      );
    }

    // pickPeaks needs positive values; shift the dB series above zero.
    const positive = levels.map((v) => v - min + 1);
    const minGap = Math.max(60, windowSec * 10);
    const peaks = pickPeaks(smooth(positive), offsets, minGap, want);

    const moments = peaks
      .map((w) => ({ t: Math.round(offsets[w]), level: levels[w] }))
      .sort((a, b) => b.level - a.level)
      .map((m, idx) => ({
        rank: idx + 1,
        t: m.t,
        score: Math.round(((m.level - min) / (max - min)) * 100),
        intensity: Math.round(((m.level - min) / (max - min)) * 100),
        kind: "loud" as const,
      }));

    // Rumble has no chat or heatmap text to score against — keywords only
    // work here via the transcript-confirmation pass, which listens to each
    // loudness peak's audio directly.
    const verifiedMoments = kw.length > 0
      ? (await applyKeywordVerification("rumble", url, moments, kw)).map((m, idx) => ({ ...m, rank: idx + 1 }))
      : moments;

    return NextResponse.json({ moments: verifiedMoments, source: "loudness", scanned: levels.length });
  } catch (err) {
    console.error("[auto-clipper/rumble-vod-highlights]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to scan the video" },
      { status: 500 },
    );
  }
}
