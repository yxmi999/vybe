import { NextRequest, NextResponse } from "next/server";
import { runScheduler } from "@/lib/scheduler";
import { runAutoResponder } from "@/lib/auto-responder";
import { refreshStaleAnalytics } from "@/lib/post-metrics";
import { getServerSession } from "@/lib/auth";
import { isCronAuthorized } from "@/lib/cron-auth";

// Publishing downloads the clip from Blob and re-uploads it to the platform.
export const maxDuration = 300;

// Background jobs run in priority order; the optional ones are skipped when
// publishing already used most of the time budget, and catch up next run.
const SOFT_BUDGET_MS = 200_000;

async function handle(scope: { userId?: number } = {}) {
  const started = Date.now();
  const errors: string[] = [];
  const out: Record<string, unknown> = {};

  try {
    await runScheduler();
  } catch (err) {
    console.error("[scheduler] runScheduler error:", err);
    errors.push(`scheduler: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Auto-replies: every 5 min with the cron. Per-account issues (expired
  // token, reply limit) are reported on each rule, not as cron failures.
  if (Date.now() - started < SOFT_BUDGET_MS) {
    try {
      const r = await runAutoResponder(scope);
      out.autoResponder = { checked: r.checked, replied: r.replied, failed: r.failed, skipped: r.skipped, notes: r.errors.length };
    } catch (err) {
      console.error("[scheduler] runAutoResponder error:", err);
      errors.push(`auto-responder: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else out.autoResponder = "deferred";

  // Fresh metrics keep the Analytics goal check accurate. Cron only — a
  // dashboard trigger shouldn't spend everyone's API quota.
  if (scope.userId == null && Date.now() - started < SOFT_BUDGET_MS) {
    try {
      out.analytics = await refreshStaleAnalytics(20);
    } catch (err) {
      console.error("[scheduler] refreshStaleAnalytics error:", err);
      errors.push(`analytics: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({ ok: errors.length === 0, ran: new Date().toISOString(), ...out, errors });
}

// Vercel Cron / GitHub Actions call this via GET with Authorization: Bearer <CRON_SECRET>
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return handle();
}

// Manual trigger from the dashboard (requires session). Auto-replies only run
// for the signed-in user's rules.
export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return handle({ userId: session.userId });
}
