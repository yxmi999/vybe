import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { posts } from "@/lib/schema";
import { getTiktokAccount, tiktokErrorMessage } from "@/lib/tiktok-account";
import * as tiktok from "@/lib/platforms/tiktok";

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const accountId = Number(sp.get("accountId"));
  const postId = Number(sp.get("postId"));
  const publishId = sp.get("publishId");
  if (!accountId || !publishId) return NextResponse.json({ error: "Missing parameters" }, { status: 400 });

  try {
    const acct = await getTiktokAccount(session.userId, accountId);
    if (!acct) return NextResponse.json({ error: "TikTok account not found" }, { status: 404 });
    const status = await tiktok.fetchPublishStatus(acct.accessToken, publishId);

    if (postId) {
      const where = and(eq(posts.id, postId), eq(posts.accountId, accountId));
      if (status.status === "FAILED") {
        await db.update(posts).set({ status: "failed", errorMessage: `TikTok: ${status.fail_reason ?? "failed"}` }).where(where);
      } else if (status.status === "PUBLISH_COMPLETE" && status.publicaly_available_post_id?.length) {
        await db.update(posts).set({ platformPostId: String(status.publicaly_available_post_id[0]) }).where(where);
      }
    }
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json({ error: tiktokErrorMessage(err) }, { status: 400 });
  }
}
