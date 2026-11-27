import { NextRequest, NextResponse } from "next/server";
import { and, eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns } from "@/lib/schema";
import { getServerSession } from "@/lib/auth";
import { parseCampaignInput } from "@/lib/campaigns";

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.select().from(campaigns)
    .where(eq(campaigns.userId, session.userId))
    .orderBy(asc(campaigns.createdAt), asc(campaigns.id));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = parseCampaignInput(await req.json().catch(() => ({})));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const existing = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.userId, session.userId));
  if (existing.length >= 100) return NextResponse.json({ error: "Campaign limit reached (100)." }, { status: 400 });

  // The first campaign becomes the default so unassigned videos earn right away.
  const isDefault = parsed.value.isDefault === true || existing.length === 0;
  if (isDefault) {
    await db.update(campaigns).set({ isDefault: false }).where(and(eq(campaigns.userId, session.userId), eq(campaigns.isDefault, true)));
  }
  const [row] = await db.insert(campaigns).values({
    userId: session.userId,
    name: parsed.value.name!,
    cpm: parsed.value.cpm!,
    currency: parsed.value.currency ?? "USD",
    maxPayout: parsed.value.maxPayout ?? null,
    minPayout: parsed.value.minPayout ?? null,
    isDefault,
  }).returning();
  return NextResponse.json(row, { status: 201 });
}
