import { NextResponse } from "next/server";
import { runAutoResponder } from "@/lib/auto-responder";
import { getServerSession } from "@/lib/auth";

// "Run now" on the Auto-Respond page — only this user's rules. The cron runs
// everyone's via /api/scheduler.
export const maxDuration = 120;

export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await runAutoResponder({ userId: session.userId });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
