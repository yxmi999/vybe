// Shared per-post metrics fetching — used by the manual analytics refresh
// (/api/analytics POST) and the automatic Auto-Pilot outcome tracker.
import { db, client } from "./db";
import { accounts, analytics, posts } from "./schema";
import { eq, inArray } from "drizzle-orm";
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

// ─── Background refresh (cron) ───────────────────────────────────────────────
// Keeps every user's analytics — and so the Goal check verdicts — current
// without anyone pressing "Refresh Metrics". Recent posts move fastest, so they
// refresh more often; older ones settle and are re-read rarely.

const REFRESH_WINDOW_DAYS = 30;

/**
 * Refresh up to `limit` posts whose metrics are stale, stalest first.
 * Posts under 3 days old are stale after 2h; older ones after 12h.
 */
export async function refreshStaleAnalytics(limit = 20): Promise<{ refreshed: number; errors: number }> {
  let refreshed = 0, errors = 0;

  const since = new Date(Date.now() - REFRESH_WINDOW_DAYS * 86_400_000).toISOString();
  // julianday() reads both stored formats ("YYYY-MM-DD HH:MM:SS" and ISO).
  const res = await client.execute({
    sql: `SELECT p.id FROM posts p
            JOIN accounts a ON a.id = p.account_id AND a.is_active = 1
           WHERE p.status = 'published' AND p.platform_post_id IS NOT NULL
             AND p.published_at >= ?
             AND (julianday('now') - COALESCE(julianday((SELECT MAX(an.fetched_at) FROM analytics an WHERE an.post_id = p.id)), 0)) * 24
                 >= CASE WHEN julianday('now') - julianday(p.published_at) < 3 THEN 2 ELSE 12 END
           ORDER BY COALESCE(julianday((SELECT MAX(an.fetched_at) FROM analytics an WHERE an.post_id = p.id)), 0) ASC
           LIMIT ?`,
    args: [since, limit],
  });
  const ids = (res.rows as unknown as { id: number }[]).map((r) => Number(r.id));
  if (ids.length === 0) return { refreshed, errors };

  const rows = await db.select({ post: posts, account: accounts }).from(posts)
    .innerJoin(accounts, eq(posts.accountId, accounts.id))
    .where(inArray(posts.id, ids));

  for (const { post, account } of rows) {
    try {
      const metrics = await fetchPostMetrics(account, post.platformPostId!);
      if (!metrics) continue;
      await upsertPostMetrics(post.id, metrics);
      refreshed++;
    } catch (err) {
      errors++;
      console.error(`[analytics cron] post ${post.id} (${account.platform}):`, err instanceof Error ? err.message : err);
    }
  }
  return { refreshed, errors };
}
