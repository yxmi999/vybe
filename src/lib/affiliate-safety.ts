// Affiliate fraud protection + payout-time identity ("KYC-lite").
//
//   • Signals — every sign-up / login / payout request records a HASHED client
//     IP and a device id (a long-lived first-party cookie set by the proxy).
//     Raw IPs are never stored; hashes are only compared with each other.
//   • Payout profile — legal name, country, address, US-person status and
//     acceptance of the affiliate terms. Required before the first payout.
//   • Risk assessment — self-referral (shared device/network with referred
//     users), referral farms (referred accounts sharing devices), email
//     aliases, payout accounts shared between affiliates, refund/chargeback
//     rates, and declared-vs-connecting country.
//   • ID check — required for crypto payouts, large lifetime totals, and any
//     high-risk flag. Done with an outside provider; an admin records the
//     result here, and a payout can't be marked paid until it's verified.
//   • Blocked countries — no payouts to comprehensively sanctioned places.
//
// All amounts are integer USD cents (see lib/affiliate.ts).
import { createHmac } from "crypto";
import { client } from "./db";
import { purposeSecret } from "./auth";

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== "" && process.env[name] != null ? n : fallback;
}

// Bump when the affiliate terms change materially — affiliates re-accept
// before their next payout.
export const AFFILIATE_TERMS_VERSION = "2026-11-25";

export const SAFETY = {
  // Lifetime payouts (incl. the one being requested) at or above this need an ID check.
  idCheckCents: Math.round(envNum("AFFILIATE_ID_CHECK_USD", 600) * 100),
};

// Comprehensively sanctioned / unpayable destinations. Defaults are
// conservative — confirm the list against current sanctions rules (and your
// payout providers' own restrictions) and override with
// AFFILIATE_BLOCKED_COUNTRIES="CU,IR,KP,..." (ISO 3166-1 alpha-2).
export function blockedCountries(): Set<string> {
  const raw = process.env.AFFILIATE_BLOCKED_COUNTRIES ?? "CU,IR,KP,SY,RU,BY";
  return new Set(raw.split(",").map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)));
}

// ── Signals ─────────────────────────────────────────────────────────────────

/** Long-lived random device id cookie (set in src/proxy.ts). Keep in sync. */
export const DEVICE_COOKIE = "vybe_did";

let signalKey: Uint8Array | null = null;
/** One-way, keyed hash: equal inputs match, but the raw IP can't be recovered. */
export function hashSignal(value: string): string {
  signalKey ??= purposeSecret("affiliate-signals");
  return createHmac("sha256", Buffer.from(signalKey)).update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/** Best-effort client IP (first x-forwarded-for hop on Vercel). */
export function requestIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = fwd || req.headers.get("x-real-ip") || "";
  return ip && ip !== "unknown" ? ip : null;
}

/** Country the request comes from, when the host provides it (Vercel / Cloudflare). */
export function requestCountry(req: Request): string | null {
  const c = (req.headers.get("x-vercel-ip-country") || req.headers.get("cf-ipcountry") || "").toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" ? c : null;
}

function deviceIdFrom(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([A-Za-z0-9-]{16,64})`));
  return m ? m[1] : null;
}

export type SignalEvent = "signup" | "login" | "payout";

/** Record this request's hashed IP + device for the user. Never throws. */
export async function recordSignals(userId: number, req: Request, event: SignalEvent): Promise<void> {
  try {
    const now = new Date().toISOString();
    const pairs: [string, string][] = [];
    const ip = requestIp(req);
    const dev = deviceIdFrom(req);
    if (ip) pairs.push(["ip", hashSignal(ip)]);
    if (dev) pairs.push(["device", hashSignal(dev)]);
    for (const [kind, hash] of pairs) {
      await client.execute({
        sql: `INSERT INTO user_signals (user_id, kind, value_hash, first_event, first_seen, last_seen)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, kind, value_hash) DO UPDATE SET last_seen = excluded.last_seen`,
        args: [userId, kind, hash, event, now, now],
      });
    }
  } catch (err) {
    console.error("[affiliate-safety] recordSignals failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Canonical mailbox for alias detection: lowercase, "+tag" removed, and for
 * Gmail the dots too (a.b+x@gmail.com == ab@gmail.com).
 */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split("+")[0];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/**
 * Hard self-referral check at sign-up: the new account is on the referrer's
 * own device, or its email is an alias of the referrer's. Shared networks
 * (offices, dorms, mobile carriers) are NOT blocked here — only flagged later.
 */
export async function isObviousSelfReferral(referrerId: number, newUserEmail: string, req: Request | null): Promise<string | null> {
  const r = await client.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [referrerId] });
  const refEmail = (r.rows[0] as { email?: string } | undefined)?.email;
  if (refEmail && normalizeEmail(refEmail) === normalizeEmail(newUserEmail)) return "email alias of the referrer";
  const dev = req ? deviceIdFrom(req) : null;
  if (dev) {
    const hit = await client.execute({
      sql: "SELECT 1 FROM user_signals WHERE user_id = ? AND kind = 'device' AND value_hash = ? LIMIT 1",
      args: [referrerId, hashSignal(dev)],
    });
    if (hit.rows.length > 0) return "same device as the referrer";
  }
  return null;
}

// ── Payout profile ──────────────────────────────────────────────────────────

export type IdStatus = "none" | "pending" | "verified" | "rejected";

export type PayoutProfile = {
  legalName: string;
  country: string;          // ISO 3166-1 alpha-2
  address: string;
  usPerson: boolean;        // US citizen/resident for tax (W-9) vs not (W-8BEN)
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  idStatus: IdStatus;
  idNote: string | null;
  taxFormOnFile: boolean;   // admin confirms the signed W-9 / W-8BEN was received
  updatedAt: string | null;
};

const EMPTY_PROFILE: PayoutProfile = {
  legalName: "", country: "", address: "", usPerson: false, termsVersion: null, termsAcceptedAt: null,
  idStatus: "none", idNote: null, taxFormOnFile: false, updatedAt: null,
};

export async function getPayoutProfile(userId: number): Promise<PayoutProfile> {
  const res = await client.execute({ sql: "SELECT * FROM affiliate_profiles WHERE user_id = ?", args: [userId] });
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return { ...EMPTY_PROFILE };
  const idStatus = String(r.id_status ?? "none");
  return {
    legalName: String(r.legal_name ?? ""),
    country: String(r.country ?? ""),
    address: String(r.address ?? ""),
    usPerson: Number(r.us_person ?? 0) === 1,
    termsVersion: (r.terms_version as string | null) ?? null,
    termsAcceptedAt: (r.terms_accepted_at as string | null) ?? null,
    idStatus: (["none", "pending", "verified", "rejected"].includes(idStatus) ? idStatus : "none") as IdStatus,
    idNote: (r.id_note as string | null) ?? null,
    taxFormOnFile: Number(r.tax_form_on_file ?? 0) === 1,
    updatedAt: (r.updated_at as string | null) ?? null,
  };
}

export function profileComplete(p: PayoutProfile): boolean {
  return p.legalName.length >= 3 && /^[A-Z]{2}$/.test(p.country) && p.address.length >= 8
    && p.termsVersion === AFFILIATE_TERMS_VERSION;
}

/** Validate + save the affiliate-entered fields. Identity/tax status are admin-only. */
export async function savePayoutProfile(userId: number, input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const legalName = typeof o.legalName === "string" ? o.legalName.trim().replace(/\s+/g, " ").slice(0, 120) : "";
  const country = typeof o.country === "string" ? o.country.trim().toUpperCase() : "";
  const address = typeof o.address === "string" ? o.address.trim().slice(0, 300) : "";
  if (legalName.length < 3 || !/\s/.test(legalName)) return { ok: false, error: "Enter your full legal name (first and last)." };
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: "Pick your country." };
  if (address.length < 8) return { ok: false, error: "Enter your full postal address." };
  if (o.acceptTerms !== true) return { ok: false, error: "You need to accept the affiliate terms." };
  if (blockedCountries().has(country)) {
    return { ok: false, error: "We can't send affiliate payouts to that country." };
  }
  const usPerson = o.usPerson === true || country === "US";
  const now = new Date().toISOString();
  const before = await getPayoutProfile(userId);
  // Changing your legal name or country after an ID check re-opens it.
  const identityChanged = before.idStatus === "verified" && (before.legalName !== legalName || before.country !== country);
  await client.execute({
    sql: `INSERT INTO affiliate_profiles (user_id, legal_name, country, address, us_person, terms_version, terms_accepted_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET legal_name = excluded.legal_name, country = excluded.country,
            address = excluded.address, us_person = excluded.us_person, terms_version = excluded.terms_version,
            terms_accepted_at = excluded.terms_accepted_at, updated_at = excluded.updated_at
            ${identityChanged ? ", id_status = 'none', id_note = 'Name or country changed after verification'" : ""}`,
    args: [userId, legalName, country, address, usPerson ? 1 : 0, AFFILIATE_TERMS_VERSION, now, now],
  });
  return { ok: true };
}

export async function setIdentityStatus(userId: number, status: IdStatus, note?: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO affiliate_profiles (user_id, id_status, id_note, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET id_status = excluded.id_status, id_note = excluded.id_note, updated_at = excluded.updated_at`,
    args: [userId, status, note?.slice(0, 300) ?? null, new Date().toISOString()],
  });
}

export async function setTaxFormOnFile(userId: number, onFile: boolean): Promise<void> {
  await client.execute({
    sql: `INSERT INTO affiliate_profiles (user_id, tax_form_on_file, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET tax_form_on_file = excluded.tax_form_on_file, updated_at = excluded.updated_at`,
    args: [userId, onFile ? 1 : 0, new Date().toISOString()],
  });
}

// ── Risk assessment ─────────────────────────────────────────────────────────

export type RiskLevel = "high" | "medium" | "low";
export type RiskFlag = { level: RiskLevel; code: string; message: string };

export type Assessment = {
  flags: RiskFlag[];
  /** Payout must not be sent at all (sanctioned country). */
  blocked: string | null;
  /** An ID check is needed before this payout can be marked paid. */
  idCheckRequired: boolean;
  idReasons: string[];
  profile: PayoutProfile;
  profileComplete: boolean;
};

const n = (v: unknown) => Number(v ?? 0) || 0;

export async function assessAffiliate(userId: number, opts: { method?: string | null; pendingCents?: number; requestCountry?: string | null } = {}): Promise<Assessment> {
  const flags: RiskFlag[] = [];
  const profile = await getPayoutProfile(userId);
  const blockedSet = blockedCountries();

  const [me, sharedSelf, clusters, emails, payoutDup, money, paid] = await Promise.all([
    client.execute({ sql: "SELECT email, payout_method, payout_details, created_at FROM users WHERE id = ?", args: [userId] }),
    // Referred users seen on one of the referrer's own devices / networks.
    client.execute({
      sql: `SELECT s2.kind, COUNT(DISTINCT s2.user_id) AS users
              FROM user_signals s1
              JOIN user_signals s2 ON s2.kind = s1.kind AND s2.value_hash = s1.value_hash AND s2.user_id != s1.user_id
              JOIN users u ON u.id = s2.user_id AND u.referred_by = s1.user_id
             WHERE s1.user_id = ?
             GROUP BY s2.kind`,
      args: [userId],
    }),
    // Referred accounts that share a device / network with each other (farms).
    client.execute({
      sql: `SELECT s.kind, s.value_hash, COUNT(DISTINCT s.user_id) AS users
              FROM user_signals s JOIN users u ON u.id = s.user_id
             WHERE u.referred_by = ?
             GROUP BY s.kind, s.value_hash HAVING COUNT(DISTINCT s.user_id) >= 3
             ORDER BY users DESC LIMIT 20`,
      args: [userId],
    }),
    client.execute({ sql: "SELECT email FROM users WHERE referred_by = ? LIMIT 2000", args: [userId] }),
    // Another account getting paid to the same PayPal / wallet / Wise.
    client.execute({
      sql: `SELECT COUNT(*) AS n FROM users o, users me
             WHERE me.id = ? AND o.id != me.id AND me.payout_details IS NOT NULL
               AND LOWER(TRIM(o.payout_details)) = LOWER(TRIM(me.payout_details))`,
      args: [userId],
    }),
    client.execute({
      sql: `SELECT
              SUM(CASE WHEN kind = 'commission' THEN 1 ELSE 0 END) AS commissions,
              SUM(CASE WHEN kind = 'reversal' THEN 1 ELSE 0 END) AS reversals,
              SUM(CASE WHEN kind = 'reversal' AND reason = 'chargeback' THEN 1 ELSE 0 END) AS chargebacks
              FROM referral_commissions WHERE referrer_id = ?`,
      args: [userId],
    }),
    client.execute({ sql: "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM affiliate_payouts WHERE user_id = ? AND status = 'paid'", args: [userId] }),
  ]);

  const meRow = me.rows[0] as { email?: string; payout_method?: string | null; created_at?: string } | undefined;

  for (const r of sharedSelf.rows as unknown as { kind: string; users: number }[]) {
    if (r.kind === "device") {
      flags.push({ level: "high", code: "self_device", message: `${n(r.users)} referred account(s) used the affiliate's own device — likely self-referral.` });
    } else {
      flags.push({ level: "medium", code: "self_network", message: `${n(r.users)} referred account(s) connected from the affiliate's own network (could be household/office, or self-referral).` });
    }
  }

  const deviceFarms = (clusters.rows as unknown as { kind: string; users: number }[]).filter((c) => c.kind === "device");
  const netFarms = (clusters.rows as unknown as { kind: string; users: number }[]).filter((c) => c.kind === "ip");
  if (deviceFarms.length) {
    flags.push({ level: "high", code: "device_farm", message: `Referred accounts share devices: ${deviceFarms.map((c) => n(c.users)).join(", ")} accounts on the same device(s).` });
  }
  if (netFarms.length) {
    flags.push({ level: "medium", code: "network_cluster", message: `Referred accounts share networks: ${netFarms.map((c) => n(c.users)).join(", ")} accounts on the same IP(s).` });
  }

  if (meRow?.email) {
    const mine = normalizeEmail(meRow.email);
    const counts = new Map<string, number>();
    let selfAlias = 0;
    for (const row of emails.rows as unknown as { email: string }[]) {
      const k = normalizeEmail(String(row.email));
      if (k === mine) selfAlias++;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (selfAlias) flags.push({ level: "high", code: "email_alias_self", message: `${selfAlias} referred account(s) use an alias of the affiliate's own email.` });
    const dupes = [...counts.values()].filter((c) => c > 1).reduce((a, b) => a + b, 0);
    if (dupes) flags.push({ level: "medium", code: "email_alias_referred", message: `${dupes} referred accounts are aliases of each other (e.g. name+1@, n.a.m.e@).` });
  }

  if (n((payoutDup.rows[0] as { n?: number }).n) > 0) {
    flags.push({ level: "high", code: "shared_payout", message: "Another account uses the same payout PayPal / wallet / Wise." });
  }

  const m = money.rows[0] as { commissions?: number; reversals?: number; chargebacks?: number } | undefined;
  const commissions = n(m?.commissions), reversals = n(m?.reversals), chargebacks = n(m?.chargebacks);
  if (chargebacks > 0) {
    flags.push({ level: chargebacks >= 2 ? "high" : "medium", code: "chargebacks", message: `${chargebacks} referred payment(s) ended in a chargeback.` });
  }
  if (commissions >= 3 && reversals / commissions >= 0.3) {
    flags.push({ level: "medium", code: "refund_rate", message: `${Math.round((reversals / commissions) * 100)}% of referred payments were refunded or charged back.` });
  }

  if (meRow?.created_at && Date.now() - Date.parse(meRow.created_at + (meRow.created_at.endsWith("Z") ? "" : "Z")) < 21 * 86_400_000) {
    flags.push({ level: "low", code: "new_account", message: "Affiliate account is less than 3 weeks old." });
  }

  let blocked: string | null = null;
  if (profile.country && blockedSet.has(profile.country)) blocked = `Declared country ${profile.country} is on the blocked list.`;
  const reqC = opts.requestCountry ?? null;
  if (reqC && blockedSet.has(reqC)) blocked = `Payout requested from ${reqC}, which is on the blocked list.`;
  if (reqC && profile.country && reqC !== profile.country) {
    flags.push({ level: "low", code: "country_mismatch", message: `Declared country ${profile.country}, but connected from ${reqC} (VPN or travel?).` });
  }

  const method = opts.method ?? meRow?.payout_method ?? null;
  const lifetime = n((paid.rows[0] as { total?: number }).total) + (opts.pendingCents ?? 0);
  const idReasons: string[] = [];
  if (method === "crypto") idReasons.push("crypto payout");
  if (lifetime >= SAFETY.idCheckCents) idReasons.push(`lifetime payouts reach $${(lifetime / 100).toFixed(0)}`);
  if (flags.some((f) => f.level === "high")) idReasons.push("high-risk signals");
  const idCheckRequired = idReasons.length > 0 && profile.idStatus !== "verified";

  return { flags, blocked, idCheckRequired, idReasons, profile, profileComplete: profileComplete(profile) };
}
