import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { scanTwitchVodHighlights } from "@/lib/twitch-highlights";
import { parseKeywords } from "@/lib/chat-highlights";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { videoId, durationSec, count = 10, keywords } = await req.json();

  try {
    const result = await scanTwitchVodHighlights(videoId, durationSec, count, parseKeywords(keywords));
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    const { moments, scanned, stepSec } = result;
    return NextResponse.json({ moments, scanned, stepSec });
  } catch (err) {
    console.error("[auto-clipper/twitch-vod-highlights]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to scan the VOD" },
      { status: 500 },
    );
  }
}
