import { NextRequest, NextResponse } from "next/server";
import { runScheduler } from "@/lib/scheduler";
import { runAutoResponder } from "@/lib/auto-responder";
import { getServerSession } from "@/lib/auth";
import { isCronAuthorized } from "@/lib/cron-auth";

// Publishing downloads the clip from Blob and re-uploads it to the platform.
export const maxDuration = 300;

async function handle() {
  const errors: string[] = [];

  try {
    await runScheduler();
  } catch (err) {
    console.error("[scheduler] runScheduler error:", err);
    errors.push(`scheduler: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await runAutoResponder();
  } catch (err) {
    console.error("[scheduler] runAutoResponder error:", err);
    errors.push(`auto-responder: ${err instanceof Error ? err.message : String(err)}`);
  }

  return NextResponse.json({ ok: errors.length === 0, ran: new Date().toISOString(), errors });
}

// Vercel Cron calls this endpoint via GET with Authorization: Bearer <CRON_SECRET>
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return handle();
}

// Manual trigger from the dashboard (requires session)
export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return handle();
}
