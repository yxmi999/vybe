// Shared per-post metrics fetching — used by the manual analytics refresh
// (/api/analytics POST) and the automatic Auto-Pilot outcome tracker.
import { db } from "./db";
import { accounts, analytics } from "./schema";
import { eq } from "drizzle-orm";
import * as instagram from "./platforms/instagram";
import * as twitter from "./platforms/twitter";
import * as tiktok from "./platforms/tiktok";
import * as youtube from "./platforms/youtube";
import { getFreshInstagramToken } from "./instagram-account";

type Account = typeof accounts.$inferSelect;

export type PostMetrics = { likes: number; comments: number; shares: number; reach: number; impressions: number };

export async function getFreshYoutubeToken(account: Account): Promise<string> {
  const expiresAt = account.tokenExpiry ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now > 300) return account.accessToken;
  if (!account.refreshToken) throw new Error("YouTube token expired — please reconnect your account.");
  const tokens = await youtube.refreshAccessToken(account.refreshToken);
  await db
    .update(accounts)
    .set({ accessToken: tokens.access_token, tokenExpiry: now + (tokens.expires_in ?? 3600) })
    .where(eq(accounts.id, account.id));
  return tokens.access_token;
}

/** Fetch live metrics for one published post; null when the platform has no fetcher. */
export async function fetchPostMetrics(account: Account, platformPostId: string): Promise<PostMetrics | null> {
  if (account.platform === "instagram") return instagram.getPostInsights(await getFreshInstagramToken(account), platformPostId);
  if (account.platform === "twitter") return twitter.getTweetMetrics(account.accessToken, platformPostId);
  if (account.platform === "tiktok") return tiktok.getVideoMetrics(account.accessToken, [platformPostId]);
  if (account.platform === "youtube") {
    const token = await getFreshYoutubeToken(account);
    return youtube.getVideoMetrics(token, platformPostId);
  }
  return null;
}

/** Upsert the metrics row for a post (one analytics row per post, latest wins). */
export async function upsertPostMetrics(postId: number, metrics: PostMetrics): Promise<void> {
  const [existing] = await db
    .select({ id: analytics.id })
    .from(analytics)
    .where(eq(analytics.postId, postId))
    .limit(1);
  if (existing) {
    await db.update(analytics).set({ ...metrics, fetchedAt: new Date().toISOString() }).where(eq(analytics.id, existing.id));
  } else {
    await db.insert(analytics).values({ postId, ...metrics });
  }
}
