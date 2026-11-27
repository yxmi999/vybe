import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { checkClipQuota, requiresWatermark } from "@/lib/plan";

// Current user's monthly clip usage vs. their plan limit. Powers a "X / Y clips
// this month" indicator and lets the UI warn before a hard 403.
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [q, watermark] = await Promise.all([checkClipQuota(session.userId), requiresWatermark(session.userId)]);
  return NextResponse.json({
    plan: q.plan,
    used: q.used,
    limit: Number.isFinite(q.limit) ? q.limit : null, // null = unlimited
    // Whether this user's exports get the brand watermark burned in (free
    // plan, or a paid plan bought with "keep the watermark") — lets previews
    // show exactly what the render will look like.
    watermark,
  });
}
