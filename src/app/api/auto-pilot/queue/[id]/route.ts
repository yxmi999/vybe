import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db, client } from "@/lib/db";
import { posts, accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { deleteStored } from "@/lib/storage";

// Approve (schedule it) or reject (discard the clip) one review-queue item.
// Ownership is enforced by joining through the user's accounts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const postId = Number(id);
  if (!Number.isFinite(postId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  // Confirm this draft belongs to the caller (post.account.userId === user).
  const row = (await db
    .select({ post: posts, account: accounts })
    .from(posts)
    .innerJoin(accounts, eq(posts.accountId, accounts.id))
    .where(and(eq(posts.id, postId), eq(accounts.userId, session.userId)))
    .limit(1))[0];
  if (!row) return NextResponse.json({ error: "Clip not found" }, { status: 404 });

  const { action, scheduledAt } = await req.json().catch(() => ({}));

  if (action === "approve") {
    const when = (typeof scheduledAt === "string" && scheduledAt) ? scheduledAt : new Date().toISOString();
    await db.update(posts).set({ status: "scheduled", scheduledAt: when }).where(eq(posts.id, postId));
    return NextResponse.json({ ok: true, status: "scheduled", scheduledAt: when });
  }

  if (action === "reject") {
    // Discard the rendered file + its ledger row, then drop the draft.
    let media: string[] = [];
    try { media = row.post.mediaUrls ? JSON.parse(row.post.mediaUrls) : []; } catch { /* ignore */ }
    for (const url of media) {
      await deleteStored(url).catch(() => {});
      await client.execute({ sql: "DELETE FROM clips WHERE url = ?", args: [url] }).catch(() => {});
    }
    await db.delete(posts).where(eq(posts.id, postId));
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
}
