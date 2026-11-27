import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { getArchiveVods, parseTwitchLogin } from "@/lib/twitch-gql";

// GET /api/auto-pilot/channel?login=xqc — a quick look at a Twitch channel for
// the schedule builder: who it is, and their latest VODs (the newest thumbnail
// doubles as the backdrop for framing the clip look in the live preview).
export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const raw = req.nextUrl.searchParams.get("login") ?? "";
  const login = parseTwitchLogin(raw);
  if (!login || !/^[a-zA-Z0-9_]{2,25}$/.test(login)) {
    return NextResponse.json({ error: "Enter a Twitch channel name or link." }, { status: 400 });
  }

  try {
    const data = await getArchiveVods(login);
    if (!data) return NextResponse.json({ error: `No Twitch channel called "${login}".` }, { status: 404 });
    return NextResponse.json({
      login,
      displayName: data.channel.displayName,
      avatar: data.channel.avatar,
      vods: data.vods.slice(0, 3).map((v) => ({
        title: v.title, thumbnail: v.thumbnail, durationSec: v.durationSec, startTime: v.startTime,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Couldn't reach Twitch — try again." }, { status: 502 });
  }
}
