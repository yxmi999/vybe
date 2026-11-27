/**
 * One-command Paddle setup. Creates (or finds) everything Vybe's card checkout
 * needs in the Paddle account behind PADDLE_API_KEY:
 *
 *   • products "Vybe Creator" and "Vybe Pro"
 *   • monthly + yearly USD prices, from src/lib/pricing.ts (single source of truth)
 *   • the webhook destination (optional: --webhook-url), with the events we handle
 *
 * Idempotent: re-running reuses what exists (matched by custom_data.vybe_key and
 * amount). A changed amount creates a NEW price and leaves the old one alone, so
 * existing subscribers keep their price.
 *
 *   npx tsx --env-file=.env.local scripts/paddle-setup.ts                 # dry run: show what exists / would be created
 *   npx tsx --env-file=.env.local scripts/paddle-setup.ts --apply         # create missing products/prices
 *   ... --apply --webhook-url https://vybecut.com/api/billing/paddle/webhook
 *   ... --apply --write-env .env.local                                   # also write the ids/secret into that file
 *
 * Needs an API key with write access to products, prices and notification settings.
 * PADDLE_ENV=production targets the live account; anything else is sandbox.
 */
import { readFileSync, writeFileSync } from "fs";
import { PLAN_PRICING, type PaidPlan, type Interval } from "../src/lib/pricing";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = flag("--apply");
const WEBHOOK_URL = opt("--webhook-url");
const WRITE_ENV = opt("--write-env");

const KEY = process.env.PADDLE_API_KEY;
const LIVE = process.env.PADDLE_ENV === "production";
const BASE = LIVE ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";

// Events lib/paddle.ts + the webhook route act on.
const EVENTS = [
  "subscription.created", "subscription.updated", "subscription.activated", "subscription.canceled",
  "subscription.paused", "subscription.resumed",
  "transaction.completed",
  "adjustment.created", "adjustment.updated",
];

type Obj = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown): Promise<Obj> {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok) {
    const err = json.error as { code?: string; detail?: string } | undefined;
    throw new Error(`${method} ${path} → ${res.status} ${err?.code ?? ""}: ${err?.detail ?? JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function listAll(path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  let next: string | null = path;
  while (next) {
    const page = await api("GET", next);
    out.push(...((page.data as Obj[]) ?? []));
    const nextUrl = ((page.meta as Obj | undefined)?.pagination as Obj | undefined)?.next as string | undefined;
    const hasMore = ((page.meta as Obj | undefined)?.pagination as Obj | undefined)?.has_more === true;
    next = hasMore && nextUrl ? nextUrl.replace(BASE, "") : null;
  }
  return out;
}

const PLANS: { plan: PaidPlan; name: string; description: string }[] = [
  { plan: "creator", name: "Vybe Creator", description: "Unlimited clips, 1080p exports, no watermark, Auto-Pilot." },
  { plan: "pro", name: "Vybe Pro", description: "Everything in Creator with higher limits for full-time creators and teams." },
];
const INTERVALS: { interval: Interval; paddle: "month" | "year"; label: string }[] = [
  { interval: "monthly", paddle: "month", label: "Monthly" },
  { interval: "yearly", paddle: "year", label: "Yearly" },
];

async function main() {
  if (!KEY) throw new Error("PADDLE_API_KEY is empty. Create an API key in Paddle → Developer tools → Authentication and put it in .env.local.");
  console.log(`Paddle ${LIVE ? "PRODUCTION (live money!)" : "sandbox"} · ${APPLY ? "applying changes" : "dry run (add --apply to create)"}\n`);

  const env: Record<string, string> = {};
  const products = await listAll("/products?status=active&per_page=100");

  for (const p of PLANS) {
    let product = products.find((x) => (x.custom_data as Obj | null)?.vybe_key === p.plan)
      ?? products.find((x) => x.name === p.name);
    if (!product) {
      if (!APPLY) { console.log(`+ would create product "${p.name}"`); continue; }
      const body = { name: p.name, description: p.description, custom_data: { vybe_key: p.plan } };
      try {
        product = (await api("POST", "/products", { ...body, tax_category: "saas" })).data as Obj;
      } catch (err) {
        // "saas" needs approval on some accounts; "standard" always works.
        console.log(`  (tax_category saas refused: ${(err as Error).message.slice(0, 120)}) → using standard`);
        product = (await api("POST", "/products", { ...body, tax_category: "standard" })).data as Obj;
      }
      console.log(`✓ created product "${p.name}" ${product.id}`);
    } else {
      console.log(`= product "${p.name}" ${product.id}`);
    }

    const prices = await listAll(`/prices?product_id=${product.id}&status=active&per_page=100`);
    for (const iv of INTERVALS) {
      const cents = String(Math.round(PLAN_PRICING[p.plan][iv.interval] * 100));
      const key = `${p.plan}_${iv.interval}`;
      const match = prices.find((x) => {
        const up = x.unit_price as Obj; const bc = x.billing_cycle as Obj | null;
        return up?.amount === cents && up?.currency_code === "USD" && bc?.interval === iv.paddle && bc?.frequency === 1;
      });
      const envName = `PADDLE_PRICE_${p.plan.toUpperCase()}_${iv.interval.toUpperCase()}`;
      if (match) {
        console.log(`  = ${iv.label} $${Number(cents) / 100} ${match.id}`);
        env[envName] = String(match.id);
        continue;
      }
      if (!APPLY) { console.log(`  + would create ${iv.label} price $${Number(cents) / 100} USD`); continue; }
      const price = (await api("POST", "/prices", {
        product_id: product.id,
        name: `${p.name} ${iv.label}`,
        description: `${p.name} — billed ${iv.interval}`,
        unit_price: { amount: cents, currency_code: "USD" },
        billing_cycle: { interval: iv.paddle, frequency: 1 },
        custom_data: { vybe_key: key },
      })).data as Obj;
      console.log(`  ✓ created ${iv.label} price $${Number(cents) / 100} ${price.id}`);
      env[envName] = String(price.id);
    }
  }

  if (WEBHOOK_URL) {
    if (!/^https:\/\//.test(WEBHOOK_URL)) throw new Error("--webhook-url must be https:// (Paddle can't reach localhost; use a tunnel for local testing).");
    const dests = await listAll("/notification-settings");
    const existing = dests.find((d) => d.destination === WEBHOOK_URL);
    if (existing) {
      const have = new Set(((existing.subscribed_events as Obj[]) ?? []).map((e) => String(e.name)));
      const missing = EVENTS.filter((e) => !have.has(e));
      console.log(`\n= webhook ${WEBHOOK_URL} ${existing.id} (active=${existing.active})${missing.length ? ` — missing events: ${missing.join(", ")}` : ""}`);
      if (missing.length && APPLY) {
        await api("PATCH", `/notification-settings/${existing.id}`, { subscribed_events: EVENTS, active: true });
        console.log("  ✓ events updated");
      }
      if (existing.endpoint_secret_key) env.PADDLE_WEBHOOK_SECRET = String(existing.endpoint_secret_key);
    } else if (!APPLY) {
      console.log(`\n+ would create webhook → ${WEBHOOK_URL}`);
    } else {
      const created = (await api("POST", "/notification-settings", {
        description: "Vybe billing webhook",
        destination: WEBHOOK_URL,
        type: "url",
        subscribed_events: EVENTS,
        include_sensitive_fields: false,
      })).data as Obj;
      console.log(`\n✓ created webhook ${created.id} → ${WEBHOOK_URL}`);
      if (created.endpoint_secret_key) env.PADDLE_WEBHOOK_SECRET = String(created.endpoint_secret_key);
    }
  }

  // Client-side token for Paddle.js on /pay (public by design — it ships to browsers).
  const tokens = await listAll("/client-tokens");
  const active = tokens.find((t) => t.status === "active" && t.name === "Vybe web checkout")
    ?? tokens.find((t) => t.status === "active");
  if (active?.token) {
    console.log(`\n= client token ${active.id}`);
    env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = String(active.token);
  } else if (!APPLY) {
    console.log("\n+ would create a client-side token");
  } else {
    const t = (await api("POST", "/client-tokens", { name: "Vybe web checkout", description: "Paddle.js on /pay" })).data as Obj;
    console.log(`\n✓ created client token ${t.id}`);
    env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = String(t.token);
  }
  env.PADDLE_ENV = LIVE ? "production" : "sandbox";
  env.NEXT_PUBLIC_PADDLE_ENV = env.PADDLE_ENV;

  const names = Object.keys(env);
  if (!names.length) { console.log("\nNothing to write yet."); return; }
  if (WRITE_ENV) {
    let text = readFileSync(WRITE_ENV, "utf8");
    for (const [k, v] of Object.entries(env)) {
      // [^\r\n]* rather than .*$ — with CRLF files, `$` doesn't match before \r,
      // which used to append a duplicate line instead of replacing it.
      const re = new RegExp(`^${k}=[^\\r\\n]*`, "m");
      text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\s*$/, "")}\n${k}=${v}\n`;
    }
    writeFileSync(WRITE_ENV, text);
    console.log(`\n✓ wrote ${names.join(", ")} to ${WRITE_ENV}`);
  } else {
    console.log("\nAdd these to your env (secret values hidden — use --write-env to write them):");
    for (const [k, v] of Object.entries(env)) console.log(`${k}=${k.includes("SECRET") ? "<hidden>" : v}`);
  }
}

main().catch((e) => { console.error("\n✗", e instanceof Error ? e.message : e); process.exit(1); });
