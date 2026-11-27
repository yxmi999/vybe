import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { parseYoutubeVideoId, channelVideosUrl, listChannelVideos, getVideoInfo } from "@/lib/youtube";

export const maxDuration = 300;

// YouTube's auto-clipper input is flexible: paste a single video/stream URL to
// scan just that one, or a channel handle to list its recent videos. Both end
// up scanned for the "most replayed" heatmap in the youtube-vod-highlights route.
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { channel } = await req.json();
  const input = String(channel ?? "").trim();
  if (!input) return NextResponse.json({ error: "Enter a YouTube channel or video URL" }, { status: 400 });

  try {
    // Direct video/stream link — return just that one video.
    const videoId = parseYoutubeVideoId(input);
    if (videoId) {
      const meta = await getVideoInfo(videoId);
      return NextResponse.json({
        channel: meta.channel,
        vods: [{
          uuid: meta.videoId,
          title: meta.title,
          startTime: meta.startTime,
          durationSec: meta.durationSec,
          views: meta.views,
          thumbnail: meta.thumbnail,
        }],
      });
    }

    // Otherwise treat it as a channel reference and list its videos.
    const chUrl = channelVideosUrl(input);
    if (!chUrl) {
      return NextResponse.json(
        { error: "Enter a YouTube channel (e.g. @mkbhd) or paste a video URL" },
        { status: 400 },
      );
    }

    const result = await listChannelVideos(chUrl, 30);
    if (!result) {
      return NextResponse.json({ error: `Channel "${input}" not found on YouTube` }, { status: 404 });
    }
    return NextResponse.json({ channel: result.channel, vods: result.videos });
  } catch (err) {
    console.error("[auto-clipper/youtube-vods]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load YouTube videos" },
      { status: 500 },
    );
  }
}
