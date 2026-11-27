// Affiliate program. Every user gets a share link (/?ref=CODE). Whoever signs
// up through it is attributed to the referrer, and every payment that referred
// user makes (first charge AND renewals) earns the referrer a percentage.
//
// Money flow:
//   provider webhook → recordPayment() → payments row (idempotent per provider
//   payment) → referral_commissions row, held for AFFILIATE_HOLD_DAYS so a
//   refund inside the money-back window can claw it back before it's paid.
//   A refund adds a negative 'reversal' row rather than editing history, so a
//   commission that was already paid out simply nets off the next payout.
//
// Payouts are manual: the affiliate requests one once their available balance
// passes the minimum, and an admin (ADMIN_EMAILS) pays it via PayPal/crypto/
// Wise and marks it paid on /admin/payouts.
//
// All amounts are integer cents (USD).
import { randomBytes } from "crypto";
import { client } from "./db";
import {
  assessAffiliate, isObviousSelfReferral, profileComplete, getPayoutProfile, blockedCountries,
  AFFILIATE_TERMS_VERSION, type Assessment, type IdStatus,
} from "./affiliate-safety";

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== "" && process.env[name] != null ? n : fallback;
}

export const AFFILIATE = {
  // Share of each referred payment (net of tax/discounts) paid to the referrer.
  commissionPct: envNum("AFFILIATE_COMMISSION_PCT", 30),
  // How many months after the referred user signs up their payments still earn.
  // 0 = lifetime.
  durationMonths: envNum("AFFILIATE_DURATION_MONTHS", 12),
  // Commissions are held this long before they can be withdrawn. Longer than
  // the 14-day money-back window, so refunds reverse before money goes out.
  holdDays: envNum("AFFILIATE_HOLD_DAYS", 30),
  minPayoutCents: Math.round(envNum("AFFILIATE_MIN_PAYOUT_USD", 25) * 100),
};

export const PAYOUT_METHODS = ["paypal", "crypto", "wise"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
export function isPayoutMethod(v: unknown): v is PayoutMethod {
  return typeof v === "string" && (PAYOUT_METHODS as readonly string[]).includes(v);
}

// ── Referral codes ──────────────────────────────────────────────────────────
// 8 chars from an unambiguous alphabet (no 0/O/1/I/L), so codes survive being
// read aloud or typed from a video description.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(c) ? c : null;
}

export async function getOrCreateReferralCode(userId: number): Promise<string> {
  const res = await client.execute({ sql: "SELECT referral_code FROM users WHERE id = ?", args: [userId] });
  const existing = (res.rows[0] as { referral_code?: string | null } | undefined)?.referral_code;
  if (existing) return existing;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      const upd = await client.execute({
        sql: "UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL",
        args: [code, userId],
      });
      if ((upd.rowsAffected ?? 0) > 0) return code;
      // Someone else set it concurrently — read theirs.
      const again = await client.execute({ sql: "SELECT referral_code FROM users WHERE id = ?", args: [userId] });
      const c = (again.rows[0] as { referral_code?: string | null } | undefined)?.referral_code;
      if (c) return c;
    } catch {
      // Unique collision — try another code.
    }
  }
  throw new Error("Could not allocate a referral code");
}

// Name of the cookie the proxy sets when someone lands on any page with ?ref=.
export const REF_COOKIE = "vybe_ref";
export const REF_COOKIE_DAYS = 30;

// Attribute a brand-new user to the owner of `code`. Only ever sets
// referred_by once, and never to the user themself. Never throws: a bad or
// stale code must not break sign-up.
export async function attachReferral(
  newUserId: number, rawCode: unknown, ctx?: { email: string; req: Request | null },
): Promise<boolean> {
  const code = normalizeCode(rawCode);
  if (!code) return false;
  try {
    const res = await client.execute({ sql: "SELECT id FROM users WHERE referral_code = ?", args: [code] });
    const referrerId = Number((res.rows[0] as { id?: number } | undefined)?.id ?? 0);
    if (!referrerId || referrerId === newUserId) return false;
    // Same device or an email alias of the referrer: don't attribute at all.
    if (ctx) {
      const why = await isObviousSelfReferral(referrerId, ctx.email, ctx.req);
      if (why) {
        console.warn(`[affiliate] referral of user ${newUserId} by ${referrerId} refused: ${why}`);
        return false;
      }
    }
    const upd = await client.execute({
      sql: "UPDATE users SET referred_by = ?, referred_at = ? WHERE id = ? AND referred_by IS NULL",
      args: [referrerId, new Date().toISOString(), newUserId],
    });
    return (upd.rowsAffected ?? 0) > 0;
  } catch (err) {
    console.error("[affiliate] attachReferral failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Payments ledger ─────────────────────────────────────────────────────────

export type PaymentProvider = "polar" | "paddle" | "crypto";

// Insert a payment row if this provider payment hasn't been seen. Returns the
// row id and whether it was new (false = a webhook re-delivery).
export async function insertPayment(opts: {
  userId: number | null;
  provider: PaymentProvider;
  externalId: string;
  amountCents: number;
  currency?: string;
}): Promise<{ id: number; isNew: boolean }> {
  const ins = await client.execute({
    sql: `INSERT OR IGNORE INTO payments (user_id, provider, external_id, amount_cents, currency)
          VALUES (?, ?, ?, ?, ?)`,
    args: [opts.userId, opts.provider, opts.externalId, Math.max(0, Math.round(opts.amountCents)), (opts.currency ?? "USD").toUpperCase()],
  });
  const isNew = (ins.rowsAffected ?? 0) > 0;
  const row = await client.execute({
    sql: "SELECT id FROM payments WHERE provider = ? AND external_id = ?",
    args: [opts.provider, opts.externalId],
  });
  return { id: Number((row.rows[0] as { id?: number } | undefined)?.id ?? 0), isNew };
}

export async function deletePayment(id: number): Promise<void> {
  await client.execute({ sql: "DELETE FROM payments WHERE id = ?", args: [id] });
}

// Create the referrer's commission for a payment, if the payer was referred
// and is still inside the commission window. Idempotent per payment.
export async function creditCommission(paymentId: number): Promise<void> {
  const res = await client.execute({
    sql: `SELECT p.amount_cents, p.currency, p.user_id, u.referred_by, u.referred_at
            FROM payments p JOIN users u ON u.id = p.user_id
           WHERE p.id = ? AND p.refunded = 0`,
    args: [paymentId],
  });
  const row = res.rows[0] as {
    amount_cents?: number; currency?: string; user_id?: number; referred_by?: number | null; referred_at?: string | null;
  } | undefined;
  if (!row?.referred_by || !row.user_id || !row.amount_cents) return;
  // Commissions are in USD cents; skip other currencies rather than mis-credit.
  if ((row.currency ?? "USD").toUpperCase() !== "USD") {
    console.warn(`[affiliate] payment ${paymentId} is ${row.currency}; no commission credited`);
    return;
  }

  if (AFFILIATE.durationMonths > 0 && row.referred_at) {
    const until = new Date(row.referred_at);
    until.setMonth(until.getMonth() + AFFILIATE.durationMonths);
    if (Date.now() > until.getTime()) return;
  }

  const amount = Math.floor((row.amount_cents * AFFILIATE.commissionPct) / 100);
  if (amount <= 0) return;
  const availableAt = new Date(Date.now() + AFFILIATE.holdDays * 86_400_000).toISOString();
  await client.execute({
    sql: `INSERT OR IGNORE INTO referral_commissions
            (referrer_id, referred_user_id, payment_id, kind, amount_cents, rate_pct, status, available_at)
          VALUES (?, ?, ?, 'commission', ?, ?, 'earned', ?)`,
    args: [row.referred_by, row.user_id, paymentId, amount, AFFILIATE.commissionPct, availableAt],
  });
}

// Record a provider payment and credit any referral commission. Safe to call
// on every webhook delivery. Never throws: affiliate bookkeeping must not make
// a provider retry a webhook that already granted the plan.
export async function recordPayment(opts: {
  userId: number | null;
  provider: PaymentProvider;
  externalId: string;
  amountCents: number;
  currency?: string;
}): Promise<void> {
  try {
    const { id } = await insertPayment(opts);
    if (id) await creditCommission(id);
  } catch (err) {
    console.error("[affiliate] recordPayment failed:", err instanceof Error ? err.message : err);
  }
}

// A payment was refunded or charged back: flag it and claw back its commission
// with a negative adjustment (available immediately so it nets off the next
// payout). Idempotent.
export async function reversePayment(provider: PaymentProvider, externalId: string, reason: "refund" | "chargeback" = "refund"): Promise<void> {
  try {
    await client.execute({
      sql: "UPDATE payments SET refunded = 1 WHERE provider = ? AND external_id = ?",
      args: [provider, externalId],
    });
    const res = await client.execute({
      sql: `SELECT c.referrer_id, c.referred_user_id, c.payment_id, c.amount_cents, c.rate_pct
              FROM referral_commissions c JOIN payments p ON p.id = c.payment_id
             WHERE p.provider = ? AND p.external_id = ? AND c.kind = 'commission'`,
      args: [provider, externalId],
    });
    const c = res.rows[0] as {
      referrer_id?: number; referred_user_id?: number | null; payment_id?: number; amount_cents?: number; rate_pct?: number;
    } | undefined;
    if (!c?.referrer_id || !c.payment_id || !c.amount_cents) return;
    await client.execute({
      sql: `INSERT OR IGNORE INTO referral_commissions
              (referrer_id, referred_user_id, payment_id, kind, amount_cents, rate_pct, status, available_at, reason)
            VALUES (?, ?, ?, 'reversal', ?, ?, 'earned', ?, ?)`,
      args: [c.referrer_id, c.referred_user_id ?? null, c.payment_id, -c.amount_cents, c.rate_pct ?? 0, new Date().toISOString(), reason],
    });
  } catch (err) {
    console.error("[affiliate] reversePayment failed:", err instanceof Error ? err.message : err);
  }
}

// A chargeback was reversed in our favour (we won the dispute): restore the
// commission that the chargeback clawed back. Idempotent.
export async function reinstatePayment(provider: PaymentProvider, externalId: string): Promise<void> {
  try {
    const res = await client.execute({
      sql: `SELECT c.referrer_id, c.referred_user_id, c.payment_id, c.amount_cents, c.rate_pct
              FROM referral_commissions c JOIN payments p ON p.id = c.payment_id
             WHERE p.provider = ? AND p.external_id = ? AND c.kind = 'reversal' AND c.reason = 'chargeback'`,
      args: [provider, externalId],
    });
    const c = res.rows[0] as {
      referrer_id?: number; referred_user_id?: number | null; payment_id?: number; amount_cents?: number; rate_pct?: number;
    } | undefined;
    if (!c?.referrer_id || !c.payment_id || !c.amount_cents) return;
    await client.execute({ sql: "UPDATE payments SET refunded = 0 WHERE id = ?", args: [c.payment_id] });
    await client.execute({
      sql: `INSERT OR IGNORE INTO referral_commissions
              (referrer_id, referred_user_id, payment_id, kind, amount_cents, rate_pct, status, available_at, reason)
            VALUES (?, ?, ?, 'reinstate', ?, ?, 'earned', ?, 'chargeback_won')`,
      args: [c.referrer_id, c.referred_user_id ?? null, c.payment_id, -c.amount_cents, c.rate_pct ?? 0, new Date().toISOString()],
    });
  } catch (err) {
    console.error("[affiliate] reinstatePayment failed:", err instanceof Error ? err.message : err);
  }
}

// ── Dashboard ───────────────────────────────────────────────────────────────

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

function n(v: unknown): number {
  return Number(v ?? 0) || 0;
}

export type AffiliateSummary = {
  code: string;
  config: { commissionPct: number; durationMonths: number; holdDays: number; minPayoutCents: number };
  stats: { signups: number; paying: number };
  balance: { pendingCents: number; availableCents: number; requestedCents: number; paidCents: number; lifetimeCents: number };
  payout: { method: PayoutMethod | null; details: string | null };
  /** Payout identity + what's still needed before money can go out. Never exposes fraud signals. */
  identity: {
    profile: { legalName: string; country: string; address: string; usPerson: boolean; termsAccepted: boolean };
    termsVersion: string;
    complete: boolean;
    idStatus: IdStatus;
    idCheckNeeded: boolean;
    idReasons: string[];      // only the non-sensitive reasons (crypto / amount); "account review" for anything else
    blockedCountries: string[];
  };
  referrals: { who: string; plan: string; joinedAt: string; earnedCents: number }[];
  commissions: { id: number; who: string; kind: string; amountCents: number; createdAt: string; availableAt: string; state: "pending" | "available" | "requested" | "paid" }[];
  payouts: { id: number; amountCents: number; status: string; method: string | null; createdAt: string; settledAt: string | null; note: string | null }[];
};

export async function getAffiliateSummary(userId: number): Promise<AffiliateSummary> {
  const code = await getOrCreateReferralCode(userId);
  const now = new Date().toISOString();

  const [stats, bal, me, refs, comm, pays] = await Promise.all([
    client.execute({
      sql: `SELECT COUNT(*) AS signups,
                   SUM(CASE WHEN EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.refunded = 0) THEN 1 ELSE 0 END) AS paying
              FROM users u WHERE u.referred_by = ?`,
      args: [userId],
    }),
    client.execute({
      sql: `SELECT
              SUM(CASE WHEN c.payout_id IS NULL AND c.available_at > ? THEN c.amount_cents ELSE 0 END) AS pending,
              SUM(CASE WHEN c.payout_id IS NULL AND c.available_at <= ? THEN c.amount_cents ELSE 0 END) AS available,
              SUM(CASE WHEN po.status = 'requested' THEN c.amount_cents ELSE 0 END) AS requested,
              SUM(CASE WHEN po.status = 'paid' THEN c.amount_cents ELSE 0 END) AS paid,
              SUM(c.amount_cents) AS lifetime
              FROM referral_commissions c LEFT JOIN affiliate_payouts po ON po.id = c.payout_id
             WHERE c.referrer_id = ?`,
      args: [now, now, userId],
    }),
    client.execute({ sql: "SELECT payout_method, payout_details FROM users WHERE id = ?", args: [userId] }),
    client.execute({
      sql: `SELECT u.email, u.plan, u.referred_at,
                   (SELECT COALESCE(SUM(c.amount_cents), 0) FROM referral_commissions c
                     WHERE c.referrer_id = ? AND c.referred_user_id = u.id) AS earned
              FROM users u WHERE u.referred_by = ?
             ORDER BY u.referred_at DESC LIMIT 100`,
      args: [userId, userId],
    }),
    client.execute({
      sql: `SELECT c.id, c.kind, c.amount_cents, c.created_at, c.available_at, c.payout_id, po.status AS payout_status, u.email
              FROM referral_commissions c
              LEFT JOIN affiliate_payouts po ON po.id = c.payout_id
              LEFT JOIN users u ON u.id = c.referred_user_id
             WHERE c.referrer_id = ?
             ORDER BY c.created_at DESC LIMIT 50`,
      args: [userId],
    }),
    client.execute({
      sql: `SELECT id, amount_cents, status, method, created_at, settled_at, note
              FROM affiliate_payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      args: [userId],
    }),
  ]);

  const s = stats.rows[0] as Record<string, unknown> | undefined;
  const b = bal.rows[0] as Record<string, unknown> | undefined;
  const m = me.rows[0] as { payout_method?: string | null; payout_details?: string | null } | undefined;
  const risk = await assessAffiliate(userId, { pendingCents: Math.max(0, n(b?.available)) + n(b?.requested) });

  return {
    code,
    config: {
      commissionPct: AFFILIATE.commissionPct,
      durationMonths: AFFILIATE.durationMonths,
      holdDays: AFFILIATE.holdDays,
      minPayoutCents: AFFILIATE.minPayoutCents,
    },
    stats: { signups: n(s?.signups), paying: n(s?.paying) },
    balance: {
      pendingCents: Math.max(0, n(b?.pending)),
      availableCents: n(b?.available), // may be negative after a reversal of paid-out money
      requestedCents: n(b?.requested),
      paidCents: n(b?.paid),
      lifetimeCents: n(b?.lifetime),
    },
    payout: {
      method: isPayoutMethod(m?.payout_method) ? m!.payout_method as PayoutMethod : null,
      details: m?.payout_details ?? null,
    },
    identity: {
      profile: {
        legalName: risk.profile.legalName, country: risk.profile.country, address: risk.profile.address,
        usPerson: risk.profile.usPerson, termsAccepted: risk.profile.termsVersion === AFFILIATE_TERMS_VERSION,
      },
      termsVersion: AFFILIATE_TERMS_VERSION,
      complete: risk.profileComplete,
      idStatus: risk.profile.idStatus,
      idCheckNeeded: risk.idCheckRequired,
      idReasons: [...new Set(risk.idReasons.map((r) => (r === "crypto payout" || r.startsWith("lifetime") ? r : "account review")))],
      blockedCountries: [...blockedCountries()],
    },
    referrals: (refs.rows as unknown as { email: string; plan: string | null; referred_at: string | null; earned: number }[]).map((r) => ({
      who: maskEmail(String(r.email)),
      plan: r.plan ?? "free",
      joinedAt: r.referred_at ?? "",
      earnedCents: n(r.earned),
    })),
    commissions: (comm.rows as unknown as {
      id: number; kind: string; amount_cents: number; created_at: string; available_at: string;
      payout_id: number | null; payout_status: string | null; email: string | null;
    }[]).map((c) => ({
      id: n(c.id),
      who: c.email ? maskEmail(String(c.email)) : "Deleted user",
      kind: String(c.kind),
      amountCents: n(c.amount_cents),
      createdAt: String(c.created_at ?? ""),
      availableAt: String(c.available_at ?? ""),
      state: c.payout_status === "paid" ? "paid"
        : c.payout_status === "requested" ? "requested"
        : String(c.available_at) > now ? "pending" : "available",
    })),
    payouts: (pays.rows as unknown as {
      id: number; amount_cents: number; status: string; method: string | null; created_at: string; settled_at: string | null; note: string | null;
    }[]).map((p) => ({
      id: n(p.id), amountCents: n(p.amount_cents), status: String(p.status), method: p.method ?? null,
      createdAt: String(p.created_at ?? ""), settledAt: p.settled_at ?? null, note: p.note ?? null,
    })),
  };
}

export async function setPayoutDetails(userId: number, method: PayoutMethod, details: string): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET payout_method = ?, payout_details = ? WHERE id = ?",
    args: [method, details.trim().slice(0, 200), userId],
  });
}

// Bundle every available, unrequested commission into one payout request.
// Done in a transaction so a double-click can't request the same money twice.
export async function requestPayout(
  userId: number, ctx: { requestCountry?: string | null } = {},
): Promise<{ ok: true; amountCents: number; idCheckNeeded: boolean } | { ok: false; error: string }> {
  // Identity + location are checked before the write transaction (reads only).
  const profile = await getPayoutProfile(userId);
  if (!profileComplete(profile)) {
    return { ok: false, error: "Complete your payout profile and accept the affiliate terms first." };
  }
  if (profile.idStatus === "rejected") {
    return { ok: false, error: "Your identity check didn't pass. Contact support to sort it out." };
  }
  const pre = await assessAffiliate(userId, { requestCountry: ctx.requestCountry ?? null });
  if (pre.blocked) return { ok: false, error: "We can't send affiliate payouts to your location." };

  const tx = await client.transaction("write");
  try {
    const now = new Date().toISOString();
    const me = await tx.execute({ sql: "SELECT payout_method, payout_details FROM users WHERE id = ?", args: [userId] });
    const m = me.rows[0] as { payout_method?: string | null; payout_details?: string | null } | undefined;
    if (!isPayoutMethod(m?.payout_method) || !m?.payout_details) {
      await tx.rollback();
      return { ok: false, error: "Add your payout details first." };
    }
    const open = await tx.execute({
      sql: "SELECT COUNT(*) AS n FROM affiliate_payouts WHERE user_id = ? AND status = 'requested'",
      args: [userId],
    });
    if (n((open.rows[0] as { n?: number }).n) > 0) {
      await tx.rollback();
      return { ok: false, error: "You already have a payout in progress." };
    }
    const sum = await tx.execute({
      sql: `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM referral_commissions
             WHERE referrer_id = ? AND payout_id IS NULL AND available_at <= ?`,
      args: [userId, now],
    });
    const total = n((sum.rows[0] as { total?: number }).total);
    if (total < AFFILIATE.minPayoutCents) {
      await tx.rollback();
      return { ok: false, error: `The minimum payout is $${(AFFILIATE.minPayoutCents / 100).toFixed(2)}.` };
    }
    const risk = await assessAffiliate(userId, { method: m.payout_method, pendingCents: total, requestCountry: ctx.requestCountry ?? null });
    const ins = await tx.execute({
      sql: `INSERT INTO affiliate_payouts (user_id, amount_cents, method, details, status, request_country, risk_snapshot)
            VALUES (?, ?, ?, ?, 'requested', ?, ?)`,
      args: [userId, total, m.payout_method, m.payout_details, ctx.requestCountry ?? null,
        JSON.stringify({ flags: risk.flags, idReasons: risk.idReasons, at: now })],
    });
    const payoutId = Number(ins.lastInsertRowid);
    await tx.execute({
      sql: `UPDATE referral_commissions SET payout_id = ?
             WHERE referrer_id = ? AND payout_id IS NULL AND available_at <= ?`,
      args: [payoutId, userId, now],
    });
    await tx.commit();
    return { ok: true, amountCents: total, idCheckNeeded: risk.idCheckRequired };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    tx.close();
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

export async function listPayoutRequests(status: "requested" | "paid" | "rejected" = "requested") {
  const res = await client.execute({
    sql: `SELECT po.id, po.user_id, po.amount_cents, po.method, po.details, po.status, po.note, po.created_at, po.settled_at,
                 po.request_country, u.email, u.name
            FROM affiliate_payouts po JOIN users u ON u.id = po.user_id
           WHERE po.status = ? ORDER BY po.created_at ASC LIMIT 200`,
    args: [status],
  });
  return Promise.all(res.rows.map(async (r) => {
    const row = r as unknown as Record<string, unknown>;
    const amountCents = n(row.amount_cents);
    const requestCountry = (row.request_country as string | null) ?? null;
    // Live assessment for open requests; settled ones don't need it.
    const risk: Assessment | null = status === "requested"
      ? await assessAffiliate(n(row.user_id), { method: row.method as string | null, pendingCents: amountCents, requestCountry })
      : null;
    return {
      id: n(row.id), userId: n(row.user_id), amountCents,
      method: (row.method as string | null) ?? null, details: (row.details as string | null) ?? null,
      status: String(row.status), note: (row.note as string | null) ?? null,
      createdAt: String(row.created_at ?? ""), settledAt: (row.settled_at as string | null) ?? null,
      email: String(row.email ?? ""), name: (row.name as string | null) ?? null,
      requestCountry,
      risk: risk && {
        flags: risk.flags, blocked: risk.blocked, idCheckRequired: risk.idCheckRequired, idReasons: risk.idReasons,
        profileComplete: risk.profileComplete,
        profile: {
          legalName: risk.profile.legalName, country: risk.profile.country, address: risk.profile.address,
          usPerson: risk.profile.usPerson, idStatus: risk.profile.idStatus, idNote: risk.profile.idNote,
          taxFormOnFile: risk.profile.taxFormOnFile,
        },
      },
    };
  }));
}

// Mark a requested payout paid, or reject it (which releases its commissions
// back into the affiliate's available balance).
export type SettleResult = { ok: true } | { ok: false; status: number; error: string };

export async function settlePayout(payoutId: number, action: "paid" | "rejected", note?: string): Promise<SettleResult> {
  // Paying out is gated on the affiliate's CURRENT risk state, not the snapshot.
  if (action === "paid") {
    const po = await client.execute({
      sql: "SELECT user_id, amount_cents, method, request_country FROM affiliate_payouts WHERE id = ? AND status = 'requested'",
      args: [payoutId],
    });
    const row = po.rows[0] as { user_id?: number; amount_cents?: number; method?: string | null; request_country?: string | null } | undefined;
    if (!row?.user_id) return { ok: false, status: 409, error: "That payout was already settled." };
    const risk = await assessAffiliate(n(row.user_id), { method: row.method ?? null, pendingCents: n(row.amount_cents), requestCountry: row.request_country ?? null });
    if (risk.blocked) return { ok: false, status: 422, error: `Can't pay: ${risk.blocked} Reject this payout instead.` };
    if (!risk.profileComplete) return { ok: false, status: 422, error: "Can't pay: the affiliate's payout profile is incomplete." };
    if (risk.idCheckRequired) {
      return { ok: false, status: 422, error: `Can't pay yet: ID check required (${risk.idReasons.join(", ")}). Verify their identity first.` };
    }
    if (risk.flags.some((f) => f.level === "high") && !(note && note.trim().length >= 10)) {
      return { ok: false, status: 422, error: "High-risk flags on this affiliate: add a review note (10+ characters) explaining why it's OK to pay." };
    }
  }
  const tx = await client.transaction("write");
  try {
    const upd = await tx.execute({
      sql: "UPDATE affiliate_payouts SET status = ?, note = ?, settled_at = ? WHERE id = ? AND status = 'requested'",
      args: [action, note?.slice(0, 300) ?? null, new Date().toISOString(), payoutId],
    });
    if ((upd.rowsAffected ?? 0) === 0) { await tx.rollback(); return { ok: false, status: 409, error: "That payout was already settled." }; }
    if (action === "rejected") {
      await tx.execute({ sql: "UPDATE referral_commissions SET payout_id = NULL WHERE payout_id = ?", args: [payoutId] });
    }
    await tx.commit();
    return { ok: true };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  } finally {
    tx.close();
  }
}
