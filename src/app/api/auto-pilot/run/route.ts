import { NextRequest, NextResponse } from "next/server";
import { runDueAutoPilots } from "@/lib/auto-pilot";
import { refreshAutoPilotOutcomes } from "@/lib/outcomes";
import { refreshLeaderboardMetrics } from "@/lib/leaderboard";
import { isCronAuthorized } from "@/lib/cron-auth";

// Runs every due Auto-Pilot schedule. Driven by Vercel Cron (see vercel.json).
// When CRON_SECRET is set, Vercel sends it as a Bearer token — we require it so
// the endpoint isn't public. Same pattern as /api/clips/cleanup.
export const maxDuration = 300;

const authorized = (req: NextRequest) => isCronAuthorized(req);

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const results = await runDueAutoPilots();
    // Piggyback: pull fresh view counts for recent Auto-Pilot posts so the
    // signal-vs-outcome calibration data accumulates without its own cron.
    const outcomes = await refreshAutoPilotOutcomes();
    // Same idea for the views leaderboard (watermarked videos).
    const leaderboard = await refreshLeaderboardMetrics();
    return NextResponse.json({ ok: true, ran: results.length, results, outcomes, leaderboard });
  } catch (err) {
    console.error("[auto-pilot/run]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Auto-Pilot run failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
