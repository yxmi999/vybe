// NOWPayments crypto provider. We sell one-time "time blocks" (1 month / 1 year)
// rather than true subscriptions — crypto can't auto-charge a wallet. A paid
// invoice extends the user's plan via billing.grantPlanUntil; the cleanup cron
// downgrades once current_period_end lapses.
import crypto from "crypto";
import type { Interval, PaidPlan } from "./billing";

// NOWPAYMENTS_ENV=sandbox → the sandbox API (separate account at
// account-sandbox.nowpayments.io, test coins, no real money).
function apiBase(): string {
  return process.env.NOWPAYMENTS_ENV === "sandbox"
    ? "https://api-sandbox.nowpayments.io/v1"
    : "https://api.nowpayments.io/v1";
}

// Both are needed: without the IPN secret every payment notification fails
// signature checks, so people would pay and never get their plan.
export function nowpaymentsEnabled(): boolean {
  return Boolean(process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET);
}

// order_id round-trips the entitlement through the gateway so the IPN can grant
// the right plan without trusting client input. Kept compact and delimited.
// A `:b` segment marks the discounted "keep the watermark" variant; order ids
// without it (including ones issued before this option existed) are unbranded.
export function encodeOrderId(userId: number, plan: PaidPlan, interval: Interval, branded = false): string {
  const nonce = crypto.randomBytes(4).toString("hex");
  return `u${userId}:${plan}:${interval}${branded ? ":b" : ""}:${nonce}`;
}

export function decodeOrderId(orderId: string): { userId: number; plan: PaidPlan; interval: Interval; branded: boolean } | null {
  const m = /^u(\d+):(creator|pro):(monthly|yearly)(:b)?:[0-9a-f]+$/.exec(orderId);
  if (!m) return null;
  return { userId: Number(m[1]), plan: m[2] as PaidPlan, interval: m[3] as Interval, branded: m[4] === ":b" };
}

export type InvoiceResult = { id: string; invoiceUrl: string };

export async function createInvoice(opts: {
  amountUsd: number;
  orderId: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  ipnUrl: string;
}): Promise<InvoiceResult> {
  const key = process.env.NOWPAYMENTS_API_KEY;
  if (!key) throw new Error("NOWPAYMENTS_API_KEY is not set");

  const res = await fetch(`${apiBase()}/invoice`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      price_amount: opts.amountUsd,
      price_currency: "usd",
      order_id: opts.orderId,
      order_description: opts.description,
      ipn_callback_url: opts.ipnUrl,
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NOWPayments invoice failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { id?: string | number; invoice_url?: string };
  if (!data.invoice_url) throw new Error("NOWPayments returned no invoice_url");
  return { id: String(data.id ?? ""), invoiceUrl: data.invoice_url };
}

// NOWPayments signs the IPN with HMAC-SHA512 over the JSON body whose keys are
// sorted alphabetically (recursively). We re-serialize the parsed body the same
// way and compare against the x-nowpayments-sig header in constant time.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function verifyIpn(rawBody: string, signature: string | null): boolean {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret || !signature) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const sorted = JSON.stringify(sortKeys(parsed));
  const expected = crypto.createHmac("sha512", secret).update(sorted).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
