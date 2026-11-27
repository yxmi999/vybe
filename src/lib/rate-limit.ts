// Fixed-window rate limiter backed by the main DB, so limits hold across
// serverless instances without an extra service. Fails OPEN on DB errors:
// a bookkeeping hiccup must never lock everyone out of signing in.
import { client } from "./db";

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= client
    .execute(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL
    )`)
    .then(() => undefined)
    .catch((err) => { tableReady = null; throw err; });
  return tableReady;
}

export type RateLimitResult = { allowed: boolean; retryAfterSec: number };

/**
 * Count one hit against `key` and report whether it's within `limit` hits per
 * `windowSec`. Every call counts, including ones that end up rejected.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  try {
    await ensureTable();
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSec);
    // New window → reset to 1; same window → increment. One atomic statement.
    const res = await client.execute({
      sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
            ON CONFLICT(key) DO UPDATE SET
              count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
              window_start = excluded.window_start
            RETURNING count`,
      args: [key, windowStart],
    });
    const count = Number((res.rows[0] as { count?: number | bigint } | undefined)?.count ?? 1);
    return { allowed: count <= limit, retryAfterSec: windowStart + windowSec - now };
  } catch {
    return { allowed: true, retryAfterSec: 0 };
  }
}

/** Best-effort client IP. On Vercel, x-forwarded-for's first entry is the real client. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function tooManyRequests(retryAfterSec: number, message = "Too many attempts. Please try again later.") {
  return Response.json({ error: message }, {
    status: 429,
    headers: { "Retry-After": String(Math.max(1, retryAfterSec)) },
  });
}
