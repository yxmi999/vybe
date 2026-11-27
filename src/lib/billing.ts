// Provider-agnostic billing core. Both payment paths — Paddle (card
// subscriptions) and NOWPayments (crypto time-blocks) — funnel through the
// helpers here to grant/revoke the `plan` the rest of the app gates on
// (see plan.ts). Nothing here talks to a provider SDK; the provider modules
// (paddle.ts, nowpayments.ts) call into this.
import { client } from "./db";
import type { Plan } from "./plan";

import type { PaidPlan, Interval } from "./pricing";

// Prices live in ./pricing (client-safe, shared with the billing/landing pages).
export { PLAN_PRICING, BRANDED_PRICING, priceFor, type PaidPlan, type Interval } from "./pricing";

export function isPaidPlan(v: unknown): v is PaidPlan {
  return v === "creator" || v === "pro";
}

export function isInterval(v: unknown): v is Interval {
  return v === "monthly" || v === "yearly";
}

// How long a paid period lasts, used to set current_period_end for crypto
// (one-time) purchases and to compute the expiry a card sub renews against.
export function intervalDays(interval: Interval): number {
  return interval === "yearly" ? 365 : 30;
}

// Grant a plan with a hard expiry (crypto / time-block model). If the user
// already has time left we STACK on top of it so paying early never burns days.
export async function grantPlanUntil(opts: {
  userId: number;
  plan: PaidPlan;
  interval: Interval;
  provider: "crypto" | "paddle";
  branded?: boolean;    // discounted "keep the watermark" variant
}): Promise<string> {
  const now = Date.now();
  let base = now;
  try {
    const res = await client.execute({
      sql: "SELECT current_period_end FROM users WHERE id = ?",
      args: [opts.userId],
    });
    const cpe = (res.rows[0] as { current_period_end?: string } | undefined)?.current_period_end;
    const existing = cpe ? Date.parse(cpe) : NaN;
    if (Number.isFinite(existing) && existing > now) base = existing;
  } catch { /* fall back to now */ }

  const expiresAt = new Date(base + intervalDays(opts.interval) * 86_400_000).toISOString();
  await client.execute({
    sql: `UPDATE users
            SET plan = ?, billing_provider = ?, subscription_status = ?, current_period_end = ?, keep_watermark = ?
          WHERE id = ?`,
    // The latest purchase decides branding for the whole (stacked) period.
    args: [opts.plan, opts.provider, opts.provider === "crypto" ? "crypto" : "active", expiresAt, opts.branded ? 1 : 0, opts.userId],
  });
  return expiresAt;
}

// Set a plan from a card subscription's current state (Paddle). Entitled →
// apply the plan; otherwise drop to free but keep the customer linkage.
export async function setSubscriptionPlan(opts: {
  customerId: string;
  subscriptionId: string;
  plan: Plan;           // resolved plan, or 'free' when not entitled
  status: string;
  currentPeriodEnd: string | null;
  branded: boolean;     // subscribed to a "keep the watermark" price
}): Promise<void> {
  // A non-entitled event (canceled / paused / unknown price) only applies to
  // the subscription currently on file. Otherwise a late "canceled" for an old
  // subscription would downgrade someone who has since resubscribed — or who
  // moved to another provider.
  if (opts.plan === "free") {
    await client.execute({
      sql: `UPDATE users
              SET plan = 'free', subscription_status = ?, current_period_end = ?, keep_watermark = 0
            WHERE paddle_customer_id = ? AND paddle_subscription_id = ? AND billing_provider = 'paddle'`,
      args: [opts.status, opts.currentPeriodEnd, opts.customerId, opts.subscriptionId],
    });
    return;
  }
  await client.execute({
    sql: `UPDATE users
            SET plan = ?, billing_provider = 'paddle', paddle_subscription_id = ?,
                subscription_status = ?, current_period_end = ?, keep_watermark = ?
          WHERE paddle_customer_id = ?`,
    args: [opts.plan, opts.subscriptionId, opts.status, opts.currentPeriodEnd, opts.branded ? 1 : 0, opts.customerId],
  });
}

// Set a plan from a Polar subscription's current state, keyed by our user id
// (Polar's external_customer_id). A non-entitled event for a subscription other
// than the one on file is ignored, so a late "revoked" for an old sub can't
// downgrade a user who has since resubscribed.
export async function setPolarSubscriptionPlan(opts: {
  userId: number;
  subscriptionId: string;
  plan: Plan;
  status: string;
  entitled: boolean;
  currentPeriodEnd: string | null;
  branded: boolean;
}): Promise<void> {
  if (!opts.entitled) {
    const res = await client.execute({
      sql: "SELECT polar_subscription_id FROM users WHERE id = ?",
      args: [opts.userId],
    });
    const current = (res.rows[0] as { polar_subscription_id?: string | null } | undefined)?.polar_subscription_id;
    if (current && current !== opts.subscriptionId) return;
  }
  await client.execute({
    sql: `UPDATE users
            SET plan = ?, billing_provider = 'polar', polar_subscription_id = ?,
                subscription_status = ?, current_period_end = ?, keep_watermark = ?
          WHERE id = ?`,
    args: [opts.plan, opts.subscriptionId, opts.status, opts.currentPeriodEnd, opts.branded ? 1 : 0, opts.userId],
  });
}

// Downgrade users whose paid period has lapsed and that are NOT on an
// auto-renewing card sub (i.e. crypto). Called by the cleanup cron. Returns the
// number downgraded.
export async function downgradeExpired(): Promise<number> {
  const now = new Date().toISOString();
  try {
    const res = await client.execute({
      sql: `UPDATE users
              SET plan = 'free', subscription_status = 'expired'
            WHERE plan != 'free'
              AND billing_provider = 'crypto'
              AND current_period_end IS NOT NULL
              AND current_period_end < ?`,
      args: [now],
    });
    return res.rowsAffected ?? 0;
  } catch {
    return 0;
  }
}
