// Server-side Cloudflare Turnstile verification. The browser never talks to
// siteverify: browser → our route → siteverify.
//
// Env:
//   TURNSTILE_SECRET     the widget's secret key (server only)
//   TURNSTILE_HOSTNAMES  comma-separated allowlist of hostnames the widget may
//                        be solved on, e.g. "vybecut.com,www.vybecut.com"
//
// Hosted production fails CLOSED: missing config rejects the request. Local
// dev without a secret and the desktop app (which runs on localhost, outside
// the widget's domains) skip the check.
import { isDesktop } from "./desktop";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult = { ok: true } | { ok: false; reason: string };

export async function verifyTurnstile(
  token: unknown,
  expectedAction: string,
  remoteIp?: string,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET;
  if (isDesktop()) return { ok: true };
  if (!secret) {
    if (process.env.NODE_ENV !== "production") return { ok: true };
    console.error("[turnstile] TURNSTILE_SECRET is not set; rejecting");
    return { ok: false, reason: "not-configured" };
  }

  const hostnames = (process.env.TURNSTILE_HOSTNAMES ?? "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hostnames.length === 0) {
    console.error("[turnstile] TURNSTILE_HOSTNAMES is empty; rejecting");
    return { ok: false, reason: "not-configured" };
  }

  if (typeof token !== "string" || !token || token.length > 2048) {
    return { ok: false, reason: "missing-token" };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `siteverify-http-${res.status}` };
    const data = (await res.json()) as {
      success?: boolean; action?: string; hostname?: string; "error-codes"?: string[];
    };
    if (data.success !== true) return { ok: false, reason: (data["error-codes"] ?? []).join(",") || "failed" };
    if (data.action !== expectedAction) return { ok: false, reason: "action-mismatch" };
    if (!data.hostname || !hostnames.includes(data.hostname.toLowerCase())) {
      return { ok: false, reason: "hostname-mismatch" };
    }
    return { ok: true };
  } catch (err) {
    console.error("[turnstile] siteverify failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "siteverify-error" };
  }
}
