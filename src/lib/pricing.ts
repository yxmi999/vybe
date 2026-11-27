// Single source of truth for prices (USD). Client-safe — no DB/provider
// imports — so the billing page, landing page and checkout all agree.
//
// "Branded" = the same paid plan, discounted, in exchange for keeping the
// Vybe watermark on exports. Annual = 10× monthly (2 months free).
//
// Card (Paddle) charges come from the Paddle price IDs, not these numbers —
// keep the PADDLE_PRICE_* products in sync when changing them.

export type PaidPlan = "creator" | "pro";
export type Interval = "monthly" | "yearly";

export const PLAN_PRICING: Record<PaidPlan, Record<Interval, number>> = {
  creator: { monthly: 13, yearly: 130 },
  pro: { monthly: 25, yearly: 250 },
};

export const BRANDED_PRICING: Record<PaidPlan, Record<Interval, number>> = {
  creator: { monthly: 10, yearly: 100 },
  pro: { monthly: 20, yearly: 200 },
};

// ── Public beta ──
// While BETA is on, PLAN_PRICING above is the beta price and FULL_PRICING is
// what it becomes after launch — shown crossed out so beta subscribers see the
// deal they're locking in. Card subscriptions keep the price they started on
// (Paddle/Polar renew on the original price), so the lock-in holds for as long
// as the subscription stays active. Flip BETA off at launch and move
// FULL_PRICING into PLAN_PRICING (plus new provider prices).
export const BETA = true;
export const FULL_PRICING: Record<PaidPlan, Record<Interval, number>> = {
  creator: { monthly: 15, yearly: 150 },
  pro: { monthly: 35, yearly: 350 },
};

export function priceFor(plan: PaidPlan, interval: Interval, branded = false): number {
  return (branded ? BRANDED_PRICING : PLAN_PRICING)[plan][interval];
}

// Percent saved by keeping the watermark (rounded), e.g. 23 for Creator.
export function brandedSavingsPct(plan: PaidPlan, interval: Interval = "monthly"): number {
  const full = PLAN_PRICING[plan][interval];
  return Math.round(((full - BRANDED_PRICING[plan][interval]) / full) * 100);
}
