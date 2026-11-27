import { NextResponse } from "next/server";
import { runAutoResponder } from "@/lib/auto-responder";
import { getServerSession } from "@/lib/auth";

export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { checked, replied } = await runAutoResponder();
    return NextResponse.json({ ok: true, checked, replied });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
