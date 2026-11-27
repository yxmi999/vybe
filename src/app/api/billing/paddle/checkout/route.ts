import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { isInterval, isPaidPlan } from "@/lib/billing";
import { createCheckoutUrl, ensurePaddleCustomer, paddleCheckoutMissing, paddlePriceId } from "@/lib/paddle";

export const runtime = "nodejs";

// Opens a Paddle hosted checkout for a card subscription and returns its URL.
// Entitlement is granted by the Paddle webhook on subscription.created, not here.
export async function POST(request: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const missing = paddleCheckoutMissing();
  if (missing.length) {
    console.error("[billing/paddle/checkout] not configured, missing:", missing.join(", "));
    return NextResponse.json({ error: "Card payments are not configured" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const plan = body?.plan;
  const interval = body?.interval === "yearly" ? "yearly" : "monthly";
  const branded = body?.branded === true; // discounted, keeps the watermark
  if (!isPaidPlan(plan) || !isInterval(interval)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const price = paddlePriceId(plan, interval, branded);
  if (!price) {
    return NextResponse.json({ error: `No Paddle price for ${plan}/${interval}${branded ? " (with watermark)" : ""}` }, { status: 503 });
  }

  try {
    const customer = await ensurePaddleCustomer(session.userId, session.email, session.name);
    const url = await createCheckoutUrl({ userId: session.userId, customerId: customer, priceId: price });
    return NextResponse.json({ url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[billing/paddle/checkout]", msg);
    return NextResponse.json({ error: "Could not start card checkout" }, { status: 500 });
  }
}
