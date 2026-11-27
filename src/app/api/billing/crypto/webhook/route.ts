import { grantPlanUntil, priceFor } from "@/lib/billing";
import { decodeOrderId, verifyIpn } from "@/lib/nowpayments";
import { creditCommission, deletePayment, insertPayment } from "@/lib/affiliate";

export const runtime = "nodejs";

// NOWPayments IPN. The ONLY place a crypto purchase grants a plan. We verify the
// HMAC-SHA512 signature against the raw body, then on a fully-paid status extend
// the user's plan by the purchased interval — once per order (see the ledger
// claim below), however many paid-status IPNs arrive.
const PAID = new Set(["finished", "confirmed", "sending"]);

export async function POST(request: Request) {
  const raw = await request.text();
  const sig = request.headers.get("x-nowpayments-sig");

  if (!verifyIpn(raw, sig)) {
    return new Response("Invalid signature", { status: 400 });
  }

  let payload: { payment_status?: string; order_id?: string; price_amount?: number | string; price_currency?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  if (!payload.payment_status || !PAID.has(payload.payment_status)) {
    return new Response("ok", { status: 200 }); // not yet paid — nothing to do
  }

  const order = decodeOrderId(payload.order_id ?? "");
  if (!order) {
    console.error("[billing/crypto/webhook] undecodable order_id:", payload.order_id);
    return new Response("ok", { status: 200 }); // don't make NOWPayments retry a junk order
  }

  // The invoice must be in USD and at least the lowest legitimate price for
  // this plan/interval. Our checkout always creates it that way, so anything
  // below means a tampered or foreign invoice — log it and grant nothing.
  // (The floor is the cheapest variant, not today's exact price, so an invoice
  // created before a price increase still grants what the buyer paid for.)
  const expected = Math.min(priceFor(order.plan, order.interval, false), priceFor(order.plan, order.interval, true));
  const paidUsd = Number(payload.price_amount);
  if ((payload.price_currency ?? "").toLowerCase() !== "usd" || !(paidUsd + 0.01 >= expected)) {
    console.error(`[billing/crypto/webhook] amount mismatch for ${payload.order_id}: ${payload.price_amount} ${payload.price_currency}, expected ${expected} usd`);
    return new Response("ok", { status: 200 });
  }

  // NOWPayments sends an IPN for each of confirmed → sending → finished, all of
  // which count as paid. Claim the order in the payments ledger first, so only
  // the first delivery grants time (grantPlanUntil stacks, so granting on every
  // delivery would hand out up to three periods for one payment).
  const amountCents = Math.round((Number(payload.price_amount) || 0) * 100);
  let paymentId = 0;
  try {
    const claimed = await insertPayment({
      userId: order.userId, provider: "crypto", externalId: payload.order_id!, amountCents,
      currency: payload.price_currency ?? "usd",
    });
    if (!claimed.isNew) return new Response("ok", { status: 200 }); // already granted
    paymentId = claimed.id;
  } catch (err) {
    console.error("[billing/crypto/webhook] ledger failed:", err instanceof Error ? err.message : err);
    return new Response("Ledger failed", { status: 500 }); // let it retry
  }

  try {
    await grantPlanUntil({ userId: order.userId, plan: order.plan, interval: order.interval, provider: "crypto", branded: order.branded });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[billing/crypto/webhook] grant failed:", msg);
    // Release the claim so the retry can grant.
    await deletePayment(paymentId).catch(() => {});
    return new Response("Grant failed", { status: 500 }); // let it retry
  }

  try { await creditCommission(paymentId); } catch (err) {
    console.error("[billing/crypto/webhook] commission failed:", err instanceof Error ? err.message : err);
  }

  return new Response("ok", { status: 200 });
}
