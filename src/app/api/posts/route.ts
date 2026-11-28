import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { posts, accounts, publicAccountColumns } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import { publishPostNow } from "@/lib/scheduler";

// "Post now" publishes inside the request, and a video upload to the platform
// can take a while.
export const maxDuration = 300;

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({ post: posts, account: publicAccountColumns })
    .from(posts)
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .orderBy(desc(posts.scheduledAt));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { accountId, platform, content, mediaUrls, metadata, status } = body;
  // "Post now": create it due immediately and publish in this request instead
  // of waiting for the next scheduler run (the cron only fires every ~5 min).
  const publishNow = body.publishNow === true;
  const scheduledAt = publishNow ? new Date().toISOString() : body.scheduledAt;

  // Verify account belongs to this user
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, session.userId)))
    .limit(1);
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  // Store a canonical UTC ISO string: the scheduler compares it lexically
  // against `new Date().toISOString()`. Clients send a UTC instant.
  const when = new Date(scheduledAt);
  if (!scheduledAt || Number.isNaN(when.getTime())) {
    return NextResponse.json({ error: "Pick a valid date and time." }, { status: 400 });
  }

  const [row] = await db
    .insert(posts)
    .values({
      accountId,
      platform,
      content,
      mediaUrls: mediaUrls ? JSON.stringify(mediaUrls) : null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      scheduledAt: when.toISOString(),
      status: publishNow ? "scheduled" : (status ?? "scheduled"),
    })
    .returning();

  if (publishNow) {
    const after = await publishPostNow(row.id);
    return NextResponse.json(after ?? row);
  }
  return NextResponse.json(row);
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json();
  // Join to verify ownership
  const [post] = await db
    .select({ post: posts })
    .from(posts)
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .where(eq(posts.id, id))
    .limit(1);
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.delete(posts).where(eq(posts.id, id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, ...body } = await req.json();

  // Join to verify ownership, as DELETE does.
  const [owned] = await db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .where(eq(posts.id, id))
    .limit(1);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only user-editable fields — never accountId, platformPostId, publishedAt, ...
  const updates: Partial<typeof posts.$inferInsert> = {};
  if (typeof body.content === "string") updates.content = body.content;
  if (body.mediaUrls !== undefined) updates.mediaUrls = body.mediaUrls ? JSON.stringify(body.mediaUrls) : null;
  if (body.metadata !== undefined) {
    updates.metadata = body.metadata == null ? null : typeof body.metadata === "string" ? body.metadata : JSON.stringify(body.metadata);
  }
  if (body.scheduledAt !== undefined) {
    const when = new Date(body.scheduledAt);
    if (Number.isNaN(when.getTime())) return NextResponse.json({ error: "Pick a valid date and time." }, { status: 400 });
    updates.scheduledAt = when.toISOString();
  }
  if (body.status !== undefined) {
    if (!["scheduled", "draft"].includes(body.status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    updates.status = body.status;
  }
  if (body.errorMessage === null) updates.errorMessage = null;
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

  await db.update(posts).set(updates).where(eq(posts.id, id));
  return NextResponse.json({ ok: true });
}
