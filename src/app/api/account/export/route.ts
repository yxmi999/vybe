import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { exportUserData } from "@/lib/account";

export const runtime = "nodejs";

// "Download my data" — a JSON file with everything stored for this account.
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const data = await exportUserData(session.userId);
  if (!data) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="vybe-data-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
