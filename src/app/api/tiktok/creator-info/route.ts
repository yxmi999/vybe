import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { getTiktokAccount, tiktokErrorMessage } from "@/lib/tiktok-account";
import * as tiktok from "@/lib/platforms/tiktok";

// Fetched every time the TikTok posting screen opens, as TikTok requires:
// it decides which privacy options, interaction toggles and max duration to show.
export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accountId = Number(req.nextUrl.searchParams.get("accountId"));
  if (!accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });

  try {
    const acct = await getTiktokAccount(session.userId, accountId);
    if (!acct) return NextResponse.json({ error: "TikTok account not found" }, { status: 404 });
    const info = await tiktok.queryCreatorInfo(acct.accessToken);
    return NextResponse.json(info);
  } catch (err) {
    console.error("[tiktok creator-info]", err);
    return NextResponse.json({ error: tiktokErrorMessage(err) }, { status: 400 });
  }
}
