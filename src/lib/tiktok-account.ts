import { db } from "./db";
import { accounts } from "./schema";
import { and, eq } from "drizzle-orm";
import * as tiktok from "./platforms/tiktok";

/**
 * Load one of the user's TikTok accounts and return a usable access token,
 * refreshing it first if it expires within 5 minutes (TikTok tokens last 24h).
 */
export async function getTiktokAccount(userId: number, accountId: number) {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId), eq(accounts.platform, "tiktok")))
    .limit(1);
  if (!account) return null;

  const now = Math.floor(Date.now() / 1000);
  if ((account.tokenExpiry ?? 0) - now > 300) return { account, accessToken: account.accessToken };

  if (!account.refreshToken) {
    throw new Error("Your TikTok connection expired. Reconnect TikTok on the Accounts page.");
  }
  const tokens = await tiktok.refreshAccessToken(account.refreshToken);
  await db.update(accounts).set({
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    tokenExpiry: now + (tokens.expires_in ?? 86400),
  }).where(eq(accounts.id, account.id));
  return { account, accessToken: tokens.access_token };
}

/** Human-readable text for TikTok's Content Posting API error codes. */
export function tiktokErrorMessage(err: unknown): string {
  if (err instanceof tiktok.TikTokApiError) {
    switch (err.code) {
      case "spam_risk_too_many_posts":
      case "spam_risk_user_banned_from_posting":
        return "TikTok isn't letting this account post right now (daily posting limit reached). Try again later.";
      case "reached_active_user_cap":
        return "Vybe has hit TikTok's daily posting limit. Please try again later.";
      case "unaudited_client_can_only_post_to_private_accounts":
        return "Until Vybe's TikTok app is approved, posts must be private (Only me), and the TikTok account must be set to private.";
      case "privacy_level_option_mismatch":
        return "That privacy option isn't available for this account. Pick another one.";
      case "access_token_invalid":
      case "scope_not_authorized":
        return "Your TikTok connection is missing permissions. Reconnect TikTok on the Accounts page.";
      default:
        return `TikTok error: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
