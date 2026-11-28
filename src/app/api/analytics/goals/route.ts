import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { getServerSession } from "@/lib/auth";
import { normalizeGoals } from "@/lib/performance";

// Per-platform goals for the analytics "did it hit expectations?" check.
// Stored as JSON on the user: { youtube: { views: 10000, likes: 400, engagementRate: 5 }, ... }.

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [row] = await db.select({ viewGoals: users.viewGoals }).from(users).where(eq(users.id, session.userId)).limit(1);
  let raw: unknown = {};
  try { raw = JSON.parse(row?.viewGoals ?? "{}"); } catch { /* corrupt → no goals */ }
  return NextResponse.json(normalizeGoals(raw));
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const goals = normalizeGoals(await req.json().catch(() => ({})));
  await db.update(users).set({ viewGoals: JSON.stringify(goals) }).where(eq(users.id, session.userId));
  return NextResponse.json(goals);
}
