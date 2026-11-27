import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { isDesktop } from "@/lib/desktop";
import { getLeaderboard, getMyLeaderboardVideos, parsePeriod, setLeaderboardHidden } from "@/lib/leaderboard";

export const runtime = "nodejs";

// GET   ?period=2026-11 | 2026 | year → board + your standing + your videos
// PATCH { hidden: boolean }            → show/hide your name on the board
export async function GET(req: NextRequest) {
  if (isDesktop()) return NextResponse.json({ error: "The leaderboard is only on the Vybe website." }, { status: 404 });
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const period = parsePeriod(req.nextUrl.searchParams.get("period"));
  try {
    const [board, myVideos] = await Promise.all([
      getLeaderboard(period, session.userId),
      getMyLeaderboardVideos(session.userId, period),
    ]);
    return NextResponse.json({ ...board, myVideos });
  } catch (err) {
    console.error("[leaderboard]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load the leaderboard." }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (typeof body?.hidden !== "boolean") return NextResponse.json({ error: "hidden must be a boolean" }, { status: 400 });
  await setLeaderboardHidden(session.userId, body.hidden);
  return NextResponse.json({ ok: true });
}
