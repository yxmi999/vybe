// Polar.sh provider (card subscriptions via a Merchant of Record). An
// alternative card path to Paddle: dormant until POLAR_ACCESS_TOKEN is set, and
// when both are configured Polar wins (see cardProvider()).
//
// Users are linked by Polar's `external_customer_id` = our users.id, so we
// never need to store Polar's customer id — checkout, the portal and webhooks
// all key off our own id.
import { createPolar, webhooks } from "@polar-sh/sdk/2026-10";
import type { Interval, PaidPlan } from "./billing";
import type { Plan } from "./plan";

export function polarEnabled(): boolean {
  return Boolean(process.env.POLAR_ACCESS_TOKEN);
}

// Sandbox unless POLAR_ENV=production. Sandbox and production are separate
// accounts with separate tokens, products and webhook secrets.
function polar() {
  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  if (!accessToken) throw new Error("POLAR_ACCESS_TOKEN is not set");
  return createPolar({
    accessToken,
    environment: process.env.POLAR_ENV === "production" ? "production" : "sandbox",
  });
}

// Product ids per plan/interval, e.g. POLAR_PRODUCT_CREATOR_MONTHLY. In Polar a
// product has a single recurring interval, so monthly and yearly are separate
// products. The discounted "keep the watermark" variants add a _BRANDED suffix.
export function polarProductId(plan: PaidPlan, interval: Interval, branded = false): string | undefined {
  return process.env[`POLAR_PRODUCT_${plan.toUpperCase()}_${interval.toUpperCase()}${branded ? "_BRANDED" : ""}`] || undefined;
}

function planForPolarProduct(product: string | null | undefined): { plan: Plan; branded: boolean } | null {
  if (!product) return null;
  for (const plan of ["creator", "pro"] as const) {
    for (const interval of ["monthly", "yearly"] as const) {
      if (polarProductId(plan, interval) === product) return { plan, branded: false };
      if (polarProductId(plan, interval, true) === product) return { plan, branded: true };
    }
  }
  return null;
}

export function polarBrandedEnabled(): boolean {
  return (["creator", "pro"] as const).every((p) => !!polarProductId(p, "monthly", true) && !!polarProductId(p, "yearly", true));
}

// Hosted checkout URL. Polar creates (or reuses) the customer with our user id
// as its external id. Entitlement is granted by the webhook, not here.
export async function createPolarCheckoutUrl(opts: {
  userId: number;
  email: string;
  name?: string | null;
  productId: string;
  origin: string;
}): Promise<string> {
  const checkout = await polar().checkouts.create({
    products: [opts.productId],
    external_customer_id: String(opts.userId),
    customer_email: opts.email,
    customer_name: opts.name ?? undefined,
    success_url: `${opts.origin}/billing?status=success`,
    return_url: `${opts.origin}/billing?status=cancelled`,
    metadata: { user_id: String(opts.userId) },
  });
  return checkout.url;
}

// Customer portal (manage/cancel/change card or plan).
export async function createPolarPortalUrl(userId: number, origin: string): Promise<string> {
  const session = await polar().customerSessions.create({
    external_customer_id: String(userId),
    return_url: `${origin}/billing`,
  });
  return session.customer_portal_url;
}

// Revokes (cancels immediately) a subscription — used on account deletion.
export async function revokePolarSubscription(subscriptionId: string): Promise<void> {
  await polar().subscriptions.revoke(subscriptionId);
}

// Verifies the Standard Webhooks signature against the raw body and returns
// the parsed event. Throws webhooks.PolarWebhookVerificationError on a bad
// signature and webhooks.PolarWebhookUnknownTypeError on event types this SDK
// version doesn't know.
export async function verifyPolarWebhook(rawBody: string, headers: Headers): Promise<webhooks.WebhookPayload> {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) throw new webhooks.PolarWebhookVerificationError("POLAR_WEBHOOK_SECRET is not set");
  return webhooks.validateEvent(rawBody, Object.fromEntries(headers.entries()), secret);
}

// Reduce a paid Polar order to a payments-ledger entry. net_amount is in cents,
// after discounts and before tax: the amount commissions are computed on.
export function readPolarOrder(order: {
  id: string;
  paid?: boolean;
  net_amount: number;
  currency: string;
  customer?: { external_id?: string | null } | null;
  metadata?: Record<string, unknown>;
}): { userId: number; externalId: string; amountCents: number; currency: string } | null {
  const raw = order.customer?.external_id ?? (order.metadata?.user_id as string | undefined);
  const userId = Number(raw);
  if (!raw || !Number.isInteger(userId) || order.paid === false) return null;
  return { userId, externalId: order.id, amountCents: order.net_amount ?? 0, currency: order.currency ?? "usd" };
}

// Statuses we treat as entitled. A sub canceled "at period end" stays `active`
// until Polar revokes it, so it keeps access until the paid period runs out.
const ENTITLED = new Set(["active", "trialing", "past_due"]);

// Reduce a Polar subscription to what billing.setPolarSubscriptionPlan needs.
export function readPolarSubscription(sub: {
  id: string;
  status: string;
  product_id: string;
  current_period_end: string | null;
  customer: { external_id?: string | null };
  metadata?: Record<string, unknown>;
}): {
  userId: number;
  subscriptionId: string;
  plan: Plan;
  status: string;
  entitled: boolean;
  currentPeriodEnd: string | null;
  branded: boolean;
} | null {
  // Prefer the customer's external id; fall back to the checkout metadata.
  const raw = sub.customer?.external_id ?? (sub.metadata?.user_id as string | undefined);
  const userId = Number(raw);
  if (!raw || !Number.isInteger(userId)) return null;

  const resolved = planForPolarProduct(sub.product_id);
  const entitled = ENTITLED.has(sub.status) && resolved != null;
  return {
    userId,
    subscriptionId: sub.id,
    plan: entitled ? resolved.plan : "free",
    status: sub.status,
    entitled,
    currentPeriodEnd: sub.current_period_end ?? null,
    branded: entitled ? resolved.branded : false,
  };
}
