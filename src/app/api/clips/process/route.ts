import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { renderClip } from "@/lib/clip-render";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  if (!body?.videoUrl) return NextResponse.json({ error: "videoUrl is required" }, { status: 400 });

  try {
    // Editor exports derive from an already-counted clip: ledger it (so free-tier
    // TTL applies) but don't charge it against the monthly quota.
    const { url } = await renderClip({ ...body, userId: session.userId, recordKind: "export", countsQuota: false });
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[clips/process]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Processing failed" }, { status: 500 });
  }
}
