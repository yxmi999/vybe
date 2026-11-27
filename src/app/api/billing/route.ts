import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { client } from "@/lib/db";
import { normalizePlan } from "@/lib/plan";
import { cardBrandedEnabled, cardProvider } from "@/lib/card-provider";
import { nowpaymentsEnabled } from "@/lib/nowpayments";

export const runtime = "nodejs";

// Billing snapshot for the /billing page: current plan, how it was paid, when it
// lapses/renews, whether a card portal is available, and which payment methods
// are configured (so the UI only shows buttons that work).
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await client.execute({
    sql: `SELECT plan, billing_provider, paddle_customer_id, subscription_status, current_period_end, keep_watermark
            FROM users WHERE id = ?`,
    args: [session.userId],
  });
  const row = res.rows[0] as
    | {
        plan?: string;
        billing_provider?: string;
        paddle_customer_id?: string;
        subscription_status?: string;
        current_period_end?: string;
        keep_watermark?: number;
      }
    | undefined;

  const card = cardProvider();
  return NextResponse.json({
    plan: normalizePlan(row?.plan),
    provider: row?.billing_provider ?? null,
    status: row?.subscription_status ?? null,
    currentPeriodEnd: row?.current_period_end ?? null,
    hasCardBilling: Boolean(row?.paddle_customer_id) || row?.billing_provider === "polar",
    // The signed-in user's own Paddle customer id (ctm_…), for Paddle Retain's pwCustomer.
    paddleCustomerId: row?.paddle_customer_id ?? null,
    keepWatermark: Number(row?.keep_watermark ?? 0) === 1,
    // Card checkout for the discounted watermark plans needs its own prices/products.
    cardProvider: card,
    methods: { crypto: nowpaymentsEnabled(), card: card !== null, cardBranded: cardBrandedEnabled() },
  });
}
