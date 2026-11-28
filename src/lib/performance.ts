// "Did this video hit expectations?" — pure scoring shared by the analytics UI
// and the goals API.
//
// Three ways a video gets judged, most specific first:
//  • Campaign goals — targets set on the video's campaign (may include a
//    revenue target, in the campaign's currency). Replace platform goals.
//  • Platform goals — targets for any of views / likes / comments / shares /
//    engagement rate / comment-to-like ratio. A video "hits" when every goal
//    set is met.
//  • Baseline (no goals set) — views vs the median views of the user's other
//    settled videos on that platform. Fairer than a fixed number (10K views is
//    great for a new account, poor for a big one) and needs no setup.
//
// Fresh videos are still accumulating, so anything under EARLY_HOURS old that
// hasn't met its bar yet gets a provisional "early" verdict.

export type Verdict = "outperformer" | "on_target" | "below" | "under" | "early" | "no_baseline";

export const VERDICTS: Record<Verdict, { label: string; tone: string; dot: string; hint: string }> = {
  outperformer: { label: "Outperformer",    tone: "text-emerald-300 bg-emerald-500/12 border-emerald-500/25", dot: "bg-emerald-400", hint: "Met every goal, averaging 2× or more" },
  on_target:    { label: "Hit target",      tone: "text-sky-300 bg-sky-500/12 border-sky-500/25",             dot: "bg-sky-400",     hint: "Met every goal" },
  below:        { label: "Below target",    tone: "text-amber-300 bg-amber-500/12 border-amber-500/25",       dot: "bg-amber-400",   hint: "Missed at least one goal, but got close" },
  under:        { label: "Underperformed",  tone: "text-rose-300 bg-rose-500/12 border-rose-500/25",          dot: "bg-rose-400",    hint: "Averaged under 40% of the goals" },
  early:        { label: "Still growing",   tone: "text-violet-300 bg-violet-500/12 border-violet-500/25",    dot: "bg-violet-400",  hint: "Published less than 48h ago — verdict is provisional" },
  no_baseline:  { label: "Not enough data", tone: "text-white/40 bg-white/[0.04] border-white/[0.08]",        dot: "bg-white/30",    hint: "Need 3+ videos on this platform, or set a goal" },
};

export const EARLY_HOURS = 48;
export const MIN_BASELINE_VIDEOS = 3;
/** One metric can't make up for another beyond this multiple. */
const RATIO_CAP = 2.5;

// `campaignOnly` metrics need a campaign (revenue is in its currency).
export const GOAL_METRICS = [
  { key: "views",          label: "Views",        unit: "",  campaignOnly: false, hint: "Views per video" },
  { key: "likes",          label: "Likes",        unit: "",  campaignOnly: false, hint: "Likes per video" },
  { key: "comments",       label: "Comments",     unit: "",  campaignOnly: false, hint: "Comments per video" },
  { key: "shares",         label: "Shares",       unit: "",  campaignOnly: false, hint: "Shares per video" },
  { key: "engagementRate", label: "Eng. rate",    unit: "%", campaignOnly: false, hint: "(likes + comments + shares) ÷ views" },
  { key: "discussion",     label: "Comment/like", unit: "%", campaignOnly: false, hint: "Comments ÷ likes — are people actually talking about it?" },
  { key: "revenue",        label: "Revenue",      unit: "$", campaignOnly: true,  hint: "Estimated earnings per video, in the campaign's currency" },
] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number]["key"];
const PERCENT_METRICS = new Set<GoalMetric>(["engagementRate", "discussion"]);
export const isPercentMetric = (m: GoalMetric) => PERCENT_METRICS.has(m);
export type PlatformGoals = Partial<Record<GoalMetric, number>>;
export type Goals = Record<string, PlatformGoals>;

export const GOAL_PLATFORMS = ["youtube", "instagram", "twitter", "tiktok"] as const;

export type PerfInput = {
  id: number;            // analytics row id
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** Estimated campaign earnings for this video (0 without a campaign). */
  revenue?: number;
  /** Goals set on the video's campaign; when non-empty they replace platform goals. */
  campaignGoals?: PlatformGoals | null;
  publishedAt: string | null;
};

export type MetricCheck = { metric: GoalMetric; actual: number; target: number; ratio: number; met: boolean };

export type PerfResult = {
  verdict: Verdict;
  /** Per-metric comparison (one "views" entry in baseline mode). */
  checks: MetricCheck[];
  /** Average of the capped per-metric ratios, or null with nothing to compare. */
  ratio: number | null;
  source: "campaign" | "goal" | "baseline" | null;
  /** Engagement rate vs the platform's median rate (informational). */
  engagementVsMedian: number | null;
};

const engagementOf = (v: PerfInput) => v.likes + v.comments + v.shares;

/** Value of a metric for a video. Engagement rate is a percentage. */
export function metricValue(v: PerfInput, m: GoalMetric): number {
  if (m === "engagementRate") return v.views > 0 ? (engagementOf(v) / v.views) * 100 : 0;
  if (m === "discussion") return v.likes > 0 ? (v.comments / v.likes) * 100 : 0;
  if (m === "revenue") return v.revenue ?? 0;
  return v[m] ?? 0;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Normalise stored goals. Accepts the older shape `{ youtube: 10000 }` (a bare
 * view target) as well as `{ youtube: { views: 10000, likes: 500 } }`; drops
 * anything that isn't a positive number.
 */
export function normalizeGoals(raw: unknown): Goals {
  const out: Goals = {};
  if (!raw || typeof raw !== "object") return out;
  for (const p of GOAL_PLATFORMS) {
    const v = (raw as Record<string, unknown>)[p];
    const goals = normalizeMetricGoals(typeof v === "number" ? { views: v } : v, false);
    if (Object.keys(goals).length) out[p] = goals;
  }
  return out;
}

/** Clean one set of metric targets. `allowCampaignOnly` admits revenue. */
export function normalizeMetricGoals(raw: unknown, allowCampaignOnly: boolean): PlatformGoals {
  const goals: PlatformGoals = {};
  if (!raw || typeof raw !== "object") return goals;
  const src = raw as Record<string, unknown>;
  for (const { key, campaignOnly } of GOAL_METRICS) {
    if (campaignOnly && !allowCampaignOnly) continue;
    const n = Number(src[key]);
    if (!Number.isFinite(n) || n <= 0) continue;
    goals[key] = isPercentMetric(key) ? Math.min(Math.round(n * 100) / 100, 1000)
      : key === "revenue" ? Math.min(Math.round(n * 100) / 100, 10_000_000)
      : Math.min(Math.round(n), 1_000_000_000);
  }
  return goals;
}

/** Parse a campaign's stored goals JSON. */
export function parseCampaignGoals(raw: string | null | undefined): PlatformGoals {
  if (!raw) return {};
  try { return normalizeMetricGoals(JSON.parse(raw), true); } catch { return {}; }
}

/**
 * Score every video. Baselines only count "settled" videos (older than
 * EARLY_HOURS) so a batch of fresh uploads doesn't drag the median down.
 */
export function scoreVideos(videos: PerfInput[], goals: Goals = {}, now = Date.now()): Map<number, PerfResult> {
  const ageHours = (v: PerfInput) => (v.publishedAt ? (now - new Date(v.publishedAt).getTime()) / 3_600_000 : Infinity);

  const byPlatform = new Map<string, PerfInput[]>();
  for (const v of videos) {
    const list = byPlatform.get(v.platform) ?? [];
    list.push(v);
    byPlatform.set(v.platform, list);
  }

  const out = new Map<number, PerfResult>();
  for (const [platform, list] of byPlatform) {
    const settled = list.filter((v) => ageHours(v) >= EARLY_HOURS && v.views > 0);
    const rates = list.filter((v) => v.views > 0).map((v) => metricValue(v, "engagementRate"));
    const medianRate = rates.length >= MIN_BASELINE_VIDEOS ? median(rates) : 0;
    const platformGoals = Object.entries(goals[platform] ?? {}).filter(([, t]) => (t ?? 0) > 0) as [GoalMetric, number][];

    for (const v of list) {
      let targets: [GoalMetric, number][];
      let source: PerfResult["source"];
      const campaignGoals = Object.entries(v.campaignGoals ?? {}).filter(([, t]) => (t ?? 0) > 0) as [GoalMetric, number][];
      if (campaignGoals.length) {
        targets = campaignGoals;
        source = "campaign";
      } else if (platformGoals.length) {
        targets = platformGoals;
        source = "goal";
      } else {
        // Leave the video itself out of its own baseline.
        const peers = settled.filter((p) => p.id !== v.id).map((p) => p.views);
        const baseline = peers.length >= MIN_BASELINE_VIDEOS ? median(peers) : 0;
        targets = baseline > 0 ? [["views", baseline]] : [];
        source = baseline > 0 ? "baseline" : null;
      }

      const checks: MetricCheck[] = targets.map(([metric, target]) => {
        const actual = metricValue(v, metric);
        return { metric, actual, target, ratio: actual / target, met: actual >= target };
      });
      const ratio = checks.length ? checks.reduce((s, c) => s + Math.min(c.ratio, RATIO_CAP), 0) / checks.length : null;
      const allMet = checks.length > 0 && checks.every((c) => c.met);

      let verdict: Verdict;
      if (ratio == null) verdict = "no_baseline";
      // A young video that already met its bar has earned its verdict.
      else if (!allMet && ageHours(v) < EARLY_HOURS) verdict = "early";
      else if (allMet) verdict = ratio >= 2 ? "outperformer" : "on_target";
      else verdict = ratio >= 0.4 ? "below" : "under";

      const engagementVsMedian = medianRate > 0 && v.views > 0 ? metricValue(v, "engagementRate") / medianRate : null;
      out.set(v.id, { verdict, checks, ratio, source, engagementVsMedian });
    }
  }
  return out;
}

/** Median of each metric over settled videos, per platform (0 when there aren't enough). */
export function platformBaselines(videos: PerfInput[], now = Date.now()): Record<string, Record<GoalMetric, number>> {
  const groups: Record<string, PerfInput[]> = {};
  for (const v of videos) {
    const age = v.publishedAt ? (now - new Date(v.publishedAt).getTime()) / 3_600_000 : Infinity;
    if (age < EARLY_HOURS || !(v.views > 0)) continue;
    (groups[v.platform] ??= []).push(v);
  }
  return Object.fromEntries(Object.entries(groups).map(([p, list]) => [
    p,
    Object.fromEntries(GOAL_METRICS.map(({ key }) => [key, list.length >= MIN_BASELINE_VIDEOS ? median(list.map((v) => metricValue(v, key))) : 0])) as Record<GoalMetric, number>,
  ]));
}
