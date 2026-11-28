"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { platformColor } from "@/lib/utils";
import { BrandIcon } from "@/components/BrandIcon";
import PageHeader from "@/components/PageHeader";
import MetaConnectGuide, { matchMetaError } from "./MetaConnectGuide";
import {
  Trash2, Power, CheckCircle2, Users, RefreshCw, TrendingUp, Loader2, Plus, ArrowRight, BookOpen,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type Account = {
  id: number; platform: string; username: string;
  displayName: string | null; avatarUrl: string | null; isActive: boolean;
};
type AccountStat = {
  accountId: number; platform: string; username: string;
  followers: number; following: number; posts: number; views: number;
  fetchedAt: string;
};
type User = { name: string; email: string; plan: string };
type PlatformDef = {
  id: string; name: string; authUrl: string;
  comingSoon?: boolean;   // shown, but can't be connected yet
};

const PLATFORMS: PlatformDef[] = [
  { id: "youtube", name: "YouTube", authUrl: "/api/auth/youtube" },
  { id: "instagram", name: "Instagram", authUrl: "/api/auth/instagram" },
  { id: "twitter", name: "X (Twitter)", authUrl: "/api/auth/twitter", comingSoon: true },
  { id: "tiktok", name: "TikTok", authUrl: "/api/auth/tiktok" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function statItems(platform: string, s: AccountStat): { label: string; value: number }[] {
  if (platform === "youtube") return [
    { label: "subs", value: s.followers },
    { label: "videos", value: s.posts },
    { label: "views", value: s.views },
  ];
  if (platform === "tiktok") return [
    { label: "followers", value: s.followers },
    { label: "following", value: s.following },
    { label: "videos", value: s.posts },
    { label: "likes", value: s.views },
  ];
  // instagram, twitter
  return [
    { label: "followers", value: s.followers },
    { label: "following", value: s.following },
    { label: platform === "twitter" ? "tweets" : "posts", value: s.posts },
  ];
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── Main page ─────────────────────────────────────────────────────────────────

function AccountsContent() {
  const [accounts, setAccounts]         = useState<Account[]>([]);
  const [statsMap, setStatsMap]         = useState<Record<number, AccountStat>>({});
  const [user, setUser]                 = useState<User | null>(null);
  const [refreshing, setRefreshing]     = useState(false);
  const [refreshErrors, setRefreshErrors] = useState<string[]>([]);
  const params    = useSearchParams();
  const connected = params.get("connected");
  const error     = params.get("error");
  const errorDetail = params.get("detail");
  const decodedDetail = errorDetail ? safeDecode(errorDetail) : null;
  const metaError = error === "instagram";
  const [guideOpen, setGuideOpen] = useState(false);
  const igAuthUrl = PLATFORMS.find((p) => p.id === "instagram")!.authUrl;

  function fetchStats() {
    fetch("/api/account-stats")
      .then((r) => r.json())
      .then((rows: AccountStat[]) => {
        const map: Record<number, AccountStat> = {};
        for (const row of rows) map[row.accountId] = row;
        setStatsMap(map);
      })
      .catch(() => {});
  }

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setAccounts(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    // /api/auth/me returns the user object directly (not { user }); on 401/404
    // (e.g. a stale cookie) bail quietly instead of parsing an error body.
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.email) setUser(d); })
      .catch(() => {});
    fetchStats();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshStats() {
    setRefreshing(true);
    setRefreshErrors([]);
    try {
      const res  = await fetch("/api/account-stats", { method: "POST" });
      const data = await res.json() as {
        results: AccountStat[];
        errors: { accountId: number; platform: string; error: string }[];
      };
      const map: Record<number, AccountStat> = { ...statsMap };
      for (const row of data.results) map[row.accountId] = row;
      setStatsMap(map);
      if (data.errors.length > 0) {
        setRefreshErrors(data.errors.map((e) => `${e.platform}: ${e.error}`));
      }
    } catch {
      setRefreshErrors(["Failed to refresh stats"]);
    }
    setRefreshing(false);
  }

  async function deleteAccount(id: number) {
    if (!confirm("Remove this account?")) return;
    await fetch("/api/accounts", { method: "DELETE", body: JSON.stringify({ id }), headers: { "Content-Type": "application/json" } });
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  }

  async function toggleAccount(id: number, isActive: boolean) {
    await fetch("/api/accounts", { method: "PATCH", body: JSON.stringify({ id, isActive: !isActive }), headers: { "Content-Type": "application/json" } });
    setAccounts((prev) => prev.map((a) => a.id === id ? { ...a, isActive: !isActive } : a));
  }

  const connectedIds = new Set(accounts.map((a) => a.platform));
  const hasStats = Object.keys(statsMap).length > 0;

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-8">

        {/* Header */}
        <PageHeader
          eyebrow="Accounts"
          title="Connected accounts"
          description={user && (
            <>
              {user.name}
              <span className="mx-2 text-white/15">·</span>
              {user.email}
              <span className="mx-2 text-white/15">·</span>
              <span className="text-violet-400 capitalize">{user.plan} plan</span>
            </>
          )}
        />

        {connected && (
          <div className="mb-5 flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/20 text-green-400 rounded-xl text-sm">
            <CheckCircle2 size={15} className="flex-shrink-0" />
            Successfully connected your {connected} account!
          </div>
        )}
        {error && (
          <div className="mb-5 px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm space-y-1">
            <p className="font-medium">Could not connect {error}.</p>
            {metaError && matchMetaError(decodedDetail) && (
              <p className="text-red-300/80 text-xs">{matchMetaError(decodedDetail)!.fix}</p>
            )}
            {decodedDetail
              ? <p className="font-mono text-xs text-red-400/60 break-all">{decodedDetail}</p>
              : <p className="text-red-400/60">Please try again. If it keeps failing, contact support.</p>}
            {metaError && (
              <button type="button" onClick={() => setGuideOpen(true)}
                className="mt-1.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-200 text-xs font-semibold">
                <BookOpen size={12} /> Open the Instagram setup guide
              </button>
            )}
          </div>
        )}
        {refreshErrors.length > 0 && (
          <div className="mb-5 px-4 py-3 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl text-xs space-y-1">
            <p className="font-semibold text-sm">Some stats could not be refreshed:</p>
            {refreshErrors.map((e, i) => <p key={i} className="text-amber-400/70">{e}</p>)}
          </div>
        )}

        {/* Platform cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {PLATFORMS.map((p) => {
            const isConnected = connectedIds.has(p.id);
            const count = accounts.filter((a) => a.platform === p.id).length;
            return (
              <div
                key={p.id}
                className={`group relative bg-d12 border rounded-xl p-4 flex flex-col gap-3 transition-all ${p.comingSoon ? "opacity-60 " : ""}${
                  isConnected ? "border-violet-500/20 hover:border-violet-500/40" : "border-white/[0.06] hover:border-white/[0.14]"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <BrandIcon platform={p.id} size={20} />
                  {isConnected && (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-green-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                      Connected
                    </span>
                  )}
                </div>

                <div>
                  <p className="font-semibold text-white/70 text-sm">{p.name}</p>
                  <p className="text-[11px] text-white/25 mt-0.5">
                    {p.comingSoon ? "Coming soon" : isConnected ? `${count} account${count !== 1 ? "s" : ""} linked` : "Not connected"}
                  </p>
                </div>

                {p.comingSoon ? (
                  <span className="mt-auto flex items-center justify-center gap-1.5 text-xs font-semibold py-2 rounded-lg
                    bg-white/[0.04] border border-white/[0.06] text-white/35 cursor-default select-none">
                    Coming soon
                  </span>
                ) : p.id === "instagram" && !isConnected ? (
                <div className="mt-auto flex flex-col gap-1.5">
                  <button type="button" onClick={() => setGuideOpen(true)}
                    className="flex items-center justify-center gap-1.5 text-xs font-semibold py-2 rounded-lg transition-colors bg-violet-600 hover:bg-violet-500 text-white">
                    Connect <ArrowRight size={13} />
                  </button>
                  <a href={p.authUrl} className="text-center text-[10px] text-white/25 hover:text-white/50">Skip the checklist</a>
                </div>
                ) : (
                <a
                  href={p.authUrl}
                  className={`mt-auto flex items-center justify-center gap-1.5 text-xs font-semibold py-2 rounded-lg transition-colors ${
                    isConnected
                      ? "text-violet-400 bg-violet-500/[0.08] hover:bg-violet-500/15"
                      : "bg-violet-600 hover:bg-violet-500 text-white"
                  }`}
                >
                  {isConnected ? <><Plus size={13} /> Add another</> : <>Connect <ArrowRight size={13} /></>}
                </a>
                )}
              </div>
            );
          })}
        </div>

        {/* Accounts list */}
        <div className="bg-d12 border border-white/[0.06] rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/[0.05] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-white/70">Your Accounts</span>
              <span className="text-xs text-white/25">{accounts.length} connected</span>
            </div>

            {accounts.length > 0 && (
              <button
                onClick={refreshStats}
                disabled={refreshing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.04] hover:bg-white/[0.07]
                  border border-white/[0.07] text-white/40 hover:text-white/65 rounded-lg text-[11px]
                  font-medium transition-all disabled:opacity-40"
              >
                {refreshing
                  ? <><Loader2 size={11} className="animate-spin" /> Refreshing…</>
                  : <><TrendingUp size={11} /> {hasStats ? "Refresh Stats" : "Fetch Stats"}</>
                }
              </button>
            )}
          </div>

          {accounts.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4">
                <Users size={28} className="text-white/15" />
              </div>
              <p className="text-white/30 font-medium text-sm mb-1">No accounts connected yet</p>
              <p className="text-white/15 text-xs">Pick a platform above and click Connect to get started.</p>
            </div>
          ) : (
            <div>
              {accounts.map((acc) => {
                const stat = statsMap[acc.id] ?? null;
                const items = stat ? statItems(acc.platform, stat) : [];

                return (
                  <div key={acc.id} className="flex items-start gap-3.5 px-5 py-4 border-b border-white/[0.04] hover:bg-white/[0.02] group transition-colors last:border-0">

                    {/* Avatar */}
                    {acc.avatarUrl ? (
                      <img src={acc.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover flex-shrink-0 border border-white/[0.08] mt-0.5" />
                    ) : (
                      <div className={`w-9 h-9 rounded-full ${platformColor(acc.platform)} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                        <BrandIcon platform={acc.platform} size={16} fill="#fff" />
                      </div>
                    )}

                    {/* Info + stats */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-white/75 text-sm truncate">{acc.displayName ?? acc.username}</p>
                      <p className="text-xs text-white/30 mb-1.5">
                        @{acc.username.replace(/^@/, "")}
                        <span className="mx-1.5 text-white/15">·</span>
                        <span className="capitalize">{acc.platform}</span>
                      </p>

                      {/* Stats chips */}
                      {stat ? (
                        <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1">
                          {items.map(({ label, value }) => (
                            <span key={label} className="flex items-center gap-1 text-[10px]">
                              <span className="font-semibold text-white/55 tabular-nums">{fmt(value)}</span>
                              <span className="text-white/20">{label}</span>
                            </span>
                          ))}
                          <span className="text-[9px] text-white/15 ml-1">
                            · {formatDistanceToNow(new Date(stat.fetchedAt), { addSuffix: true })}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-white/15 italic">
                          No stats yet — click &ldquo;Fetch Stats&rdquo; above
                        </span>
                      )}
                    </div>

                    {/* Status + controls */}
                    <div className="flex items-center gap-1 flex-shrink-0 pt-0.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
                        acc.isActive ? "bg-green-500/15 text-green-400 border border-green-500/20" : "bg-white/[0.08] text-white/30 border border-white/[0.08]"
                      }`}>
                        {acc.isActive ? "Active" : "Paused"}
                      </span>
                      <div className="flex items-center gap-0.5 hover-reveal transition-opacity">
                        {!PLATFORMS.find((p) => p.id === acc.platform)?.comingSoon && <a
                          href={PLATFORMS.find((p) => p.id === acc.platform)?.authUrl}
                          className="p-1.5 text-white/25 hover:text-sky-400 rounded-lg hover:bg-sky-500/10 transition-colors"
                          title="Reconnect (refresh token)"
                        >
                          <RefreshCw size={14} />
                        </a>}
                        <button
                          onClick={() => toggleAccount(acc.id, acc.isActive)}
                          className="p-1.5 text-white/25 hover:text-violet-400 rounded-lg hover:bg-violet-500/10 transition-colors"
                          title={acc.isActive ? "Pause account" : "Activate account"}
                        >
                          <Power size={14} />
                        </button>
                        <button
                          onClick={() => deleteAccount(acc.id)}
                          className="p-1.5 text-white/25 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
                          title="Remove account"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
      {guideOpen && (
        <MetaConnectGuide authUrl={igAuthUrl} errorDetail={metaError ? decodedDetail : null} onClose={() => setGuideOpen(false)} />
      )}
    </div>
  );
}

export default function AccountsPage() {
  return <Suspense><AccountsContent /></Suspense>;
}
