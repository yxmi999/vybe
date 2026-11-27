import { db } from "./db";
import { accounts } from "./schema";
import { eq } from "drizzle-orm";
import * as instagram from "./platforms/instagram";

type Account = typeof accounts.$inferSelect;

// Long-lived Instagram tokens last 60 days and can be extended (once they're
// >24h old) for another 60. Extend whenever fewer than 30 days remain, so any
// account Vybe touches at least monthly never expires.
const REFRESH_WHEN_LEFT = 30 * 24 * 3600;

/** Return a usable Instagram access token, extending it first if it's getting old. */
export async function getFreshInstagramToken(account: Account): Promise<string> {
  if (!account.accessToken) throw new Error("Instagram is disconnected. Reconnect it on the Accounts page.");
  const now = Math.floor(Date.now() / 1000);
  const expiry = account.tokenExpiry ?? 0;
  if (expiry && expiry <= now) {
    throw new Error("Your Instagram connection expired. Reconnect Instagram on the Accounts page.");
  }
  if (expiry - now > REFRESH_WHEN_LEFT) return account.accessToken;

  try {
    const t = await instagram.refreshAccessToken(account.accessToken);
    await db.update(accounts)
      .set({ accessToken: t.accessToken, tokenExpiry: now + t.expiresIn })
      .where(eq(accounts.id, account.id));
    return t.accessToken;
  } catch (err) {
    // Still valid — use it and try extending again next time.
    console.warn("[instagram] token refresh failed:", err instanceof Error ? err.message : err);
    return account.accessToken;
  }
}

/** Human-readable text for common Instagram Graph API errors. */
export function instagramErrorMessage(err: unknown): string {
  if (err instanceof instagram.InstagramApiError) {
    if (err.code === 190) return "Your Instagram connection expired or was revoked. Reconnect Instagram on the Accounts page.";
    if (err.code === 10 || err.code === 200) return "Vybe is missing an Instagram permission. Reconnect Instagram and approve all requested permissions.";
    if (err.code === 9 || err.subcode === 2207042) return "This Instagram account hit its posting limit (100 posts per 24h). Try again later.";
    if (err.code === 4 || err.code === 17 || err.code === 32) return "Instagram is rate-limiting Vybe right now. The post will need to be retried later.";
    return `Instagram error: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
