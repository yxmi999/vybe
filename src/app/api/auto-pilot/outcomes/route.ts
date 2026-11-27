import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { getSignalOutcomes } from "@/lib/outcomes";

// Signal calibration: how the detection signals (chat confidence/lift, AI
// virality, hook strength) correlate with real views on published Auto-Pilot
// clips. Powers the calibration panel on /auto-pilot.
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const data = await getSignalOutcomes(session.userId);
  return NextResponse.json(data);
}
