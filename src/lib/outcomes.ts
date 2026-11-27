// Outcome tracking — closes the loop between the detection signals that chose
// a clip (confidence / lift / AI virality / hook strength) and how the clip
// actually performed once posted. Data accumulates automatically (the cron
// refreshes metrics for recent Auto-Pilot posts) and feeds the calibration
// panel on /auto-pilot, so thresholds like MIN_AUTOPOST_AI_SCORE can be tuned
// against reality instead of guesses.
import { db } from "./db";
import { posts, accounts, analytics } from "./schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { fetchPostMetrics, upsertPostMetrics } from "./post-metrics";

// Only chase metrics for posts young enough to still be moving.
const TRACK_WINDOW_DAYS = 30;
// Don't re-fetch a post's metrics more often than this.
const REFRESH_MIN_HOURS = 6;

type AutoPilotMeta = {
  source?: string;
  confidence?: number;
  lift?: number | null;
  viralityScore?: number | null;
  hookStrength?: number | null;
  hookTrimSec?: number | null;
  clipRequested?: boolean;
  videoTitle?: string;
};

function parseMeta(raw: string | null): AutoPilotMeta {
  if (!raw) return {};
  try { return JSON.parse(raw) as AutoPilotMeta; } catch { return {}; }
}

/**
 * Refresh live metrics for recently published Auto-Pilot posts, throttled so
 * each post is fetched at most every REFRESH_MIN_HOURS. Called from the
 * auto-pilot cron; never throws.
 */
export async function refreshAutoPilotOutcomes(limit = 20): Promise<{ refreshed: number; errors: number }> {
  let refreshed = 0, errors = 0;
  try {
    const cutoff = new Date(Date.now() - TRACK_WINDOW_DAYS * 86_400_000).toISOString();
    const rows = await db
      .select({ post: posts, account: accounts })
      .from(posts)
      .innerJoin(accounts, eq(posts.accountId, accounts.id))
      .where(eq(posts.status, "published"))
      .orderBy(desc(posts.createdAt))
      .limit(200);

    const candidates = rows.filter(({ post }) =>
      post.platformPostId &&
      (post.createdAt ?? "") >= cutoff &&
      parseMeta(post.metadata).source === "autopilot",
    );
    if (candidates.length === 0) return { refreshed, errors };

    // One query for the freshness throttle instead of one per post.
    const staleBefore = new Date(Date.now() - REFRESH_MIN_HOURS * 3_600_000).toISOString();
    const existing = await db
      .select({ postId: analytics.postId, fetchedAt: analytics.fetchedAt })
      .from(analytics)
      .where(inArray(analytics.postId, candidates.map(({ post }) => post.id)));
    const lastFetch = new Map(existing.map((r) => [r.postId, r.fetchedAt ?? ""]));

    for (const { post, account } of candidates) {
      if (refreshed + errors >= limit) break;
      if ((lastFetch.get(post.id) ?? "") >= staleBefore) continue; // fresh enough
      try {
        const metrics = await fetchPostMetrics(account, post.platformPostId!);
        if (!metrics) continue;
        await upsertPostMetrics(post.id, metrics);
        refreshed++;
      } catch (err) {
        errors++;
        console.error(`[outcomes] post ${post.id} (${account.platform}):`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[outcomes] refresh failed:", err instanceof Error ? err.message : err);
  }
  return { refreshed, errors };
}

// ─── Calibration read model ──────────────────────────────────────────────────

export type OutcomeRow = {
  postId: number;
  title: string;
  publishedAt: string | null;
  platform: string;
  confidence: number | null;
  lift: number | null;
  viralityScore: number | null;
  hookStrength: number | null;
  clipRequested: boolean;
  views: number;
  likes: number;
  comments: number;
  shares: number;
};

export type BucketStat = { label: string; n: number; avgViews: number; medViews: number };

export type OutcomeSummary = {
  n: number;
  byAiScore: BucketStat[];
  // Pearson r of each signal vs log(1+views); null until n >= 5 samples carry the signal.
  correlations: { signal: string; r: number | null; n: number }[];
};

function bucket(rows: OutcomeRow[], label: string, pred: (r: OutcomeRow) => boolean): BucketStat {
  const xs = rows.filter(pred).map((r) => r.views).sort((a, b) => a - b);
  const avg = xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
  const med = xs.length ? xs[xs.length >> 1] : 0;
  return { label, n: xs.length, avgViews: Math.round(avg), medViews: med };
}

function pearson(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 5) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100;
}

/** Published Auto-Pilot clips for this user, each with its signals and outcomes. */
export async function getSignalOutcomes(userId: number): Promise<{ rows: OutcomeRow[]; summary: OutcomeSummary }> {
  const joined = await db
    .select({ post: posts, account: accounts, stats: analytics })
    .from(posts)
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, userId)))
    .innerJoin(analytics, eq(analytics.postId, posts.id))
    .where(eq(posts.status, "published"))
    .orderBy(desc(posts.createdAt))
    .limit(500);

  const rows: OutcomeRow[] = [];
  for (const { post, account, stats } of joined) {
    const meta = parseMeta(post.metadata);
    if (meta.source !== "autopilot") continue;
    rows.push({
      postId: post.id,
      title: meta.videoTitle ?? post.content ?? "",
      publishedAt: post.createdAt ?? null,
      platform: account.platform,
      confidence: typeof meta.confidence === "number" ? meta.confidence : null,
      lift: typeof meta.lift === "number" ? meta.lift : null,
      viralityScore: typeof meta.viralityScore === "number" ? meta.viralityScore : null,
      hookStrength: typeof meta.hookStrength === "number" ? meta.hookStrength : null,
      clipRequested: meta.clipRequested === true,
      views: Math.max(stats.impressions ?? 0, stats.reach ?? 0),
      likes: stats.likes ?? 0,
      comments: stats.comments ?? 0,
      shares: stats.shares ?? 0,
    });
  }

  const logViews = (r: OutcomeRow) => Math.log1p(r.views);
  const summary: OutcomeSummary = {
    n: rows.length,
    byAiScore: [
      bucket(rows, "AI ≥ 70", (r) => (r.viralityScore ?? -1) >= 70),
      bucket(rows, "AI 55–69", (r) => (r.viralityScore ?? -1) >= 55 && (r.viralityScore ?? 101) < 70),
      bucket(rows, "AI < 55", (r) => r.viralityScore != null && r.viralityScore < 55),
      bucket(rows, "Unscored", (r) => r.viralityScore == null),
    ],
    correlations: (
      [
        ["AI score", (r: OutcomeRow) => r.viralityScore],
        ["Hook strength", (r: OutcomeRow) => r.hookStrength],
        ["Chat confidence", (r: OutcomeRow) => r.confidence],
        ["Chat lift", (r: OutcomeRow) => r.lift],
      ] as const
    ).map(([signal, get]) => {
      const pairs = rows.flatMap((r): [number, number][] => (get(r) == null ? [] : [[get(r)!, logViews(r)]]));
      return { signal, r: pearson(pairs), n: pairs.length };
    }),
  };

  return { rows, summary };
}
