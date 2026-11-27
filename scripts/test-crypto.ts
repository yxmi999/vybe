/**
 * NOWPayments IPN webhook checks against a throwaway SQLite DB (never your
 * real one) with a test IPN secret — no NOWPayments account needed:
 *
 *   npx tsx scripts/test-crypto.ts
 *
 * Covers: signature rejection, grant on paid status, exactly-once across the
 * confirmed → sending → finished deliveries, amount/currency checks, non-paid
 * statuses, stacking time on the same plan, and expiry downgrade.
 */
import os from "os";
import path from "path";
import crypto from "crypto";
import { mkdtempSync, rmSync } from "fs";

const dir = mkdtempSync(path.join(os.tmpdir(), "vybe-crypto-test-"));
process.env.VYBE_DATA_DIR = dir;
delete process.env.TURSO_DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret";
const SECRET = "test-ipn-secret";
process.env.NOWPAYMENTS_IPN_SECRET = SECRET;
process.env.NOWPAYMENTS_API_KEY = "test";

let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
};

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
function ipn(body: Record<string, unknown>, opts: { badSig?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac("sha512", SECRET).update(JSON.stringify(sortKeys(body))).digest("hex");
  return new Request("http://localhost/api/billing/crypto/webhook", {
    method: "POST", body: raw, headers: { "x-nowpayments-sig": opts.badSig ? "00" + sig.slice(2) : sig },
  });
}

async function main() {
  const { migrate } = await import("../src/lib/migrate");
  const { client } = await import("../src/lib/db");
  const { POST } = await import("../src/app/api/billing/crypto/webhook/route");
  const { encodeOrderId } = await import("../src/lib/nowpayments");
  const { downgradeExpired } = await import("../src/lib/billing");
  await migrate();

  const r = await client.execute("INSERT INTO users (email, name, password_hash) VALUES ('c@example.com','c','x') RETURNING id");
  const uid = Number((r.rows[0] as unknown as { id: number }).id);
  const user = async () => (await client.execute({ sql: "SELECT plan, billing_provider, current_period_end FROM users WHERE id = ?", args: [uid] })).rows[0] as unknown as { plan: string; billing_provider: string; current_period_end: string };
  const payments = async () => Number(((await client.execute({ sql: "SELECT COUNT(*) AS n FROM payments WHERE user_id = ?", args: [uid] })).rows[0] as unknown as { n: number }).n);

  const order = encodeOrderId(uid, "creator", "monthly");
  const base = { order_id: order, price_amount: 13, price_currency: "usd", pay_currency: "btc", actually_paid: 0.0002 };

  let res = await POST(ipn({ ...base, payment_status: "finished" }, { badSig: true }));
  check("bad signature → 400, nothing granted", res.status === 400 && (await user()).plan === "free");

  res = await POST(ipn({ ...base, payment_status: "waiting" }));
  check("waiting → no grant", res.status === 200 && (await user()).plan === "free");
  res = await POST(ipn({ ...base, payment_status: "partially_paid" }));
  check("partially_paid → no grant", (await user()).plan === "free");

  for (const s of ["confirmed", "sending", "finished"]) await POST(ipn({ ...base, payment_status: s }));
  const u1 = await user();
  const days = (Date.parse(u1.current_period_end) - Date.now()) / 86_400_000;
  check("paid → Creator via crypto", u1.plan === "creator" && u1.billing_provider === "crypto", u1);
  check("three paid deliveries grant ONE month (not three)", days > 29 && days < 31.5, days);
  check("one payment row", (await payments()) === 1);

  const cheap = encodeOrderId(uid, "pro", "yearly");
  await POST(ipn({ order_id: cheap, price_amount: 13, price_currency: "usd", payment_status: "finished" }));
  check("Pro yearly order paid at $13 → refused", (await user()).plan === "creator" && (await payments()) === 1);
  const eur = encodeOrderId(uid, "creator", "monthly");
  await POST(ipn({ order_id: eur, price_amount: 13, price_currency: "eur", payment_status: "finished" }));
  check("non-USD invoice → refused", (await payments()) === 1);
  await POST(ipn({ order_id: "garbage", price_amount: 13, price_currency: "usd", payment_status: "finished" }));
  check("undecodable order → ignored", (await payments()) === 1);

  const again = encodeOrderId(uid, "creator", "monthly");
  await POST(ipn({ order_id: again, price_amount: 13, price_currency: "usd", payment_status: "finished" }));
  const days2 = (Date.parse((await user()).current_period_end) - Date.now()) / 86_400_000;
  check("second Creator month stacks (≈60 days)", days2 > 59 && days2 < 62, days2);

  await client.execute({ sql: "UPDATE users SET current_period_end = ? WHERE id = ?", args: [new Date(Date.now() - 60_000).toISOString(), uid] });
  const n = await downgradeExpired();
  check("lapsed crypto period → Free on the daily cleanup", n === 1 && (await user()).plan === "free");

  client.close();
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file lock */ }
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all crypto checks passed");
    process.exit(failures ? 1 : 0);
  });
