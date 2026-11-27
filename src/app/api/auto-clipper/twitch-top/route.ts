import { NextRequest, NextResponse } from "next/server";
import { getTopClips, parseTwitchLogin } from "@/lib/twitch-gql";
import { getServerSession } from "@/lib/auth";

// Keyless: top clips come from Twitch's public GQL (same client-ID rotation as
// the VOD scanner), so no TWITCH_CLIENT_ID/SECRET is required — like Kick.
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { channel, days = 7, limit = 20 } = await req.json();
  const login = parseTwitchLogin(String(channel ?? ""));
  if (!login) return NextResponse.json({ error: "Enter a Twitch channel" }, { status: 400 });

  try {
    const result = await getTopClips(
      login,
      Math.max(1, Math.min(365, Number(days) || 7)),
      Math.max(1, Math.min(100, Number(limit) || 20)),
    );
    if (!result) return NextResponse.json({ error: `Channel "${channel}" not found` }, { status: 404 });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load clips" },
      { status: 500 },
    );
  }
}
