import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { autoResponseLog, accounts, posts } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";

// Recent auto-replies (sent + failed) for the Auto-Respond activity feed.
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: autoResponseLog.id,
      ruleId: autoResponseLog.ruleId,
      commentAuthor: autoResponseLog.commentAuthor,
      commentText: autoResponseLog.commentText,
      replyText: autoResponseLog.replyText,
      status: autoResponseLog.status,
      error: autoResponseLog.error,
      createdAt: autoResponseLog.createdAt,
      platform: accounts.platform,
      username: accounts.username,
      postContent: posts.content,
      platformPostId: posts.platformPostId,
    })
    .from(autoResponseLog)
    .innerJoin(accounts, and(eq(autoResponseLog.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .leftJoin(posts, eq(autoResponseLog.postId, posts.id))
    .orderBy(desc(autoResponseLog.id))
    .limit(50);

  return NextResponse.json(rows.map((r) => ({ ...r, postContent: r.postContent?.split("\n")[0]?.slice(0, 80) ?? null })));
}
