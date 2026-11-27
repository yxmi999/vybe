import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { posts, accounts, publicAccountColumns } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";

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
  const { accountId, platform, content, mediaUrls, metadata, scheduledAt, status } = body;

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
      status: status ?? "scheduled",
    })
    .returning();

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

  const { id, ...updates } = await req.json();
  if (updates.mediaUrls) updates.mediaUrls = JSON.stringify(updates.mediaUrls);
  await db.update(posts).set(updates).where(eq(posts.id, id));
  return NextResponse.json({ ok: true });
}
