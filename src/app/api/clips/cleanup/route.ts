import { NextRequest, NextResponse } from "next/server";
import { client } from "@/lib/db";
import { deleteStored } from "@/lib/storage";
import { downgradeExpired } from "@/lib/billing";
import { refreshLeaderboardMetrics } from "@/lib/leaderboard";
import { refreshStaleAnalytics } from "@/lib/post-metrics";
import { isCronAuthorized } from "@/lib/cron-auth";

// Deletes expired clip blobs (free-tier TTL) and their ledger rows. Runs on a
// schedule via Vercel Cron (see vercel.json). When CRON_SECRET is set, Vercel
// sends it as a Bearer token — we require it so the endpoint isn't public.
export const maxDuration = 300;

async function runCleanup() {
  const now = new Date().toISOString();
  let res;
  try {
    res = await client.execute({
      sql: "SELECT id, url FROM clips WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 500",
      args: [now],
    });
  } catch {
    return { ok: true, deleted: 0, note: "clips table not ready" };
  }

  const rows = res.rows as unknown as { id: number; url: string }[];
  let deleted = 0;
  for (const row of rows) {
    await deleteStored(row.url);
    try {
      await client.execute({ sql: "DELETE FROM clips WHERE id = ?", args: [row.id] });
      deleted++;
    } catch { /* skip and continue */ }
  }
  // Same cadence handles lapsed crypto time-blocks: drop expired users to free.
  const downgraded = await downgradeExpired();
  // Daily safety net for leaderboard view counts, in case Auto-Pilot's more
  // frequent cron isn't scheduled on this deployment.
  const leaderboard = await refreshLeaderboardMetrics(100);
  // Same safety net for the Analytics goal check, if the 5-min cron isn't running.
  const analytics = await refreshStaleAnalytics(100).catch(() => null);
  return { ok: true, deleted, downgraded, leaderboard, analytics };
}

const authorized = (req: NextRequest) => isCronAuthorized(req);

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await runCleanup());
}

// Allow manual triggering (e.g. an admin button) with the same auth.
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await runCleanup());
}
