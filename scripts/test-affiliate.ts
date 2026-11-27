/**
 * End-to-end checks for affiliate fraud protection + payout gating, against a
 * throwaway SQLite database (never your real one):
 *
 *   npx tsx scripts/test-affiliate.ts
 *
 * Covers: self-referral refusal at sign-up, risk flags (self device, network
 * clusters, email aliases, shared payout account, chargebacks), chargeback
 * reversal + reinstatement, payout profile validation, blocked countries, and
 * the "mark paid" gates (ID check, high-risk review note).
 */
import os from "os";
import path from "path";
import { mkdtempSync, rmSync } from "fs";

const dir = mkdtempSync(path.join(os.tmpdir(), "vybe-aff-test-"));
process.env.VYBE_DATA_DIR = dir;          // db.ts → file:<dir>/vybe.db
delete process.env.TURSO_DATABASE_URL;    // never touch a hosted DB
process.env.JWT_SECRET ??= "test-secret-for-affiliate-checks";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
}

function req(opts: { ip?: string; device?: string; country?: string } = {}): Request {
  const h = new Headers();
  if (opts.ip) h.set("x-forwarded-for", opts.ip);
  if (opts.device) h.set("cookie", `vybe_did=${opts.device}`);
  if (opts.country) h.set("x-vercel-ip-country", opts.country);
  return new Request("http://localhost/test", { headers: h });
}

async function main() {
  const { migrate } = await import("../src/lib/migrate");
  const { client } = await import("../src/lib/db");
  const aff = await import("../src/lib/affiliate");
  const safety = await import("../src/lib/affiliate-safety");
  await migrate();

  const mkUser = async (email: string, daysAgo = 60) => {
    const r = await client.execute({
      sql: "INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, 'x', datetime('now', ?)) RETURNING id",
      args: [email, email.split("@")[0], `-${daysAgo} days`],
    });
    return Number((r.rows[0] as unknown as { id: number }).id);
  };

  // Referrer A signs up on device DEV-A from IP 1.1.1.1.
  const A = await mkUser("alice.smith@gmail.com");
  await safety.recordSignals(A, req({ ip: "1.1.1.1", device: "DEV-AAAAAAAAAAAAAAAA" }), "signup");
  const code = await aff.getOrCreateReferralCode(A);

  // ── Sign-up time refusal ──
  const selfDev = await mkUser("other@example.com");
  const attachedSelfDev = await aff.attachReferral(selfDev, code, { email: "other@example.com", req: req({ device: "DEV-AAAAAAAAAAAAAAAA" }) });
  check("referral refused: same device as referrer", attachedSelfDev === false);
  const alias = await mkUser("alicesmith+promo@gmail.com");
  const attachedAlias = await aff.attachReferral(alias, code, { email: "alicesmith+promo@gmail.com", req: req({ device: "DEV-ZZZZZZZZZZZZZZZZ" }) });
  check("referral refused: gmail alias of referrer", attachedAlias === false);
  const legit = await mkUser("bob@example.com");
  check("referral accepted: different person", await aff.attachReferral(legit, code, { email: "bob@example.com", req: req({ device: "DEV-BBBBBBBBBBBBBBBB" }) }));
  await safety.recordSignals(legit, req({ ip: "2.2.2.2", device: "DEV-BBBBBBBBBBBBBBBB" }), "signup");

  let risk = await safety.assessAffiliate(A);
  check("clean affiliate has no high flags", !risk.flags.some((f) => f.level === "high"), risk.flags);

  // ── Flags that appear later ──
  // B logs in on A's device AFTER sign-up (attribution already happened).
  await safety.recordSignals(legit, req({ ip: "1.1.1.1", device: "DEV-AAAAAAAAAAAAAAAA" }), "login");
  // A referral farm: 3 more referred accounts on one network.
  for (const e of ["c1@example.com", "c2@example.com", "c3@example.com"]) {
    const u = await mkUser(e);
    await client.execute({ sql: "UPDATE users SET referred_by = ?, referred_at = datetime('now') WHERE id = ?", args: [A, u] });
    await safety.recordSignals(u, req({ ip: "9.9.9.9", device: `DEV-${e.slice(0, 2).toUpperCase()}XXXXXXXXXXXXXX` }), "signup");
  }
  // A second account paid out to the same PayPal.
  const twin = await mkUser("twin@example.com");
  await aff.setPayoutDetails(twin, "paypal", "payme@example.com");
  await aff.setPayoutDetails(A, "paypal", "PayMe@example.com ");

  risk = await safety.assessAffiliate(A);
  const codes = new Set(risk.flags.map((f) => f.code));
  check("flag: referred user on referrer's device (high)", codes.has("self_device"), risk.flags);
  check("flag: referrer network shared (medium)", codes.has("self_network"));
  check("flag: referral network cluster (medium)", codes.has("network_cluster"));
  check("flag: shared payout account (high)", codes.has("shared_payout"));
  check("high flags force an ID check", risk.idCheckRequired && risk.idReasons.includes("high-risk signals"), risk.idReasons);

  // ── Money: commission, chargeback, reinstatement ──
  await aff.recordPayment({ userId: legit, provider: "paddle", externalId: "txn_1", amountCents: 10_000, currency: "USD" });
  const commission = await client.execute({ sql: "SELECT SUM(amount_cents) AS t FROM referral_commissions WHERE referrer_id = ?", args: [A] });
  check("30% commission credited", Number((commission.rows[0] as unknown as { t: number }).t) === 3000, commission.rows[0]);
  await aff.reversePayment("paddle", "txn_1", "chargeback");
  let net = await client.execute({ sql: "SELECT SUM(amount_cents) AS t FROM referral_commissions WHERE referrer_id = ?", args: [A] });
  check("chargeback claws back commission", Number((net.rows[0] as unknown as { t: number }).t) === 0, net.rows[0]);
  risk = await safety.assessAffiliate(A);
  check("flag: chargeback", risk.flags.some((f) => f.code === "chargebacks"));
  await aff.reinstatePayment("paddle", "txn_1");
  await aff.reinstatePayment("paddle", "txn_1"); // idempotent
  net = await client.execute({ sql: "SELECT SUM(amount_cents) AS t FROM referral_commissions WHERE referrer_id = ?", args: [A] });
  check("won dispute restores commission (once)", Number((net.rows[0] as unknown as { t: number }).t) === 3000, net.rows[0]);

  // ── Payout profile + request ──
  // Make the commission withdrawable now.
  await client.execute({ sql: "UPDATE referral_commissions SET available_at = datetime('now', '-1 day') WHERE referrer_id = ?", args: [A] });
  let reqd = await aff.requestPayout(A, { requestCountry: "FR" });
  check("payout refused without a profile", !reqd.ok && /profile/i.test(reqd.error), reqd);

  let saved = await safety.savePayoutProfile(A, { legalName: "Alice Smith", country: "IR", address: "1 Some Street, Tehran", acceptTerms: true });
  check("profile refused for blocked country", !saved.ok, saved);
  saved = await safety.savePayoutProfile(A, { legalName: "Alice", country: "FR", address: "1 Rue Exemple, Paris", acceptTerms: true });
  check("profile refused without a full legal name", !saved.ok, saved);
  saved = await safety.savePayoutProfile(A, { legalName: "Alice Smith", country: "FR", address: "1 Rue Exemple, 75001 Paris", acceptTerms: false });
  check("profile refused without accepting terms", !saved.ok, saved);
  saved = await safety.savePayoutProfile(A, { legalName: "Alice Smith", country: "FR", address: "1 Rue Exemple, 75001 Paris", acceptTerms: true });
  check("valid profile saved", saved.ok, saved);

  reqd = await aff.requestPayout(A, { requestCountry: "KP" });
  check("payout refused when requested from a blocked country", !reqd.ok, reqd);

  reqd = await aff.requestPayout(A, { requestCountry: "DE" });
  check("payout request accepted", reqd.ok, reqd);
  check("request flags the ID check", reqd.ok && reqd.idCheckNeeded, reqd);
  const po = await client.execute({ sql: "SELECT id, request_country, risk_snapshot FROM affiliate_payouts WHERE user_id = ?", args: [A] });
  const payout = po.rows[0] as unknown as { id: number; request_country: string; risk_snapshot: string };
  check("request country + risk snapshot stored", payout.request_country === "DE" && payout.risk_snapshot.includes("shared_payout"), payout);
  const listed = await aff.listPayoutRequests("requested");
  check("admin list shows country-mismatch flag", !!listed[0]?.risk?.flags.some((f) => f.code === "country_mismatch"), listed[0]?.risk?.flags);

  // ── Mark-paid gates ──
  let settled = await aff.settlePayout(payout.id, "paid", "ref 123");
  check("mark paid refused: ID check required", !settled.ok && /ID check/i.test(settled.error), settled);
  await safety.setIdentityStatus(A, "verified", "Persona inq_123");
  settled = await aff.settlePayout(payout.id, "paid");
  check("mark paid refused: high-risk without review note", !settled.ok && /review note/i.test(settled.error), settled);
  settled = await aff.settlePayout(payout.id, "paid", "Reviewed: B is her partner, twin PayPal is her own business acct");
  check("mark paid allowed after ID + review note", settled.ok, settled);
  settled = await aff.settlePayout(payout.id, "paid", "again");
  check("double-settle refused", !settled.ok && settled.status === 409, settled);

  // Changing identity after verification re-opens the ID check.
  await safety.savePayoutProfile(A, { legalName: "Someone Else", country: "FR", address: "1 Rue Exemple, 75001 Paris", acceptTerms: true });
  const prof = await safety.getPayoutProfile(A);
  check("name change after verification resets ID status", prof.idStatus === "none", prof);

  check("email normalization", safety.normalizeEmail("A.Li.Ce+x@GoogleMail.com") === "alice@gmail.com", safety.normalizeEmail("A.Li.Ce+x@GoogleMail.com"));

  client.close();
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all affiliate checks passed");
    process.exit(failures ? 1 : 0);
  });
