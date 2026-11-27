// Views leaderboard: creators ranked by total views on videos that were made
// in Vybe AND carry the burned-in watermark, posted through Vybe to a
// connected account. Monthly and yearly boards.
//
// What counts:
//   - a published post with a platform post id (so views come from the
//     platform API, never from user input),
//   - whose media is an export recorded in watermarked_exports for the same
//     user (see recordWatermarkedExport in plan.ts),
//   - bucketed by the month/year it was published (UTC).
// A video cross-posted to several platforms counts once per platform, since
// those are separate real views.
//
// Views are refreshed by refreshLeaderboardMetrics() from the crons for
// REFRESH_WINDOW_DAYS after posting, then freeze. That also settles each
// month's board a couple of weeks after it closes.
import { client } from "./db";
import { db } from "./db";
import { accounts, posts } from "./schema";
import { eq, inArray } from "drizzle-orm";
import { fetchPostMetrics, upsertPostMetrics } from "./post-metrics";

const REFRESH_WINDOW_DAYS = 45;
const REFRESH_MIN_HOURS = 6;

export type Period = { kind: "month" | "year"; key: string }; // key: "2026-11" | "2026"

export function parsePeriod(raw: string | null | undefined): Period {
  const now = new Date();
  if (raw && /^\d{4}$/.test(raw)) return { kind: "year", key: raw };
  if (raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return { kind: "month", key: raw };
  if (raw === "year") return { kind: "year", key: String(now.getUTCFullYear()) };
  return { kind: "month", key: now.toISOString().slice(0, 7) };
}

// Posts that qualify, as a SQL fragment. `?` = the period key; the substr
// length picks month (7) vs year (4).
function eligibleCte(kind: Period["kind"]): string {
  const len = kind === "year" ? 4 : 7;
  return `
    WITH eligible AS (
      SELECT p.id AS post_id, a.user_id AS user_id, p.platform AS platform,
             COALESCE((SELECT MAX(an.impressions) FROM analytics an WHERE an.post_id = p.id), 0) AS views
        FROM posts p
        JOIN accounts a ON a.id = p.account_id
       WHERE p.status = 'published'
         AND p.platform_post_id IS NOT NULL
         AND p.media_urls IS NOT NULL
         AND substr(COALESCE(p.published_at, p.scheduled_at), 1, ${len}) = ?
         AND EXISTS (
           SELECT 1 FROM watermarked_exports w
            WHERE w.user_id = a.user_id AND instr(p.media_urls, w.url) > 0
         )
    ),
    totals AS (
      SELECT user_id, SUM(views) AS views, COUNT(*) AS videos, MAX(views) AS best
        FROM eligible GROUP BY user_id HAVING SUM(views) > 0
    ),
    ranked AS (
      SELECT t.*, RANK() OVER (ORDER BY t.views DESC) AS rank FROM totals t
    )`;
}

export type LeaderboardEntry = {
  rank: number;
  name: string;
  initial: string;
  views: number;
  videos: number;
  bestVideoViews: number;
  plan: string;
  isMe: boolean;
};

export type Leaderboard = {
  period: Period;
  entries: LeaderboardEntry[];
  me: (LeaderboardEntry & { hidden: boolean }) | null;
  myHidden: boolean;
  participants: number;
  totalViews: number;
};

function displayName(name: unknown, hidden: unknown): string {
  if (Number(hidden) === 1) return "Anonymous creator";
  const n = typeof name === "string" ? name.trim() : "";
  return n ? n.slice(0, 40) : "Vybe creator";
}

type RankRow = { user_id: number; views: number; videos: number; best: number; rank: number; name: string | null; leaderboard_hidden: number | null; plan: string | null };

function toEntry(r: RankRow, meId: number): LeaderboardEntry {
  const name = displayName(r.name, r.leaderboard_hidden);
  return {
    rank: Number(r.rank),
    name,
    initial: name[0]?.toUpperCase() ?? "V",
    views: Number(r.views) || 0,
    videos: Number(r.videos) || 0,
    bestVideoViews: Number(r.best) || 0,
    plan: r.plan ?? "free",
    isMe: Number(r.user_id) === meId,
  };
}

export async function getLeaderboard(period: Period, meId: number, limit = 50): Promise<Leaderboard> {
  const cte = eligibleCte(period.kind);
  const [top, mine, agg, hidden] = await Promise.all([
    client.execute({
      sql: `${cte}
        SELECT r.*, u.name, u.leaderboard_hidden, u.plan FROM ranked r JOIN users u ON u.id = r.user_id
         ORDER BY r.rank ASC, r.videos DESC LIMIT ?`,
      args: [period.key, limit],
    }),
    client.execute({
      sql: `${cte}
        SELECT r.*, u.name, u.leaderboard_hidden, u.plan FROM ranked r JOIN users u ON u.id = r.user_id
         WHERE r.user_id = ?`,
      args: [period.key, meId],
    }),
    client.execute({
      sql: `${cte} SELECT COUNT(*) AS n, COALESCE(SUM(views), 0) AS v FROM totals`,
      args: [period.key],
    }),
    client.execute({ sql: "SELECT leaderboard_hidden FROM users WHERE id = ?", args: [meId] }),
  ]);

  const meRow = mine.rows[0] as unknown as RankRow | undefined;
  const a = agg.rows[0] as { n?: number; v?: number } | undefined;
  const myHidden = Number((hidden.rows[0] as { leaderboard_hidden?: number } | undefined)?.leaderboard_hidden ?? 0) === 1;
  return {
    period,
    entries: (top.rows as unknown as RankRow[]).map((r) => toEntry(r, meId)),
    me: meRow ? { ...toEntry(meRow, meId), hidden: myHidden } : null,
    myHidden,
    participants: Number(a?.n ?? 0),
    totalViews: Number(a?.v ?? 0),
  };
}

export async function setLeaderboardHidden(userId: number, hidden: boolean): Promise<void> {
  await client.execute({ sql: "UPDATE users SET leaderboard_hidden = ? WHERE id = ?", args: [hidden ? 1 : 0, userId] });
}

// The signed-in user's own eligible videos for a period (their "how am I
// doing" list), plus how many recent posts were NOT eligible, so the page can
// explain why.
export async function getMyLeaderboardVideos(userId: number, period: Period) {
  const len = period.kind === "year" ? 4 : 7;
  const res = await client.execute({
    sql: `SELECT p.id, p.platform, p.content, COALESCE(p.published_at, p.scheduled_at) AS at,
                 COALESCE((SELECT MAX(an.impressions) FROM analytics an WHERE an.post_id = p.id), 0) AS views,
                 (SELECT MAX(an.fetched_at) FROM analytics an WHERE an.post_id = p.id) AS fetched_at,
                 EXISTS (SELECT 1 FROM watermarked_exports w WHERE w.user_id = a.user_id AND instr(p.media_urls, w.url) > 0) AS eligible
            FROM posts p JOIN accounts a ON a.id = p.account_id
           WHERE a.user_id = ? AND p.status = 'published' AND p.platform_post_id IS NOT NULL
             AND p.media_urls IS NOT NULL
             AND substr(COALESCE(p.published_at, p.scheduled_at), 1, ${len}) = ?
           ORDER BY views DESC LIMIT 100`,
    args: [userId, period.key],
  });
  return (res.rows as unknown as { id: number; platform: string; content: string; at: string; views: number; fetched_at: string | null; eligible: number }[])
    .map((r) => ({
      id: Number(r.id),
      platform: String(r.platform),
      title: String(r.content ?? "").split("\n")[0].slice(0, 90),
      publishedAt: String(r.at ?? ""),
      views: Number(r.views) || 0,
      refreshedAt: r.fetched_at ?? null,
      eligible: Number(r.eligible) === 1,
    }));
}

/**
 * Pull fresh view counts for leaderboard-eligible posts published in the last
 * REFRESH_WINDOW_DAYS, at most every REFRESH_MIN_HOURS each, stalest first.
 * Called from the crons; never throws.
 */
export async function refreshLeaderboardMetrics(limit = 40): Promise<{ refreshed: number; errors: number }> {
  let refreshed = 0, errors = 0;
  try {
    const since = new Date(Date.now() - REFRESH_WINDOW_DAYS * 86_400_000).toISOString();
    const staleBefore = new Date(Date.now() - REFRESH_MIN_HOURS * 3_600_000).toISOString();
    const res = await client.execute({
      sql: `SELECT p.id FROM posts p JOIN accounts a ON a.id = p.account_id
             WHERE p.status = 'published' AND p.platform_post_id IS NOT NULL AND p.media_urls IS NOT NULL
               AND COALESCE(p.published_at, p.scheduled_at) >= ?
               AND EXISTS (SELECT 1 FROM watermarked_exports w WHERE w.user_id = a.user_id AND instr(p.media_urls, w.url) > 0)
               AND COALESCE((SELECT MAX(an.fetched_at) FROM analytics an WHERE an.post_id = p.id), '') < ?
             ORDER BY COALESCE((SELECT MAX(an.fetched_at) FROM analytics an WHERE an.post_id = p.id), '') ASC
             LIMIT ?`,
      args: [since, staleBefore, limit],
    });
    const ids = (res.rows as unknown as { id: number }[]).map((r) => Number(r.id));
    if (ids.length === 0) return { refreshed, errors };

    const rows = await db
      .select({ post: posts, account: accounts })
      .from(posts)
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
        console.error(`[leaderboard] post ${post.id} (${account.platform}):`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[leaderboard] refresh failed:", err instanceof Error ? err.message : err);
  }
  return { refreshed, errors };
}
