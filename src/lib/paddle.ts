// Paddle Billing provider (card subscriptions via a Merchant of Record). This
// is the card path; it stays dormant until the PADDLE_* env vars are set, so the
// crypto path works independently. Endpoint/field names follow the Paddle
// Billing API — verify against https://developer.paddle.com before going live.
import crypto from "crypto";
import { client } from "./db";
import type { Interval, PaidPlan } from "./billing";
import type { Plan } from "./plan";

function apiBase(): string {
  // Sandbox while testing; flip PADDLE_ENV=production (or set PADDLE_API_BASE).
  if (process.env.PADDLE_API_BASE) return process.env.PADDLE_API_BASE;
  return process.env.PADDLE_ENV === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";
}

export function paddleEnabled(): boolean {
  return Boolean(process.env.PADDLE_API_KEY);
}

/** What's still missing before NEW card checkouts can run on Paddle (empty = ready). */
export function paddleCheckoutMissing(): string[] {
  const missing: string[] = [];
  if (!process.env.PADDLE_API_KEY) missing.push("PADDLE_API_KEY");
  if (!process.env.PADDLE_WEBHOOK_SECRET) missing.push("PADDLE_WEBHOOK_SECRET");
  if (!process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN) missing.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN");
  for (const plan of ["creator", "pro"] as const) {
    for (const interval of ["monthly", "yearly"] as const) {
      if (!paddlePriceId(plan, interval)) missing.push(`PADDLE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`);
    }
  }
  // The checkout page and the API must point at the same Paddle environment.
  const server = process.env.PADDLE_ENV === "production" ? "production" : "sandbox";
  const client = process.env.NEXT_PUBLIC_PADDLE_ENV === "production" ? "production" : "sandbox";
  if (server !== client) missing.push("NEXT_PUBLIC_PADDLE_ENV (must match PADDLE_ENV)");
  return missing;
}

export function paddleCheckoutReady(): boolean {
  return paddleCheckoutMissing().length === 0;
}

// Price ids per plan/interval, e.g. PADDLE_PRICE_CREATOR_MONTHLY; the
// discounted "keep the watermark" variants add a _BRANDED suffix.
export function paddlePriceId(plan: PaidPlan, interval: Interval, branded = false): string | undefined {
  return process.env[`PADDLE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}${branded ? "_BRANDED" : ""}`];
}

export function planForPaddlePrice(price: string | null | undefined): { plan: Plan; branded: boolean } | null {
  if (!price) return null;
  for (const plan of ["creator", "pro"] as const) {
    for (const interval of ["monthly", "yearly"] as const) {
      if (paddlePriceId(plan, interval) === price) return { plan, branded: false };
      if (paddlePriceId(plan, interval, true) === price) return { plan, branded: true };
    }
  }
  return null;
}

// Whether the discounted watermark prices are configured for card checkout.
export function paddleBrandedEnabled(): boolean {
  return (["creator", "pro"] as const).every((p) => !!paddlePriceId(p, "monthly", true) && !!paddlePriceId(p, "yearly", true));
}

async function paddleFetch(path: string, init: RequestInit): Promise<unknown> {
  const key = process.env.PADDLE_API_KEY;
  if (!key) throw new Error("PADDLE_API_KEY is not set");
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Paddle ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

// Find-or-create the Paddle customer for a user and persist its id.
export async function ensurePaddleCustomer(userId: number, email: string, name?: string | null): Promise<string> {
  const res = await client.execute({
    sql: "SELECT paddle_customer_id FROM users WHERE id = ?",
    args: [userId],
  });
  const existing = (res.rows[0] as { paddle_customer_id?: string } | undefined)?.paddle_customer_id;
  if (existing) return existing;

  // Paddle rejects duplicate emails — reuse the existing customer if present.
  let id: string | undefined;
  try {
    const created = (await paddleFetch("/customers", {
      method: "POST",
      body: JSON.stringify({ email, name: name ?? undefined }),
    })) as { data?: { id?: string } };
    id = created.data?.id;
  } catch (err) {
    const list = (await paddleFetch(`/customers?email=${encodeURIComponent(email)}`, { method: "GET" })) as {
      data?: { id?: string }[];
    };
    id = list.data?.[0]?.id;
    if (!id) throw err;
  }
  if (!id) throw new Error("Paddle did not return a customer id");

  await client.execute({
    sql: "UPDATE users SET paddle_customer_id = ? WHERE id = ?",
    args: [id, userId],
  });
  return id;
}

// Where Paddle sends the buyer: our /pay page, which loads Paddle.js and opens
// the checkout for the `_ptxn` transaction in the URL. Paddle only accepts
// URLs on a domain approved in its dashboard, so for local dev (http) we leave
// it unset and Paddle uses the account's default payment link instead.
// Override with PADDLE_CHECKOUT_URL.
export function paddleCheckoutPageUrl(): string | null {
  if (process.env.PADDLE_CHECKOUT_URL) return process.env.PADDLE_CHECKOUT_URL;
  const app = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return app.startsWith("https://") ? `${app}/pay` : null;
}

// Creates a transaction and returns its checkout URL (our /pay page + _ptxn).
// Paddle also requires a default payment link in Checkout settings.
export async function createCheckoutUrl(opts: {
  userId: number;
  customerId: string;
  priceId: string;
}): Promise<string> {
  const page = paddleCheckoutPageUrl();
  const tx = (await paddleFetch("/transactions", {
    method: "POST",
    body: JSON.stringify({
      items: [{ price_id: opts.priceId, quantity: 1 }],
      customer_id: opts.customerId,
      custom_data: { user_id: String(opts.userId) },
      ...(page ? { checkout: { url: page } } : {}),
    }),
  })) as { data?: { id?: string; checkout?: { url?: string } } };

  // Paddle only fills checkout.url when a default payment link is set in its
  // Checkout settings — treat a missing one as misconfiguration.
  if (!tx.data?.checkout?.url || !tx.data.id) {
    throw new Error("Paddle transaction returned no checkout URL — set a default payment link in Paddle.");
  }
  // Same-origin checkout page, so it works on localhost, previews and prod alike
  // (the default payment link above is only used for Paddle's own emails).
  return `/pay?_ptxn=${encodeURIComponent(tx.data.id)}`;
}

// Reduce a completed Paddle transaction to a payments-ledger entry. Paddle
// totals are strings in the currency's minor units; commissions are computed on
// subtotal minus discount (i.e. before tax). Renewal transactions may not carry
// our custom_data, so fall back to the stored customer id.
export async function readPaddleTransaction(data: Record<string, unknown>): Promise<{
  userId: number | null; externalId: string; amountCents: number; currency: string;
} | null> {
  const id = typeof data.id === "string" ? data.id : null;
  if (!id) return null;
  const totals = ((data.details as Record<string, unknown> | undefined)?.totals ?? {}) as Record<string, unknown>;
  const subtotal = Number(totals.subtotal ?? 0) || 0;
  const discount = Number(totals.discount ?? 0) || 0;
  const currency = typeof data.currency_code === "string" ? data.currency_code : "USD";

  let userId: number | null = null;
  const custom = data.custom_data as { user_id?: unknown } | null | undefined;
  const fromCustom = Number(custom?.user_id);
  if (Number.isInteger(fromCustom) && fromCustom > 0) userId = fromCustom;
  else if (typeof data.customer_id === "string") {
    const res = await client.execute({ sql: "SELECT id FROM users WHERE paddle_customer_id = ?", args: [data.customer_id] });
    const found = Number((res.rows[0] as { id?: number } | undefined)?.id ?? 0);
    if (found) userId = found;
  }
  return { userId, externalId: id, amountCents: Math.max(0, subtotal - discount), currency };
}

// Cancels a subscription right away (used when the user deletes their account,
// so a deleted user is never billed again).
export async function cancelPaddleSubscription(subscriptionId: string): Promise<void> {
  await paddleFetch(`/subscriptions/${subscriptionId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ effective_from: "immediately" }),
  });
}

// Opens a Paddle customer portal session (manage/cancel/change card).
export async function createPortalUrl(customerId: string): Promise<string> {
  const portal = (await paddleFetch(`/customers/${customerId}/portal-sessions`, {
    method: "POST",
    body: JSON.stringify({}),
  })) as { data?: { urls?: { general?: { overview?: string } } } };
  const url = portal.data?.urls?.general?.overview;
  if (!url) throw new Error("Paddle returned no portal URL");
  return url;
}

// ── Webhook source IP allowlist ─────────────────────────────────────────────
// Paddle only sends webhooks from the addresses published at <api>/ips
// (data.ipv4_cidrs). That endpoint is the source of truth and can change, so
// it's fetched (and cached for an hour), never hard-coded. Defence in depth on
// top of the signature check.
let ipCache: { at: number; cidrs: string[] } | null = null;
const IP_TTL_MS = 60 * 60 * 1000;

async function paddleWebhookCidrs(): Promise<string[] | null> {
  if (ipCache && Date.now() - ipCache.at < IP_TTL_MS) return ipCache.cidrs;
  try {
    const res = await fetch(`${apiBase()}/ips`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { data?: { ipv4_cidrs?: unknown } };
    const cidrs = body.data?.ipv4_cidrs;
    if (Array.isArray(cidrs) && cidrs.length && cidrs.every((c) => typeof c === "string")) {
      ipCache = { at: Date.now(), cidrs: cidrs as string[] };
      return ipCache.cidrs;
    }
  } catch (err) {
    console.error("[paddle] couldn't fetch webhook IPs:", err instanceof Error ? err.message : err);
  }
  return ipCache?.cidrs ?? null; // a stale list beats none
}

function ipv4ToInt(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const a = ipv4ToInt(ip.replace(/^::ffff:/, "")), b = ipv4ToInt(range);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/**
 * Is this webhook request from one of Paddle's published IPs? Uses the
 * platform-set client IP (Vercel sets x-real-ip / the first x-forwarded-for
 * hop and doesn't pass client-supplied values through). Set
 * PADDLE_WEBHOOK_IP_CHECK=off only for local tunnel testing.
 */
export async function checkPaddleWebhookIp(req: Request): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  if ((process.env.PADDLE_WEBHOOK_IP_CHECK ?? "").toLowerCase() === "off") return { ok: true };
  const ip = (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "").trim();
  if (!ip) return { ok: false, status: 403, reason: "no client IP" };
  const cidrs = await paddleWebhookCidrs();
  if (!cidrs) return { ok: false, status: 503, reason: "Paddle IP list unavailable" }; // Paddle retries
  return cidrs.some((c) => ipv4InCidr(ip, c)) ? { ok: true } : { ok: false, status: 403, reason: `IP ${ip} not on Paddle's list` };
}

// Verifies the Paddle-Signature header: `ts=<unix>;h1=<hmac sha256 of `${ts}:${body}`>`.
export function verifyWebhook(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(";").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    })
  ) as { ts?: string; h1?: string };
  if (!parts.ts || !parts.h1) return false;
  // Reject stale signatures so a captured webhook can't be replayed later.
  // (Paddle retries re-sign with a fresh timestamp.)
  const age = Math.abs(Date.now() / 1000 - Number(parts.ts));
  if (!Number.isFinite(age) || age > 5 * 60) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${parts.ts}:${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.h1));
  } catch {
    return false;
  }
}

// Statuses Paddle considers entitled.
const ENTITLED = new Set(["active", "trialing", "past_due"]);

// Reduce a Paddle subscription event object to the fields billing.setSubscriptionPlan needs.
export function readSubscription(sub: {
  customer_id?: string;
  id?: string;
  status?: string;
  items?: { price?: { id?: string } }[];
  current_billing_period?: { ends_at?: string };
}): {
  customerId: string;
  subscriptionId: string;
  plan: Plan;
  status: string;
  currentPeriodEnd: string | null;
  branded: boolean;
} | null {
  if (!sub.customer_id || !sub.id) return null;
  const price = sub.items?.[0]?.price?.id;
  const resolved = planForPaddlePrice(price);
  const status = sub.status ?? "unknown";
  const entitled = ENTITLED.has(status) && resolved != null;
  return {
    customerId: sub.customer_id,
    subscriptionId: sub.id,
    plan: entitled ? resolved.plan : "free",
    status,
    currentPeriodEnd: sub.current_billing_period?.ends_at ?? null,
    branded: entitled ? resolved.branded : false,
  };
}
