import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { isInterval, isPaidPlan } from "@/lib/billing";
import { createPolarCheckoutUrl, polarEnabled, polarProductId } from "@/lib/polar";

export const runtime = "nodejs";

// Opens a Polar hosted checkout for a card subscription and returns its URL.
// Entitlement is granted by the Polar webhook, not here.
export async function POST(request: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!polarEnabled()) return NextResponse.json({ error: "Card payments are not configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const plan = body?.plan;
  const interval = body?.interval === "yearly" ? "yearly" : "monthly";
  const branded = body?.branded === true; // discounted, keeps the watermark
  if (!isPaidPlan(plan) || !isInterval(interval)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const productId = polarProductId(plan, interval, branded);
  if (!productId) {
    return NextResponse.json({ error: `No Polar product for ${plan}/${interval}${branded ? " (with watermark)" : ""}` }, { status: 503 });
  }

  try {
    const origin = (process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin).replace(/\/$/, "");
    const url = await createPolarCheckoutUrl({
      userId: session.userId,
      email: session.email,
      name: session.name,
      productId,
      origin,
    });
    return NextResponse.json({ url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[billing/polar/checkout]", msg);
    return NextResponse.json({ error: "Could not start card checkout" }, { status: 500 });
  }
}
