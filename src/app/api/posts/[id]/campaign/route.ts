import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, campaigns, posts } from "@/lib/schema";
import { getServerSession } from "@/lib/auth";

// PUT /api/posts/{id}/campaign  { campaignId: number | null }
// null = follow the default campaign.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const postId = Number((await params).id);
  if (!Number.isInteger(postId)) return NextResponse.json({ error: "Invalid post id" }, { status: 400 });

  // The post must belong to one of this user's accounts.
  const [owned] = await db.select({ id: posts.id }).from(posts)
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .where(eq(posts.id, postId)).limit(1);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as { campaignId?: unknown };
  let campaignId: number | null = null;
  if (body.campaignId !== null && body.campaignId !== undefined) {
    campaignId = Number(body.campaignId);
    if (!Number.isInteger(campaignId)) return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
    const [c] = await db.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, session.userId))).limit(1);
    if (!c) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  await db.update(posts).set({ campaignId }).where(eq(posts.id, postId));
  return NextResponse.json({ ok: true, campaignId });
}
