import { webhooks } from "@polar-sh/sdk/2026-10";
import { setPolarSubscriptionPlan } from "@/lib/billing";
import { readPolarOrder, readPolarSubscription, verifyPolarWebhook } from "@/lib/polar";
import { recordPayment, reversePayment } from "@/lib/affiliate";

export const runtime = "nodejs";

// Polar webhook. The ONLY place a Polar card subscription grants/revokes a
// plan. Every subscription event carries the full current subscription, so we
// just sync its state. `subscription.updated` alone covers every transition;
// the specific events are handled too in case only those are subscribed.
const SUB_EVENTS = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.cycled",
]);

export async function POST(request: Request) {
  const raw = await request.text();

  let event: webhooks.WebhookPayload;
  try {
    event = await verifyPolarWebhook(raw, request.headers);
  } catch (err) {
    if (err instanceof webhooks.PolarWebhookUnknownTypeError) {
      return new Response("Ignored", { status: 202 }); // valid, but a type this SDK doesn't know
    }
    return new Response("Invalid signature", { status: 403 });
  }

  try {
    if (SUB_EVENTS.has(event.type) && "data" in event) {
      const sub = readPolarSubscription(event.data as Parameters<typeof readPolarSubscription>[0]);
      if (sub) await setPolarSubscriptionPlan(sub);
      else console.warn(`[billing/polar/webhook] ${event.type}: no user id on subscription`);
    }
    // Each charge (first payment and every renewal) is an order. These feed
    // the payments ledger and affiliate commissions; they never touch the plan.
    if (event.type === "order.paid" && "data" in event) {
      const order = readPolarOrder(event.data as Parameters<typeof readPolarOrder>[0]);
      if (order) await recordPayment({ provider: "polar", ...order });
    }
    if (event.type === "order.refunded" && "data" in event) {
      const id = (event.data as { id?: string }).id;
      if (id) await reversePayment("polar", id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[billing/polar/webhook] ${event.type} failed:`, msg);
    return new Response("Handler error", { status: 500 }); // let Polar retry
  }

  return new Response("ok", { status: 200 });
}
