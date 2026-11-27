import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoPilots } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { runOneAutoPilot } from "@/lib/auto-pilot";

// Manually trigger one of the caller's own Auto-Pilot schedules. Same engine the
// cron uses — handy for testing a pilot end-to-end without waiting for its slot.
export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const pilotId = Number(id);
  if (!Number.isFinite(pilotId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const pilot = (await db
    .select()
    .from(autoPilots)
    .where(and(eq(autoPilots.id, pilotId), eq(autoPilots.userId, session.userId)))
    .limit(1))[0];
  if (!pilot) return NextResponse.json({ error: "Auto-Pilot not found" }, { status: 404 });

  try {
    const result = await runOneAutoPilot(pilot);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[auto-pilot/run-now]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Run failed" }, { status: 500 });
  }
}
