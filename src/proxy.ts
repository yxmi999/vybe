import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PREFIXES = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
  "/api/auth/oauth", // Google/GitHub/Discord sign-in start + callback (pre-session)
  "/api/auth/verify-email", // emailed link, may open on another device; /send checks the session itself
  "/api/init",
  "/api/clips/cleanup", // cron-triggered; guards itself with CRON_SECRET
  "/api/auto-pilot/run", // cron-triggered; guards itself with CRON_SECRET
  "/api/scheduler", // cron-triggered (publishes due posts); GET guards itself with CRON_SECRET, POST requires a session
  "/api/blob-upload", // Vercel Blob's upload-completed callback has no session; the route checks the session itself for token requests and verifies Blob's signature on callbacks
  // Payment-provider webhooks have no session; each verifies its own signature.
  "/api/billing/polar/webhook",
  "/api/billing/paddle/webhook",
  "/api/billing/crypto/webhook",
  "/api/desktop", // desktop shell control calls; guard themselves with the per-launch secret (404 off-desktop)

  "/_next",
  "/favicon",
  "/uploads",
  "/privacy",
  "/terms",
  "/refunds",
  "/affiliate-terms",
  "/pay", // Paddle checkout / payment-update links (may be opened signed out)
];

const AUTH_PAGES = ["/login", "/register"];

function b64urlDecode(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
}

async function verifyJWT(token: string): Promise<boolean> {
  try {
    const [header, payload, sig] = token.split(".");
    if (!header || !payload || !sig) return false;

    // Match lib/auth.ts: the dev fallback is never accepted in production.
    const secret = process.env.JWT_SECRET
      ?? (process.env.NODE_ENV === "production" ? null : "vybe-dev-secret-change-in-production");
    if (!secret) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    if (!valid) return false;

    const decoded = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (decoded.exp && decoded.exp < Date.now() / 1000) return false;

    return true;
  } catch {
    return false;
  }
}

// Static assets served from /public (logo.png, *.svg, *.ico, etc.) live at the
// root and aren't covered by the _next exclusions, so let them through here.
const STATIC_ASSET = /\.(png|jpe?g|svg|gif|webp|ico|avif|woff2?|ttf|otf)$/i;

// Affiliate links (/?ref=CODE, works on any page): remember the code for 30
// days so it's attributed at sign-up, by email or OAuth. First touch wins: an
// existing ref cookie is never overwritten. Keep in sync with lib/affiliate.ts.
const REF_COOKIE = "vybe_ref";
const REF_COOKIE_DAYS = 30;
function withRef(req: NextRequest, res: NextResponse): NextResponse {
  const ref = req.nextUrl.searchParams.get("ref");
  if (ref && /^[A-Za-z0-9]{4,16}$/.test(ref) && !req.cookies.get(REF_COOKIE)) {
    res.cookies.set(REF_COOKIE, ref.toUpperCase(), {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * REF_COOKIE_DAYS, path: "/",
    });
  }
  return res;
}

// Long-lived random device id (first-party, httpOnly) for affiliate fraud
// checks: lets lib/affiliate-safety.ts tell "same browser" self-referrals apart
// from people who merely share a network. Never sent to third parties.
// Keep the name in sync with DEVICE_COOKIE in lib/affiliate-safety.ts.
const DEVICE_COOKIE = "vybe_did";
function withDevice(req: NextRequest, res: NextResponse): NextResponse {
  if (!req.cookies.get(DEVICE_COOKIE) && !req.nextUrl.pathname.startsWith("/_next")) {
    res.cookies.set(DEVICE_COOKIE, crypto.randomUUID(), {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 365 * 2, path: "/",
    });
  }
  return res;
}

export async function proxy(req: NextRequest) {
  return withDevice(req, withRef(req, await route(req)));
}

async function route(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (STATIC_ASSET.test(pathname)) {
    return NextResponse.next();
  }

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = req.cookies.get("vybe_token")?.value;
  const authed = token ? await verifyJWT(token) : false;

  // Landing page + auth pages: redirect to dashboard if already logged in
  if (pathname === "/" || AUTH_PAGES.includes(pathname)) {
    return authed
      ? NextResponse.redirect(new URL("/dashboard", req.url))
      : NextResponse.next();
  }

  if (!authed) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const res = NextResponse.redirect(new URL("/login", req.url));
    res.cookies.delete("vybe_token");
    return res;
  }

  return NextResponse.next();
}

export const config = {
  // Static files never need the auth check — skipping them here avoids a
  // proxy invocation (billed) for every font, logo and icon request.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads/|.*\\.(?:png|jpe?g|svg|gif|webp|ico|avif|woff2?|ttf|otf)$).*)"],
};
