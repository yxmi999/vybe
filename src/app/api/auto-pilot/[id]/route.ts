import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoPilots, accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { getUserPlan, cappedClipsPerRun } from "@/lib/plan";
import { cleanPilotTemplate } from "@/lib/auto-pilot";
import { safeTimeZone } from "@/lib/timezone";

const CADENCES = ["daily", "weekly", "specific_days"];

async function ownPilot(userId: number, idParam: string) {
  const id = Number(idParam);
  if (!Number.isFinite(id)) return null;
  return (await db.select().from(autoPilots)
    .where(and(eq(autoPilots.id, id), eq(autoPilots.userId, userId))).limit(1))[0] ?? null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const pilot = await ownPilot(session.userId, id);
  if (!pilot) return NextResponse.json({ error: "Auto-Pilot not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const patch: Partial<typeof autoPilots.$inferInsert> = {};

  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.autoPost === "boolean") patch.autoPost = body.autoPost;
  if (typeof body.liveMode === "boolean" && body.liveMode !== pilot.liveMode) {
    patch.liveMode = body.liveMode;
    // Switching modes: check the channel right away, starting fresh.
    patch.nextRunAt = new Date(Date.now() + 60_000).toISOString();
    patch.liveVodId = null; patch.liveOffset = 0; patch.liveClips = 0;
    patch.liveBaseline = null; patch.liveSamples = 0; patch.liveState = null;
    patch.liveScoreRef = null; patch.liveWindows = 0;
  }
  if (typeof body.channel === "string" && body.channel.trim()) patch.channel = body.channel.trim();
  if (body.minConfidence != null) patch.minConfidence = Math.max(0, Math.min(100, Number(body.minConfidence) || 0));
  if (body.clipsPerRun != null) {
    const plan = await getUserPlan(session.userId);
    patch.clipsPerRun = cappedClipsPerRun(plan, Number(body.clipsPerRun) || 1);
  }
  if (Array.isArray(body.postTimes)) {
    const times = body.postTimes.filter((t: unknown) => typeof t === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(t));
    if (times.length) patch.postTimes = JSON.stringify(times);
  }
  if (typeof body.timezone === "string") patch.timezone = safeTimeZone(body.timezone);
  if (typeof body.cadence === "string" && CADENCES.includes(body.cadence)) patch.cadence = body.cadence;
  // Keep cadence and its day list consistent: daily carries no days; otherwise
  // store the provided list. (The client always sends `days`, so guard on the
  // effective cadence rather than blindly writing it.)
  const effCadence = patch.cadence ?? pilot.cadence;
  if (effCadence === "daily") {
    patch.days = null;
  } else if (Array.isArray(body.days)) {
    patch.days = JSON.stringify(body.days.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6));
  }
  if (body.targetAccountId != null) {
    const acct = (await db.select().from(accounts)
      .where(and(eq(accounts.id, Number(body.targetAccountId)), eq(accounts.userId, session.userId))).limit(1))[0];
    // Only accept a YouTube account the user owns — mirrors the create route.
    if (acct && acct.platform === "youtube") patch.targetAccountId = acct.id;
  }
  if (body.template !== undefined) patch.template = await cleanPilotTemplate(session.userId, body.template);
  // Re-enabling a paused schedule should make it run soon rather than wait.
  if (patch.enabled === true && pilot.enabled === false) patch.nextRunAt = new Date(Date.now() + 60_000).toISOString();

  if (Object.keys(patch).length === 0) return NextResponse.json(pilot);

  const [updated] = await db.update(autoPilots).set(patch).where(eq(autoPilots.id, pilot.id)).returning();
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const pilot = await ownPilot(session.userId, id);
  if (!pilot) return NextResponse.json({ error: "Auto-Pilot not found" }, { status: 404 });

  await db.delete(autoPilots).where(eq(autoPilots.id, pilot.id));
  return NextResponse.json({ ok: true });
}
