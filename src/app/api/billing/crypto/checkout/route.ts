import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { client } from "@/lib/db";
import { isInterval, isPaidPlan, priceFor } from "@/lib/billing";
import { createInvoice, encodeOrderId, nowpaymentsEnabled } from "@/lib/nowpayments";

export const runtime = "nodejs";

// Creates a NOWPayments invoice for a one-time time-block purchase and returns
// its hosted invoice URL. Entitlement is granted later by the IPN webhook on a
// confirmed payment, never here.
export async function POST(request: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!nowpaymentsEnabled()) return NextResponse.json({ error: "Crypto payments are not configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const plan = body?.plan;
  const interval = body?.interval === "yearly" ? "yearly" : "monthly";
  const branded = body?.branded === true; // discounted, keeps the watermark
  if (!isPaidPlan(plan) || !isInterval(interval)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  // Don't let a crypto purchase collide with what the user already has:
  //  • an active card subscription would keep billing while the crypto grant
  //    overwrote billing_provider (we'd lose track of the card sub);
  //  • a different plan mid-period would silently convert the remaining time.
  // Buying the SAME plan again just stacks more time onto it.
  const cur = await client.execute({
    sql: "SELECT plan, billing_provider, subscription_status, current_period_end FROM users WHERE id = ?",
    args: [session.userId],
  });
  const u = cur.rows[0] as { plan?: string; billing_provider?: string; subscription_status?: string; current_period_end?: string } | undefined;
  const paidNow = u?.plan && u.plan !== "free";
  if (paidNow && (u.billing_provider === "paddle" || u.billing_provider === "polar")
      && ["active", "trialing", "past_due"].includes(String(u.subscription_status))) {
    return NextResponse.json(
      { error: "You already have a card subscription. Manage or cancel it from Billing before paying with crypto." },
      { status: 409 },
    );
  }
  const periodEnd = u?.current_period_end ? Date.parse(u.current_period_end) : NaN;
  if (paidNow && u.billing_provider === "crypto" && Number.isFinite(periodEnd) && periodEnd > Date.now() && u.plan !== plan) {
    const until = new Date(periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return NextResponse.json(
      { error: `Your ${u.plan} plan is paid until ${until}. Buy ${u.plan} to extend it, or switch plans after it ends.` },
      { status: 409 },
    );
  }

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;

  try {
    const invoice = await createInvoice({
      amountUsd: priceFor(plan, interval, branded),
      orderId: encodeOrderId(session.userId, plan, interval, branded),
      description: `Vybe ${plan}${branded ? " (with watermark)" : ""} — ${interval === "yearly" ? "1 year" : "1 month"}`,
      successUrl: `${origin}/billing?status=success`,
      cancelUrl: `${origin}/billing?status=cancelled`,
      ipnUrl: `${origin}/api/billing/crypto/webhook`,
    });
    return NextResponse.json({ url: invoice.invoiceUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[billing/crypto/checkout]", msg);
    return NextResponse.json({ error: "Could not start crypto checkout" }, { status: 500 });
  }
}
