// Shared by the twitter/youtube/tiktok/instagram connect routes. The OAuth
// callback can't rely on the session cookie (it's a redirect from the
// provider, and localhost vs 127.0.0.1 cookie domains don't match), so the
// userId — and which client started the flow — travels in `state` instead.
// `client` decides where the callback sends the browser back to: the web
// portal, or the mobile app's deep link.
//
// For PKCE flows (twitter, tiktok) the code verifier also travels in `state`
// rather than a cookie: on mobile the authorize URL opens in a *separate*
// system browser session (ASWebAuthenticationSession / Custom Tabs), which
// doesn't share cookie storage with the app's own fetch client, so a
// verifier cookie set on the initiation response would never reach the
// callback. `state` round-trips through the provider unmodified regardless
// of client, so it works for both.
//
// Because the callback trusts `state` to say which Vybe user to attach the
// platform account to, it is sealed with AES-256-GCM under a server key:
// it can't be forged or edited (no "attach my account to user 42"), it's
// bound to one provider, it expires after 10 minutes, and the PKCE verifier
// inside it isn't readable from the URL.
import crypto from "crypto";
import { getServerSession, purposeSecret } from "./auth";

export type OAuthClient = "web" | "mobile";
export type OAuthProvider = "twitter" | "youtube" | "tiktok" | "instagram";

export const MOBILE_OAUTH_REDIRECT = process.env.MOBILE_OAUTH_REDIRECT_URL ?? "vybe://oauth-callback";

const STATE_TTL_SECONDS = 600;

function key(): Buffer {
  return crypto.createHash("sha256").update(purposeSecret("oauth-state")).digest();
}

type Payload = { p: OAuthProvider; n: string; u: number; c: OAuthClient; v?: string; e: number };

export function encodeState(
  provider: OAuthProvider,
  state: string,
  userId: number,
  client: OAuthClient = "web",
  verifier?: string,
): string {
  const payload: Payload = {
    p: provider, n: state, u: userId, c: client,
    ...(verifier ? { v: verifier } : {}),
    e: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(provider));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/**
 * Open a sealed state. Returns null if it was tampered with, issued for a
 * different provider, or has expired.
 */
export function decodeState(
  raw: string,
  provider: OAuthProvider,
): { state: string; userId: number; client: OAuthClient; verifier?: string } | null {
  try {
    const buf = Buffer.from(raw, "base64url");
    if (buf.length < 12 + 16 + 1) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(provider));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    const p = JSON.parse(json) as Payload;
    if (p.p !== provider || p.e < Math.floor(Date.now() / 1000)) return null;
    if (!Number.isInteger(p.u) || (p.c !== "web" && p.c !== "mobile")) return null;
    return { state: p.n, userId: p.u, client: p.c, verifier: p.v };
  } catch {
    return null;
  }
}

/**
 * True when this browser is signed in to Vybe as someone *other* than the
 * user the state was issued to — i.e. someone tricked them into finishing an
 * attacker's connect link, which would hand the attacker their social account.
 * No session (mobile system browser, host mismatch in dev) isn't a mismatch.
 */
export async function stateOwnerMismatch(stateUserId: number): Promise<boolean> {
  const session = await getServerSession().catch(() => null);
  return !!session && session.userId !== stateUserId;
}

// Where to send the browser after the callback finishes, for each client.
export function accountsRedirect(client: OAuthClient, appUrl: string, query: string) {
  return client === "mobile" ? `${MOBILE_OAUTH_REDIRECT}?${query}` : `${appUrl}/accounts?${query}`;
}
