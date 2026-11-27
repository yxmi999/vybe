import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { client } from "@/lib/db";
import { createPortalUrl, paddleEnabled } from "@/lib/paddle";
import { createPolarPortalUrl, polarEnabled } from "@/lib/polar";

export const runtime = "nodejs";

// Returns the card provider's customer-portal URL (manage/cancel/change card),
// for whichever provider the user's subscription lives on. Only meaningful for
// card subscribers — crypto purchases have nothing to manage.
export async function POST(request: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await client.execute({
    sql: "SELECT billing_provider, paddle_customer_id FROM users WHERE id = ?",
    args: [session.userId],
  });
  const row = res.rows[0] as { billing_provider?: string; paddle_customer_id?: string } | undefined;

  try {
    if (row?.billing_provider === "polar") {
      if (!polarEnabled()) return NextResponse.json({ error: "Card billing is not configured" }, { status: 503 });
      const origin = (process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "");
      return NextResponse.json({ url: await createPolarPortalUrl(session.userId, origin) });
    }

    if (!paddleEnabled()) return NextResponse.json({ error: "Card billing is not configured" }, { status: 503 });
    if (!row?.paddle_customer_id) return NextResponse.json({ error: "No card billing account yet" }, { status: 400 });
    return NextResponse.json({ url: await createPortalUrl(row.paddle_customer_id) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[billing/portal]", msg);
    return NextResponse.json({ error: "Could not open billing portal" }, { status: 500 });
  }
}
