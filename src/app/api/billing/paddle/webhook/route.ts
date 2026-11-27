import { setSubscriptionPlan } from "@/lib/billing";
import { checkPaddleWebhookIp, readPaddleTransaction, readSubscription, verifyWebhook } from "@/lib/paddle";
import { recordPayment, reinstatePayment, reversePayment } from "@/lib/affiliate";

export const runtime = "nodejs";

// Paddle webhook. The ONLY place a card subscription grants/revokes a plan. We
// verify the Paddle-Signature against the raw body, then sync subscription
// lifecycle events to the user.
const SUB_EVENTS = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.activated",
  "subscription.canceled",
  "subscription.paused",
  "subscription.resumed",
]);

export async function POST(request: Request) {
  // Only Paddle's published webhook IPs get past this point.
  const source = await checkPaddleWebhookIp(request);
  if (!source.ok) {
    console.warn(`[billing/paddle/webhook] rejected: ${source.reason}`);
    return new Response(source.status === 503 ? "Try again later" : "Forbidden", { status: source.status });
  }

  const raw = await request.text();
  const sig = request.headers.get("paddle-signature");

  if (!verifyWebhook(raw, sig)) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event: { event_type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  try {
    if (event.event_type && SUB_EVENTS.has(event.event_type) && event.data) {
      const sub = readSubscription(event.data);
      if (sub) await setSubscriptionPlan(sub);
    }
    // Each charge (first payment and renewals) completes a transaction: feeds
    // the payments ledger and affiliate commissions.
    if (event.event_type === "transaction.completed" && event.data) {
      const tx = await readPaddleTransaction(event.data);
      if (tx) await recordPayment({ provider: "paddle", ...tx });
    }
    // Adjustments claw back (or restore) that transaction's commission:
    //   refund (once approved) and chargeback → reverse it;
    //   chargeback_reverse (dispute won)      → restore it.
    // Chargebacks aren't approval-gated like refunds, so only a rejected one is ignored.
    if ((event.event_type === "adjustment.created" || event.event_type === "adjustment.updated") && event.data) {
      const adj = event.data as { action?: string; status?: string; transaction_id?: string };
      if (adj.transaction_id) {
        if (adj.action === "refund" && adj.status === "approved") {
          await reversePayment("paddle", adj.transaction_id, "refund");
        } else if (adj.action === "chargeback" && adj.status !== "rejected") {
          await reversePayment("paddle", adj.transaction_id, "chargeback");
        } else if (adj.action === "chargeback_reverse" && adj.status !== "rejected") {
          await reinstatePayment("paddle", adj.transaction_id);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[billing/paddle/webhook] ${event.event_type} failed:`, msg);
    return new Response("Handler error", { status: 500 }); // let Paddle retry
  }

  return new Response("ok", { status: 200 });
}
