import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns, posts } from "@/lib/schema";
import { getServerSession } from "@/lib/auth";
import { parseCampaignInput } from "@/lib/campaigns";

async function ownCampaign(userId: number, rawId: string) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.userId, userId))).limit(1);
  return row ?? null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const campaign = await ownCampaign(session.userId, (await params).id);
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = parseCampaignInput(await req.json().catch(() => ({})), true);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // Only one default per user.
  if (parsed.value.isDefault === true) {
    await db.update(campaigns).set({ isDefault: false })
      .where(and(eq(campaigns.userId, session.userId), eq(campaigns.isDefault, true)));
  }
  const [row] = await db.update(campaigns).set(parsed.value).where(eq(campaigns.id, campaign.id)).returning();
  return NextResponse.json(row);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const campaign = await ownCampaign(session.userId, (await params).id);
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // SQLite doesn't enforce the FK's ON DELETE SET NULL unless foreign_keys is
  // on, so unassign explicitly — those videos fall back to the default.
  await db.update(posts).set({ campaignId: null }).where(eq(posts.campaignId, campaign.id));
  await db.delete(campaigns).where(eq(campaigns.id, campaign.id));

  // Deleting the default would leave unassigned videos earning nothing —
  // promote the oldest remaining campaign instead.
  if (campaign.isDefault) {
    const [next] = await db.select({ id: campaigns.id }).from(campaigns)
      .where(eq(campaigns.userId, session.userId)).orderBy(asc(campaigns.id)).limit(1);
    if (next) await db.update(campaigns).set({ isDefault: true }).where(eq(campaigns.id, next.id));
  }
  return NextResponse.json({ ok: true });
}
