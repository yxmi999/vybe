import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { parseRumbleUrl, getRumbleVideoInfo } from "@/lib/rumble";

export const maxDuration = 300;

// Rumble's channel listing isn't reliable through yt-dlp, so the auto-clipper
// takes a direct video URL and returns just that one video to scan.
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { channel } = await req.json();
  const input = String(channel ?? "").trim();
  if (!input) return NextResponse.json({ error: "Paste a Rumble video URL" }, { status: 400 });

  const url = parseRumbleUrl(input);
  if (!url) {
    return NextResponse.json(
      { error: "Paste a Rumble video URL (e.g. rumble.com/v…-title.html)" },
      { status: 400 },
    );
  }

  try {
    const meta = await getRumbleVideoInfo(url);
    return NextResponse.json({
      channel: meta.channel,
      vods: [{
        uuid: meta.videoUrl,   // the full URL — scan + cut both key off it
        title: meta.title,
        startTime: meta.startTime,
        durationSec: meta.durationSec,
        views: meta.views,
        thumbnail: meta.thumbnail,
      }],
    });
  } catch (err) {
    console.error("[auto-clipper/rumble-vods]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load the Rumble video" },
      { status: 500 },
    );
  }
}
