// API key pools: when one key hits its quota/rate limit (or is rejected),
// requests automatically move to the next key. Server-only.
//
// Configure in .env.local — comma-separated, tried in order:
//   GOOGLE_GENERATIVE_AI_API_KEYS=key1,key2,key3   (plus/or GOOGLE_GENERATIVE_AI_API_KEY)
//   GROQ_API_KEYS=key1,key2                         (plus/or GROQ_API_KEY)
//
// A key that runs out is parked: until the daily reset (midnight US Pacific,
// when Google/Groq reset free daily quotas) for a daily-quota error, ~1 min
// for a per-minute rate limit, 1 h if the key is rejected. The same request is
// retried at once with the next key, so callers never see the swap.
import { createGoogleGenerativeAI } from "@ai-sdk/google";

type Pool = { name: string; keys: string[] };
type Parked = Map<string, { until: number; reason: string }>;

// One shared state across route bundles (Next can load a module per route).
const g = globalThis as unknown as { __vybeParkedKeys?: Parked };
const parked: Parked = (g.__vybeParkedKeys ??= new Map());

function readPool(name: string, single: string, multi: string): Pool {
  const list = [process.env[single] ?? "", ...(process.env[multi] ?? "").split(",")]
    .map((k) => k.trim())
    .filter(Boolean);
  return { name, keys: [...new Set(list)] };
}
// Many call sites check `process.env.GOOGLE_GENERATIVE_AI_API_KEY` to see if
// AI is configured; if only the list form is set, expose its first key there.
for (const [single, multi] of [["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEYS"], ["GROQ_API_KEY", "GROQ_API_KEYS"]]) {
  if (!process.env[single] && process.env[multi]) process.env[single] = process.env[multi]!.split(",")[0].trim();
}

export const geminiPool = () => readPool("gemini", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEYS");
export const groqPool = () => readPool("groq", "GROQ_API_KEY", "GROQ_API_KEYS");

// Next midnight in America/Los_Angeles (daily free quotas reset then).
function nextPacificMidnight(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return now - elapsed + 24 * 3600 * 1000 + 60_000; // +1 min of slack
}

/** How long to park a key, from a failed response — or null if it's not the key's fault. */
function parkFor(status: number, body: string): { ms: number; reason: string } | null {
  const b = body.toLowerCase();
  if (status === 429 || b.includes("resource_exhausted") || b.includes("exceeded your current quota")) {
    const daily = /per ?day|perday|daily|requests per day|tokens per day|rpd|tpd/.test(b);
    return daily
      ? { ms: nextPacificMidnight() - Date.now(), reason: "daily quota used up" }
      : { ms: 65_000, reason: "rate limited" };
  }
  if (status === 401 || (status === 403 && /api key|permission|forbidden|not valid|invalid/.test(b)) ||
      (status === 400 && /api key not valid|api_key_invalid|invalid api key/.test(b))) {
    return { ms: 3600_000, reason: "key rejected" };
  }
  return null;
}

const tag = (key: string) => `…${key.slice(-4)}`;

/** A 404 meaning "this model isn't available (to this key)", vs. a bad URL. */
export function modelUnavailable(body: string): boolean {
  return /no longer available|is not found for api version|not supported for generatecontent|models\/[\w.-]+ is not found/i.test(body);
}

function available(pool: Pool): string[] {
  const now = Date.now();
  return pool.keys.filter((k) => (parked.get(k)?.until ?? 0) <= now);
}

/**
 * fetch() through a key pool. `setKey` writes the key into the request (a
 * header, usually). On a quota/auth failure the key is parked and the request
 * re-sent with the next key; the last failure is returned if all are parked.
 */
export async function poolFetch(
  pool: Pool,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  setKey: (headers: Headers, key: string) => void,
): Promise<Response> {
  const keys = available(pool);
  if (keys.length === 0) {
    const soonest = Math.min(...pool.keys.map((k) => parked.get(k)?.until ?? Infinity));
    const when = Number.isFinite(soonest) ? new Date(soonest).toLocaleString() : "later";
    return new Response(JSON.stringify({
      error: { message: `All ${pool.keys.length} ${pool.name} API key(s) are used up or rate-limited — next one frees up at ${when}.`, code: 429 },
    }), { status: 429, headers: { "content-type": "application/json" } });
  }
  let last: Response | null = null;
  for (const key of keys) {
    const headers = new Headers(init?.headers);
    setKey(headers, key);
    const res = await fetch(input, { ...init, headers });
    if (res.ok) return res;
    const body = await res.clone().text().catch(() => "");
    // Newer Google accounts can't use retired models ("no longer available to
    // new users") that older keys still can — try the next key for THIS
    // request without parking this one (it's fine for other models).
    if (res.status === 404 && modelUnavailable(body)) { last = res; continue; }
    const park = parkFor(res.status, body);
    if (!park) return res; // a real request error — not the key's fault; don't burn other keys on it
    parked.set(key, { until: Date.now() + park.ms, reason: park.reason });
    console.warn(`[ai-keys] ${pool.name} key ${tag(key)} parked (${park.reason}) until ${new Date(Date.now() + park.ms).toLocaleString()}; ${keys.length - 1 - keys.indexOf(key)} more to try`);
    last = res;
  }
  return last!;
}

/** Status for display: which keys are usable and which are parked until when. */
export function keyStatus() {
  const now = Date.now();
  return [geminiPool(), groqPool()].map((p) => ({
    provider: p.name,
    keys: p.keys.map((k) => {
      const pk = parked.get(k);
      return pk && pk.until > now
        ? { key: tag(k), ok: false, reason: pk.reason, until: new Date(pk.until).toISOString() }
        : { key: tag(k), ok: true };
    }),
  }));
}

// Drop-in replacement for `google` from @ai-sdk/google that rotates keys.
// (The provider still wants an apiKey at construction; the real one is set
// per request by the pool.)
export const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "pool",
  fetch: (input, init) => poolFetch(geminiPool(), input, init, (h, key) => h.set("x-goog-api-key", key)),
});
