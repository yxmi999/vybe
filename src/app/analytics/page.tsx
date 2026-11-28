"use client";
import { useEffect, useState } from "react";
import { platformIcon } from "@/lib/utils";
import { RefreshCw, Heart, MessageCircle, Share2, Eye, TrendingUp, BarChart2, ExternalLink, Activity, Trophy, DollarSign, ChevronDown } from "lucide-react";
import { CampaignManager, CampaignSelect, type Campaign } from "./Campaigns";
import { effectiveCampaign, videoRevenue, formatMoney, viewsToQualify } from "@/lib/campaigns";
import { scoreVideos, platformBaselines, parseCampaignGoals, type Verdict, type PerfInput, type Goals } from "@/lib/performance";
import { GoalCheckPanel, VerdictBadge } from "./GoalCheck";
import { safeFetch } from "@/lib/utils";
import PageHeader from "@/components/PageHeader";
import Pagination, { usePagination } from "@/components/Pagination";
import { format, formatDistanceToNow } from "date-fns";

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

type AnalyticsRow = {
  analytics: { id: number; likes: number; comments: number; shares: number; reach: number; impressions: number; fetchedAt: string };
  post: { id: number; content: string; platform: string; publishedAt: string | null; platformPostId: string | null; campaignId: number | null } | null;
  account: { username: string } | null;
};

const FILTERS = [
  { key: "all",       label: "All" },
  { key: "youtube",   label: "YouTube",   icon: "▶" },
  { key: "instagram", label: "Instagram", icon: "📸" },
  { key: "twitter",   label: "X / Twitter", icon: "𝕏" },
  { key: "tiktok",    label: "TikTok",    icon: "♪" },
];

function platformPostUrl(platform: string, platformPostId: string | null, username: string | null): string | null {
  if (!platformPostId) return null;
  switch (platform) {
    case "youtube":   return `https://youtube.com/watch?v=${platformPostId}`;
    case "twitter":   return `https://x.com/${username ?? "i"}/status/${platformPostId}`;
    // Graph API media IDs aren't /p/ shortcodes, so link the profile instead.
    case "instagram": return username ? `https://instagram.com/${username}/` : null;
    case "tiktok":    return `https://tiktok.com/@${username ?? ""}/video/${platformPostId}`;
    default:          return null;
  }
}

export default function AnalyticsPage() {
  const [rows, setRows] = useState<AnalyticsRow[]>([]);
  const [refreshing, setRefreshing] = useState(true); // the background refresh on entry starts immediately
  const [active, setActive] = useState("all");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [showCampaigns, setShowCampaigns] = useState(false);
  const [goals, setGoals] = useState<Goals>({});
  const [verdictFilter, setVerdictFilter] = useState<Verdict | null>(null);

  async function load() {
    const data = await safeFetch("/api/analytics", undefined, []);
    setRows(data);
  }
  async function loadCampaigns() {
    setCampaigns(await safeFetch("/api/campaigns", undefined, []));
  }

  useEffect(() => {
    let cancelled = false;
    // Show saved metrics right away, then pull fresh numbers from the platforms
    // in the background (skipping posts read in the last 5 min) and re-render.
    safeFetch("/api/analytics", undefined, []).then((d) => { if (!cancelled) setRows(d); });
    safeFetch("/api/campaigns", undefined, []).then((d) => { if (!cancelled) setCampaigns(d); });
    safeFetch("/api/analytics/goals", undefined, {}).then((d) => { if (!cancelled) setGoals(d); });

    fetch("/api/analytics?maxAgeMinutes=5", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (res) => {
        if (cancelled || !res?.refreshed) return;
        const fresh = await safeFetch("/api/analytics", undefined, null);
        if (!cancelled && fresh) setRows(fresh);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRefreshing(false); });

    return () => { cancelled = true; };
  }, []);

  // Optimistic local update after a video is moved to another campaign.
  function onAssigned(postId: number, campaignId: number | null) {
    setRows((prev) => prev.map((r) => (r.post?.id === postId ? { ...r, post: { ...r.post, campaignId } } : r)));
  }

  async function refresh() {
    setRefreshing(true);
    await fetch("/api/analytics", { method: "POST" });
    await load();
    setRefreshing(false);
  }

  const filtered = active === "all" ? rows : rows.filter((r) => r.post?.platform === active);
  const sum = (key: keyof AnalyticsRow["analytics"]) =>
    filtered.reduce((s, r) => s + ((r.analytics[key] as number) ?? 0), 0);

  const activePlatforms = new Set(rows.map((r) => r.post?.platform).filter(Boolean));

  const engagementOf = (a: AnalyticsRow["analytics"]) => (a.likes ?? 0) + (a.comments ?? 0) + (a.shares ?? 0);
  const maxEng = Math.max(1, ...filtered.map((r) => engagementOf(r.analytics)));
  const topRow = [...filtered].sort((a, b) => engagementOf(b.analytics) - engagementOf(a.analytics))[0];
  const totalEng = sum("likes") + sum("comments") + sum("shares");
  const totalReach = sum("reach");
  const engRate = totalReach > 0 ? (totalEng / totalReach) * 100 : 0;
  const lastFetched = rows.map((r) => r.analytics.fetchedAt).filter(Boolean).sort().at(-1);

  // Revenue: views x campaign CPM (videos without a campaign use the default).
  // Views = impressions (YouTube/TikTok view count, X impressions), else reach.
  const viewsOf = (a: AnalyticsRow["analytics"]) => a.impressions || a.reach || 0;
  const campaignOf = (r: AnalyticsRow) => effectiveCampaign(r.post?.campaignId, campaigns);
  const revenueOf = (r: AnalyticsRow) => videoRevenue(viewsOf(r.analytics), campaignOf(r));
  // Totals are kept per currency: campaigns can pay in different currencies.
  const revenueTotals = new Map<string, number>();
  for (const r of filtered) {
    const c = campaignOf(r);
    if (c) revenueTotals.set(c.currency, (revenueTotals.get(c.currency) ?? 0) + revenueOf(r));
  }
  // Per-campaign figures for the manager (all platforms, not just the filter).
  const revenueByCampaign = new Map<number, number>();
  const videosByCampaign = new Map<number, number>();
  for (const r of rows) {
    const c = campaignOf(r);
    if (!c) continue;
    revenueByCampaign.set(c.id, (revenueByCampaign.get(c.id) ?? 0) + revenueOf(r));
    videosByCampaign.set(c.id, (videosByCampaign.get(c.id) ?? 0) + 1);
  }
  const revenueLabel = revenueTotals.size === 0
    ? formatMoney(0)
    : [...revenueTotals].map(([cur, v]) => formatMoney(v, cur)).join(" + ");
  const paidViews = filtered.reduce((s, r) => s + (campaignOf(r) ? viewsOf(r.analytics) : 0), 0);

  // Goal check: every video vs. the user's goal or their median on that
  // platform. Scored over all rows so the baseline doesn't shift with filters.
  const perfInputs: PerfInput[] = rows.filter((r) => r.post).map((r) => ({
    id: r.analytics.id,
    platform: r.post!.platform,
    views: viewsOf(r.analytics),
    likes: r.analytics.likes ?? 0,
    comments: r.analytics.comments ?? 0,
    shares: r.analytics.shares ?? 0,
    revenue: revenueOf(r),
    campaignGoals: parseCampaignGoals(campaignOf(r)?.goals),
    publishedAt: r.post!.publishedAt,
  }));
  const scores = scoreVideos(perfInputs, goals);
  const baselines = platformBaselines(perfInputs);
  const filteredScores = filtered.map((r) => scores.get(r.analytics.id)).filter((x) => x != null);
  const tableRows = verdictFilter ? filtered.filter((r) => scores.get(r.analytics.id)?.verdict === verdictFilter) : filtered;
  const { pageItems, ...pager } = usePagination(tableRows, 20);
  const toQualifyOf = (r: AnalyticsRow) => {
    const need = viewsToQualify(campaignOf(r));
    return need != null ? need - viewsOf(r.analytics) : null;
  };

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-8">

        {/* Header */}
        <PageHeader
          eyebrow="Analytics"
          title="Performance"
          description={rows.length === 0
            ? "Track post performance across all platforms."
            : <>{fmt(totalEng)} engagements across {rows.length} post{rows.length !== 1 ? "s" : ""}{lastFetched ? <> · updated {formatDistanceToNow(new Date(lastFetched), { addSuffix: true })}</> : null}</>}
          actions={
            <button
              onClick={refresh}
              disabled={refreshing}
              className="flex items-center gap-2 px-4 py-2 bg-white/[0.06] hover:bg-white/[0.09] border border-white/[0.08] text-white/70 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 self-start"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Fetching…" : "Refresh Metrics"}
            </button>
          }
        />

        {/* Platform filter */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {FILTERS.filter((f) => f.key === "all" || activePlatforms.has(f.key)).map((f) => {
            const count = f.key === "all" ? rows.length : rows.filter((r) => r.post?.platform === f.key).length;
            return (
              <button
                key={f.key}
                onClick={() => setActive(f.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  active === f.key
                    ? "bg-white/[0.08] text-white/85"
                    : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"
                }`}
              >
                {f.icon && <span className="text-sm">{f.icon}</span>}
                {f.label}
                <span className={`text-[10px] tabular-nums rounded-full px-1.5 py-px ${active === f.key ? "bg-violet-500/25 text-violet-200" : "bg-white/[0.06] text-white/30"}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          {[
            { label: "Likes",       value: fmt(sum("likes")),       icon: Heart,         color: "text-rose-300",    glow: "bg-rose-500/20" },
            { label: "Comments",    value: fmt(sum("comments")),    icon: MessageCircle, color: "text-sky-300",     glow: "bg-sky-500/20" },
            { label: "Shares",      value: fmt(sum("shares")),      icon: Share2,        color: "text-emerald-300", glow: "bg-emerald-500/20" },
            { label: "Reach",       value: fmt(sum("reach")),       icon: Eye,           color: "text-violet-300",  glow: "bg-violet-500/20" },
            { label: "Impressions", value: fmt(sum("impressions")), icon: BarChart2,     color: "text-amber-300",   glow: "bg-amber-500/20" },
            { label: "Eng. rate",   value: `${engRate.toFixed(1)}%`,icon: Activity,      color: "text-fuchsia-300", glow: "bg-fuchsia-500/20" },
          ].map(({ label, value, icon: Icon, color, glow }) => (
            <div
              key={label}
              className="relative overflow-hidden bg-gradient-to-br from-d16 to-d0e border border-white/[0.06] rounded-2xl p-4 hover:border-white/[0.12] transition-colors"
            >
              <div className={`absolute -right-5 -top-5 w-16 h-16 rounded-full blur-2xl ${glow} pointer-events-none`} />
              <div className="relative">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] uppercase tracking-wider text-white/35 font-semibold">{label}</span>
                  <Icon size={14} className={color} />
                </div>
                <div className="text-2xl font-bold text-white/95 leading-none tabular-nums">{value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Revenue + campaigns */}
        <div className="relative overflow-hidden bg-gradient-to-br from-emerald-600/[0.10] via-d12 to-d0e border border-emerald-500/20 rounded-2xl mb-4">
          <div className="flex flex-wrap items-center gap-4 p-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/25 flex-shrink-0">
              <DollarSign size={18} className="text-emerald-300" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-emerald-300/70 font-semibold mb-0.5">Estimated revenue</p>
              <p className="text-2xl font-bold text-white/95 tabular-nums leading-tight">{revenueLabel}</p>
              <p className="text-[11px] text-white/35 mt-0.5">
                {campaigns.length === 0
                  ? "Add a campaign with its CPM to estimate what your videos earn."
                  : `From ${fmt(paidViews)} views across ${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <button type="button" onClick={() => setShowCampaigns((v) => !v)} aria-expanded={showCampaigns}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-white/75">
              {campaigns.length === 0 ? "Add campaign" : "Manage campaigns"}
              <ChevronDown size={13} className={`transition-transform ${showCampaigns ? "rotate-180" : ""}`} />
            </button>
          </div>
          {showCampaigns && (
            <div className="border-t border-white/[0.06] p-4 bg-black/20">
              <CampaignManager campaigns={campaigns} onChange={loadCampaigns}
                revenueByCampaign={revenueByCampaign} videosByCampaign={videosByCampaign} />
            </div>
          )}
        </div>

        {/* Did each video hit expectations? */}
        {rows.length > 0 && (
          <GoalCheckPanel
            results={filteredScores}
            platforms={[...activePlatforms] as string[]}
            baselines={baselines}
            goals={goals}
            onGoalsSaved={setGoals}
            filter={verdictFilter}
            onFilter={setVerdictFilter}
          />
        )}

        {/* Top post highlight */}
        {topRow && engagementOf(topRow.analytics) > 0 && (
          <div className="relative overflow-hidden bg-gradient-to-r from-violet-600/[0.12] to-fuchsia-600/[0.06] border border-violet-500/20 rounded-2xl p-4 mb-4 flex items-center gap-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-violet-500/20 border border-violet-500/30 flex-shrink-0">
              <Trophy size={18} className="text-amber-300" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider text-violet-300/70 font-semibold mb-0.5">Top performer</p>
              <p className="text-sm text-white/80 truncate">
                {platformIcon(topRow.post?.platform ?? "")} {(topRow.post?.content?.split("\n")[0] || "Untitled post").slice(0, 70)}
              </p>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-xl font-bold text-white/95 tabular-nums">{fmt(engagementOf(topRow.analytics))}</div>
              <div className="text-[10px] text-white/35 uppercase tracking-wider">engagements</div>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/[0.05] flex items-center justify-between">
            <span className="text-sm font-semibold text-white/70">Post Performance</span>
            <span className="text-xs text-white/25">{tableRows.length} post{tableRows.length !== 1 ? "s" : ""}</span>
          </div>

          {tableRows.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4">
                <TrendingUp size={28} className="text-white/15" />
              </div>
              <p className="text-white/30 text-sm">
                {rows.length === 0
                  ? "No analytics yet — posts must be published first."
                  : filtered.length > 0 ? "No videos match this result filter." : "No posts for this platform."}
              </p>
            </div>
          ) : (
            <>
            {/* Phone layout: one card per post — an 8-column table can't work at 390px */}
            <div className="sm:hidden divide-y divide-white/[0.04]">
              {pageItems.map(({ analytics: a, post, account }) => {
                const postUrl = platformPostUrl(post?.platform ?? "", post?.platformPostId ?? null, account?.username ?? null);
                const content = post?.content ?? "";
                const firstLine = content.split("\n")[0] || content;
                const title = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
                const eng = engagementOf(a);
                const metrics: { label: string; value: number; cls: string }[] = [
                  { label: "Likes", value: a.likes ?? 0, cls: "text-red-400/80" },
                  { label: "Comments", value: a.comments ?? 0, cls: "text-blue-400/80" },
                  { label: "Shares", value: a.shares ?? 0, cls: "text-green-400/80" },
                  { label: "Reach", value: a.reach ?? 0, cls: "text-violet-400/80" },
                  { label: "Impressions", value: a.impressions ?? 0, cls: "text-amber-400/80" },
                  { label: "Engagement", value: eng, cls: "text-white/80" },
                ];
                const row = { analytics: a, post, account };
                const camp = campaignOf(row);
                return (
                  <div key={a.id} className="px-4 py-3.5 space-y-2.5">
                    <div className="flex items-start gap-2.5">
                      <span className="text-base mt-0.5 flex-shrink-0">{platformIcon(post?.platform ?? "")}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-white/70 text-xs font-medium truncate">{title}</p>
                        <p className="text-white/20 text-[10px] mt-0.5 truncate">
                          @{account?.username ?? "unknown"}
                          {post?.publishedAt ? <> · {format(new Date(post.publishedAt), "MMM d, HH:mm")}</> : null}
                        </p>
                      </div>
                      {postUrl && (
                        <a
                          href={postUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-shrink-0 p-1.5 -m-0.5 rounded-md text-white/30 active:text-violet-300 active:bg-violet-500/15"
                          title="View on platform"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                    </div>
                    <div className="flex">
                      <VerdictBadge result={scores.get(a.id)} toQualify={toQualifyOf(row)} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {metrics.map((m) => (
                        <div key={m.label} className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2 py-1.5">
                          <p className="text-[8px] text-white/25 uppercase tracking-wider font-semibold">{m.label}</p>
                          <p className={`text-xs font-semibold tabular-nums ${m.cls}`}>{m.value.toLocaleString()}</p>
                        </div>
                      ))}
                    </div>
                    {post && campaigns.length > 0 && (
                      <div className="flex items-center justify-between gap-2">
                        <CampaignSelect postId={post.id} value={post.campaignId} campaigns={campaigns} onAssigned={onAssigned} />
                        <span className="text-sm font-semibold text-emerald-300 tabular-nums">{formatMoney(revenueOf(row), camp?.currency)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="overflow-x-auto hidden sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.04]">
                    {["Post", "Likes", "Comments", "Shares", "Reach", "Impressions", "Engagement", "Result", "Campaign", "Revenue", "Published"].map((h, i) => (
                      <th
                        key={h}
                        className={`px-5 py-3 text-[10px] font-semibold text-white/25 uppercase tracking-widest whitespace-nowrap ${i > 0 ? "text-right" : "text-left"}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map(({ analytics: a, post, account }) => {
                    const postUrl = platformPostUrl(post?.platform ?? "", post?.platformPostId ?? null, account?.username ?? null);
                    // First line of content = implicit title; rest = subtitle
                    const content = post?.content ?? "";
                    const firstLine = content.split("\n")[0] || content;
                    const title = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
                    const hasMore = content.length > firstLine.length || firstLine.length > 80;

                    return (
                      <tr key={a.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors last:border-0">
                        <td className="px-5 py-3.5 max-w-[260px]">
                          <div className="flex items-start gap-2.5">
                            <span className="text-base mt-0.5 flex-shrink-0">{platformIcon(post?.platform ?? "")}</span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="text-white/70 text-xs font-medium truncate">{title}</p>
                                {postUrl && (
                                  <a
                                    href={postUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex-shrink-0 p-1 rounded-md text-white/30 hover:text-violet-300 hover:bg-violet-500/15 border border-transparent hover:border-violet-500/25 transition-all"
                                    title="View on platform"
                                  >
                                    <ExternalLink size={13} />
                                  </a>
                                )}
                              </div>
                              {hasMore && (
                                <p className="text-white/25 text-[10px] mt-0.5 truncate">{content.slice(title.length).trim().slice(0, 60)}</p>
                              )}
                              <p className="text-white/20 text-[10px] mt-0.5">@{account?.username ?? "unknown"}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-right font-medium text-red-400/80 text-sm tabular-nums">{(a.likes ?? 0).toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-right font-medium text-blue-400/80 text-sm tabular-nums">{(a.comments ?? 0).toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-right font-medium text-green-400/80 text-sm tabular-nums">{(a.shares ?? 0).toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-right font-medium text-violet-400/80 text-sm tabular-nums">{(a.reach ?? 0).toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-right font-medium text-amber-400/80 text-sm tabular-nums">{(a.impressions ?? 0).toLocaleString()}</td>
                        <td className="px-5 py-3.5 min-w-[120px]">
                          {(() => {
                            const eng = engagementOf(a);
                            return (
                              <div className="flex items-center gap-2 justify-end">
                                <div className="h-1.5 w-16 rounded-full bg-white/[0.06] overflow-hidden">
                                  <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400" style={{ width: `${Math.max(4, (eng / maxEng) * 100)}%` }} />
                                </div>
                                <span className="text-white/70 text-sm font-semibold tabular-nums w-12 text-right">{fmt(eng)}</span>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <VerdictBadge result={scores.get(a.id)} toQualify={toQualifyOf({ analytics: a, post, account })} />
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {post && <CampaignSelect postId={post.id} value={post.campaignId} campaigns={campaigns} onAssigned={onAssigned} />}
                        </td>
                        <td className="px-5 py-3.5 text-right font-semibold text-emerald-300 text-sm tabular-nums whitespace-nowrap">
                          {(() => {
                            const row = { analytics: a, post, account };
                            const camp = campaignOf(row);
                            return camp ? formatMoney(revenueOf(row), camp.currency) : <span className="text-white/20 font-normal">—</span>;
                          })()}
                        </td>
                        <td className="px-5 py-3.5 text-right text-white/25 text-[11px] font-mono whitespace-nowrap">
                          {post?.publishedAt ? format(new Date(post.publishedAt), "MMM d, HH:mm") : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination pager={pager} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
