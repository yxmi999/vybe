import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { getArchiveVods, parseTwitchLogin } from "@/lib/twitch-gql";

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { channel } = await req.json();
  if (!channel || !String(channel).trim()) {
    return NextResponse.json({ error: "Enter a Twitch channel" }, { status: 400 });
  }
  const login = parseTwitchLogin(channel);
  if (!login) return NextResponse.json({ error: "Enter a Twitch channel" }, { status: 400 });

  try {
    const result = await getArchiveVods(login);
    if (!result) {
      return NextResponse.json({ error: `Channel "${login}" not found on Twitch` }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[auto-clipper/twitch-vods]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load Twitch VODs" },
      { status: 500 },
    );
  }
}
