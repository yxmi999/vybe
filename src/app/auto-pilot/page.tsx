"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Plus, Loader2, Play, Pause, Trash2, AlertCircle, Check, Clock, ArrowUpRight, Sparkles, Lock,
  Pencil, Tv, CalendarClock, Inbox, Send, LayoutGrid, Captions, Wand2, Zap, Eye, Radio,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import Worker from "@/components/icons/Worker";
import { parsePilotTemplate } from "@/lib/auto-pilot-template";
import { cn } from "@/lib/utils";
import ScheduleBuilder from "./ScheduleBuilder";
import {
  parseJson, scheduleText,
  type Account, type CampaignOption, type Limits, type Pilot,
} from "./types";

type QueueItem = {
  id: number; content: string; url: string | null; platform: string;
  account: { username: string; platform: string }; confidence: number | null; videoTitle: string; createdAt: string;
  viralityScore: number | null; viralityVerdict: string | null; clipRequested?: boolean;
};
type OutcomeSummary = {
  n: number;
  byAiScore: { label: string; n: number; avgViews: number; medViews: number }[];
  correlations: { signal: string; r: number | null; n: number }[];
};

function localDatetimeValue(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// Channel avatar/name for a schedule card (one lookup per channel, cached).
const channelCache = new Map<string, Promise<{ displayName: string; avatar: string } | null>>();
function useChannelBadge(login: string) {
  const [info, setInfo] = useState<{ displayName: string; avatar: string } | null>(null);
  useEffect(() => {
    let alive = true;
    let p = channelCache.get(login);
    if (!p) {
      p = fetch(`/api/auto-pilot/channel?login=${encodeURIComponent(login)}`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      channelCache.set(login, p);
    }
    p.then((d) => { if (alive && d) setInfo({ displayName: d.displayName, avatar: d.avatar }); });
    return () => { alive = false; };
  }, [login]);
  return info;
}

export default function AutoPilotPage() {
  const [loading, setLoading] = useState(true);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [used, setUsed] = useState(0);
  const [pilots, setPilots] = useState<Pilot[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [outcomes, setOutcomes] = useState<OutcomeSummary | null>(null);
  const [tab, setTab] = useState<"schedules" | "review">("schedules");
  const [building, setBuilding] = useState<"new" | number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    const p1 = fetch("/api/auto-pilot").then((r) => r.json()).then((ap) => {
      if (ap) { setLimits(ap.limits); setUsed(ap.used ?? 0); setPilots(ap.pilots ?? []); }
      setLoading(false);
    }).catch(() => setLoading(false));
    const p2 = fetch("/api/accounts").then((r) => r.json()).then((a) => setAccounts(Array.isArray(a) ? a : [])).catch(() => {});
    const p3 = fetch("/api/auto-pilot/queue").then((r) => r.json()).then((q) => setQueue(q?.items ?? [])).catch(() => {});
    const p4 = fetch("/api/auto-pilot/outcomes").then((r) => r.json()).then((o) => setOutcomes(o?.summary ?? null)).catch(() => {});
    const p5 = fetch("/api/campaigns").then((r) => (r.ok ? r.json() : [])).then((c) => setCampaigns(Array.isArray(c) ? c : [])).catch(() => {});
    return Promise.all([p1, p2, p3, p4, p5]);
  }

  useEffect(() => { load(); }, []);

  const ytAccounts = accounts.filter((a) => a.platform === "youtube");
  const atCap = !!limits && pilots.length >= limits.maxAutoPilots;

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    await fn().catch(() => {});
    await load();
    setBusy(null);
  }
  const runNow = (id: number) => act(`run-${id}`, () => fetch(`/api/auto-pilot/${id}/run-now`, { method: "POST" }));
  const toggle = (p: Pilot) => act(`toggle-${p.id}`, () => fetch(`/api/auto-pilot/${p.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !p.enabled }),
  }));
  const remove = (id: number) => {
    if (!confirm("Delete this Auto-Pilot? Clips already in review are kept.")) return;
    act(`del-${id}`, () => fetch(`/api/auto-pilot/${id}`, { method: "DELETE" }));
  };
  const decide = (item: QueueItem, action: "approve" | "reject", scheduledAt?: string) =>
    act(`q-${item.id}`, () => fetch(`/api/auto-pilot/queue/${item.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, scheduledAt }),
    }));

  if (loading) {
    return (
      <div className="min-h-screen bg-d0a flex items-center justify-center">
        <Loader2 className="animate-spin text-white/30" size={28} />
      </div>
    );
  }

  // ── Locked (free plan) ──
  if (limits && !limits.autoPilotEnabled) {
    return (
      <div className="min-h-screen bg-d0a text-white">
        <div className="max-w-2xl mx-auto px-4 sm:px-8 py-20">
          <div className="relative overflow-hidden rounded-3xl border border-violet-500/15 bg-violet-500/[0.04] p-8 sm:p-12 text-center">
            <Stars />
            <div className="relative w-16 h-16 rounded-2xl bg-violet-600/15 border border-violet-500/25 flex items-center justify-center mx-auto mb-6">
              <Worker size={30} className="text-violet-300" />
              <span className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full bg-d0a border border-violet-500/30 flex items-center justify-center">
                <Lock size={11} className="text-violet-300" />
              </span>
            </div>
            <h1 className="relative text-2xl sm:text-3xl font-extrabold tracking-tight mb-3">Auto-Pilot is a paid feature</h1>
            <p className="relative text-white/45 text-sm sm:text-base max-w-md mx-auto mb-8">
              Pick a creator and a schedule — Vybe watches their streams, clips the best moments,
              edits them in your style, and posts (or queues them for review) on autopilot.
            </p>
            <Link href="/billing"
              className="relative inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white font-semibold px-6 py-3 rounded-xl transition-colors text-sm">
              See plans <ArrowUpRight size={15} />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const pct = limits ? Math.min(100, Math.round((used / Math.max(1, limits.autoClipsPerMonth)) * 100)) : 0;
  const activeCount = pilots.filter((p) => p.enabled).length;

  return (
    <div className="min-h-screen bg-d0a text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 sm:py-10">
        {/* Header */}
        <header className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-gradient-to-br from-violet-600/[0.10] via-d0e to-d0b p-5 sm:p-7 mb-6">
          <Stars />
          <div className="relative flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="flex items-center gap-4 flex-1 min-w-0">
              <span className="flex items-center justify-center w-14 h-14 rounded-2xl bg-violet-600/15 border border-violet-500/25 flex-shrink-0">
                <Worker size={28} className="text-violet-300" />
              </span>
              <div className="min-w-0">
                <p className="cue text-violet-300/80">Auto-Pilot</p>
                <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight">Hands-off clipping</h1>
                <p className="text-sm text-white/45 mt-0.5">Watch a creator, auto-clip every stream, post on your schedule.</p>
              </div>
            </div>
            {limits && (
              <div className="grid grid-cols-2 gap-3 sm:w-[300px]">
                <div className="rounded-2xl border border-white/[0.07] bg-black/30 p-3">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-white/35">Clips this month</p>
                  <p className="mt-1 text-lg font-bold tabular-nums">{used}<span className="text-white/30 text-sm font-medium"> / {limits.autoClipsPerMonth}</span></p>
                  <div className="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly auto-clip usage">
                    <div className={cn("h-full rounded-full", pct >= 90 ? "bg-amber-400" : "bg-gradient-to-r from-violet-500 to-fuchsia-400")} style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <div className="rounded-2xl border border-white/[0.07] bg-black/30 p-3">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-white/35">Active pilots</p>
                  <p className="mt-1 text-lg font-bold tabular-nums">{activeCount}<span className="text-white/30 text-sm font-medium"> / {limits.maxAutoPilots}</span></p>
                  <p className="mt-1.5 text-[10px] text-white/30">{limits.maxClipsPerRun} clips max per stream</p>
                </div>
              </div>
            )}
          </div>
        </header>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-6 border-b border-white/[0.06]" role="tablist">
          {(["schedules", "review"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={cn("relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors", tab === t ? "text-white" : "text-white/40 hover:text-white/70")}>
              {t === "schedules" ? <><CalendarClock size={14} /> Pilots</> : <><Inbox size={14} /> Review queue</>}
              {t === "review" && queue.length > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-violet-600 text-[10px] font-bold">{queue.length}</span>
              )}
              {tab === t && <span className="absolute bottom-0 inset-x-0 h-[2px] bg-violet-500 rounded-full" />}
            </button>
          ))}
          {tab === "schedules" && building === null && pilots.length > 0 && (
            <button onClick={() => setBuilding("new")} disabled={atCap}
              title={atCap ? `Your plan allows ${limits?.maxAutoPilots} Auto-Pilot${limits?.maxAutoPilots === 1 ? "" : "s"}` : undefined}
              className="ml-auto mb-1.5 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[13px] font-semibold transition-colors">
              <Plus size={14} /> New pilot
            </button>
          )}
        </div>

        {tab === "schedules" && (
          <div className="space-y-4">
            {building === "new" && (
              <ScheduleBuilder ytAccounts={ytAccounts} campaigns={campaigns} maxClipsPerRun={limits?.maxClipsPerRun ?? 3}
                onCancel={() => setBuilding(null)} onSaved={async () => { setBuilding(null); await load(); }} />
            )}

            {pilots.length === 0 && building === null && <EmptyState onStart={() => setBuilding("new")} />}

            {atCap && building === null && pilots.length > 0 && (
              <p className="text-[12px] text-white/35 flex items-center gap-1.5">
                <Zap size={12} className="text-amber-300" /> You&apos;re using all {limits?.maxAutoPilots} Auto-Pilot slot{limits?.maxAutoPilots === 1 ? "" : "s"}.{" "}
                <Link href="/billing" className="text-violet-300 hover:underline">Upgrade for more</Link>
              </p>
            )}

            <div className="grid gap-4 xl:grid-cols-2">
              {pilots.map((p) => building === p.id ? (
                <div key={p.id} className="xl:col-span-2">
                  <ScheduleBuilder editPilot={p} ytAccounts={ytAccounts} campaigns={campaigns} maxClipsPerRun={limits?.maxClipsPerRun ?? 3}
                    onCancel={() => setBuilding(null)} onSaved={async () => { setBuilding(null); await load(); }} />
                </div>
              ) : (
                <PilotCard key={p.id} pilot={p} busy={busy} campaigns={campaigns}
                  onRun={() => runNow(p.id)} onToggle={() => toggle(p)} onDelete={() => remove(p.id)}
                  onEdit={() => setBuilding(p.id)} onReview={() => setTab("review")} />
              ))}
            </div>
          </div>
        )}

        {tab === "review" && (
          <>
            {queue.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/[0.08] py-16 text-center">
                <Inbox size={26} className="mx-auto text-white/15 mb-3" />
                <p className="text-white/45 text-sm font-medium">All caught up</p>
                <p className="text-white/25 text-[12px] mt-1">New clips from your pilots land here for a quick yes / no.</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {queue.map((item) => (
                  <ReviewCard key={item.id} item={item} busy={busy === `q-${item.id}`}
                    onApprove={(when) => decide(item, "approve", when)} onReject={() => decide(item, "reject")} />
                ))}
              </div>
            )}
            {outcomes && outcomes.n > 0 && <CalibrationPanel summary={outcomes} />}
          </>
        )}
      </div>
    </div>
  );
}

// Faint starfield behind the space-themed headers (decorative).
function Stars() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60"
      style={{
        backgroundImage:
          "radial-gradient(1px 1px at 12% 22%, rgba(255,255,255,.5), transparent 60%)," +
          "radial-gradient(1px 1px at 78% 18%, rgba(255,255,255,.35), transparent 60%)," +
          "radial-gradient(1.5px 1.5px at 62% 72%, rgba(255,255,255,.3), transparent 60%)," +
          "radial-gradient(1px 1px at 32% 82%, rgba(255,255,255,.25), transparent 60%)," +
          "radial-gradient(1px 1px at 90% 60%, rgba(255,255,255,.3), transparent 60%)," +
          "radial-gradient(1.5px 1.5px at 45% 35%, rgba(167,139,250,.35), transparent 60%)",
      }} />
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  const steps = [
    { icon: Tv, title: "Pick a creator", desc: "Any Twitch channel. Vybe checks for new streams on your schedule." },
    { icon: Wand2, title: "Choose the look", desc: "Copy a style, split facecam + gameplay, animated subtitles." },
    { icon: Send, title: "Clips land for you", desc: "Review them in one tap — or let strong ones auto-post." },
  ];
  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-d0e p-6 sm:p-10 text-center">
      <Stars />
      <div className="relative mx-auto w-16 h-16 rounded-2xl bg-violet-600/15 border border-violet-500/25 flex items-center justify-center mb-5 animate-[float_6s_ease-in-out_infinite]">
        <Worker size={30} className="text-violet-300" />
      </div>
      <h2 className="relative text-xl sm:text-2xl font-bold tracking-tight">Launch your first Auto-Pilot</h2>
      <p className="relative text-sm text-white/40 mt-1.5 max-w-md mx-auto">Set it once. Every new stream becomes edited, ready-to-post Shorts.</p>
      <div className="relative grid sm:grid-cols-3 gap-3 mt-7 text-left">
        {steps.map(({ icon: Icon, title, desc }, i) => (
          <div key={title} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-5 h-5 rounded-full bg-violet-600/20 text-violet-200 text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
              <Icon size={14} className="text-white/40" />
            </div>
            <p className="text-[13px] font-semibold text-white/85">{title}</p>
            <p className="text-[11px] text-white/35 mt-0.5 leading-relaxed">{desc}</p>
          </div>
        ))}
      </div>
      <button onClick={onStart}
        className="relative mt-7 inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white font-semibold px-6 py-3 rounded-xl text-sm transition-colors shadow-[0_0_24px_rgba(51,92,186,0.35)]">
        <Worker size={16} /> Build a pilot
      </button>
    </div>
  );
}

// ── Pilot card ───────────────────────────────────────────────────────────────
function PilotCard({ pilot, busy, campaigns, onRun, onToggle, onDelete, onEdit, onReview }: {
  pilot: Pilot; busy: string | null; campaigns: CampaignOption[];
  onRun: () => void; onToggle: () => void; onDelete: () => void; onEdit: () => void; onReview: () => void;
}) {
  const ch = useChannelBadge(pilot.channel);
  const days = parseJson<number[]>(pilot.days, []);
  const times = parseJson<string[]>(pilot.postTimes, []);
  const tpl = parsePilotTemplate(pilot.template);
  const stats = pilot.stats ?? { review: 0, scheduled: 0, posted: 0, failed: 0 };
  const campaign = tpl.campaignId ? campaigns.find((c) => c.id === tpl.campaignId) : campaigns.find((c) => c.isDefault);
  const running = busy === `run-${pilot.id}`;

  const isLive = !!pilot.liveMode && pilot.liveState === "live";
  const features: { icon: React.ElementType; label: string }[] = [
    ...(pilot.liveMode ? [{ icon: Radio, label: "Live mode" }] : []),
    ...(tpl.styleRef ? [{ icon: Wand2, label: "AI style" }] : []),
    ...(tpl.cropFill === "split" ? [{ icon: LayoutGrid, label: tpl.autoFacecam ? "Split · auto facecam" : "Split screen" }] : []),
    ...(tpl.subtitles?.enabled ? [{ icon: Captions, label: "Subtitles" }] : []),
    { icon: pilot.autoPost ? Sparkles : Eye, label: pilot.autoPost ? `Auto-post ≥${pilot.minConfidence}%` : "Review first" },
  ];

  return (
    <article className={cn("rounded-2xl border bg-d0f p-4 sm:p-5 flex flex-col gap-4 transition-colors",
      pilot.enabled ? "border-white/[0.08]" : "border-white/[0.05] opacity-80")}>
      <div className="flex items-start gap-3">
        <div className="relative flex-shrink-0">
          {ch?.avatar
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={ch.avatar} alt="" className="w-11 h-11 rounded-full border border-white/10" />
            : <span className="w-11 h-11 rounded-full bg-violet-600/15 border border-violet-500/20 flex items-center justify-center"><Tv size={16} className="text-violet-300" /></span>}
          <span className={cn("absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-d0f",
            pilot.enabled ? "bg-emerald-400" : "bg-white/25")} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold truncate">{ch?.displayName ?? pilot.channel}</h3>
            {pilot.enabled && isLive ? (
              <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0 bg-red-500/15 text-red-300 border-red-500/30">
                <span className="relative flex w-1.5 h-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping motion-reduce:animate-none" />
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-red-400" />
                </span>
                LIVE · clipping
              </span>
            ) : (
              <span className={cn("text-[10px] font-semibold px-2 py-0.5 rounded-full border flex-shrink-0",
                pilot.enabled ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25" : "bg-white/[0.05] text-white/40 border-white/[0.1]")}>
                {!pilot.enabled ? "Paused" : pilot.liveMode ? "Waiting for stream" : "Active"}
              </span>
            )}
          </div>
          <p className="text-[12px] text-white/40 mt-0.5">
            {pilot.liveMode
              ? <>Clips while live{isLive && pilot.liveClips != null ? ` · ${pilot.liveClips}/${pilot.clipsPerRun} this stream` : ` · up to ${pilot.clipsPerRun}/stream`}</>
              : <>{scheduleText(pilot.cadence, days, times)} · {pilot.clipsPerRun} clip{pilot.clipsPerRun > 1 ? "s" : ""}/stream</>}
          </p>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <IconBtn label="Edit" onClick={onEdit}><Pencil size={15} /></IconBtn>
          <IconBtn label={pilot.enabled ? "Pause" : "Resume"} onClick={onToggle} disabled={busy === `toggle-${pilot.id}`}>
            {pilot.enabled ? <Pause size={15} /> : <Play size={15} />}
          </IconBtn>
          <IconBtn label="Delete" onClick={onDelete} disabled={busy === `del-${pilot.id}`} danger><Trash2 size={15} /></IconBtn>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {features.map(({ icon: Icon, label }) => (
          <span key={label} className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 text-[10px] text-white/55">
            <Icon size={10} /> {label}
          </span>
        ))}
        {campaign && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/[0.07] border border-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300/90">
            $ {campaign.name}
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        {([
          ["In review", stats.review, "text-amber-300", stats.review > 0 ? onReview : undefined],
          ["Scheduled", stats.scheduled, "text-violet-300", undefined],
          ["Posted", stats.posted, "text-emerald-300", undefined],
        ] as const).map(([label, n, cls, onClick]) => {
          const inner = (
            <>
              <p className={cn("text-lg font-bold tabular-nums leading-tight", n > 0 ? cls : "text-white/25")}>{n}</p>
              <p className="text-[10px] uppercase tracking-wider text-white/30 font-semibold">{label}</p>
            </>
          );
          return onClick ? (
            <button key={label} onClick={onClick} className="rounded-xl bg-white/[0.03] border border-amber-500/20 hover:bg-amber-500/[0.06] px-3 py-2 text-left transition-colors">{inner}</button>
          ) : (
            <div key={label} className="rounded-xl bg-white/[0.03] border border-white/[0.05] px-3 py-2">{inner}</div>
          );
        })}
      </div>

      {pilot.lastError && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-200/85 flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-px shrink-0" /> {pilot.lastError}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-white/[0.05]">
        <p className="text-[11px] text-white/35 flex items-center gap-1.5 min-w-0">
          <Clock size={11} className="flex-shrink-0" />
          <span className="truncate">
            {!pilot.enabled ? "Paused"
              : pilot.nextRunAt ? `${pilot.liveMode ? (isLive ? "Next live scan" : "Checks if live") : "Next check"} ${formatDistanceToNow(new Date(pilot.nextRunAt), { addSuffix: true })}` : "Waiting to schedule"}
            {pilot.lastRunAt && ` · last ran ${formatDistanceToNow(new Date(pilot.lastRunAt), { addSuffix: true })}`}
          </span>
        </p>
        <button onClick={onRun} disabled={running}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-[12px] font-semibold text-white/80 disabled:opacity-50">
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          {running ? "Clipping…" : "Run now"}
        </button>
      </div>
    </article>
  );
}

function IconBtn({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className={cn("p-2 rounded-lg text-white/45 hover:bg-white/[0.06] transition-colors disabled:opacity-40",
        danger ? "hover:text-red-400" : "hover:text-white")}>
      {children}
    </button>
  );
}

// ── Signal calibration ───────────────────────────────────────────────────────
// How the detection signals correlate with real views on published clips —
// the ground truth for tuning auto-post thresholds.
function CalibrationPanel({ summary }: { summary: OutcomeSummary }) {
  const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
  const scored = summary.byAiScore.filter((b) => b.n > 0);
  return (
    <div className="mt-8 rounded-2xl border border-white/[0.08] bg-d0f p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles size={13} className="text-violet-400/70" />
        <h3 className="text-[13px] font-semibold text-white/70">Signal calibration</h3>
        <span className="text-[11px] text-white/25">{summary.n} published clip{summary.n === 1 ? "" : "s"} tracked</span>
      </div>
      {scored.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {scored.map((b) => (
            <div key={b.label} className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2">
              <p className="text-[10px] text-white/35 font-medium">{b.label}</p>
              <p className="text-[15px] font-bold text-white/80 tabular-nums">{fmt(b.avgViews)} <span className="text-[10px] font-medium text-white/30">avg views</span></p>
              <p className="text-[10px] text-white/25 tabular-nums">median {fmt(b.medViews)} · {b.n} clip{b.n === 1 ? "" : "s"}</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {summary.correlations.map((c) => (
          <span key={c.signal} className="text-[11px] text-white/35">
            {c.signal}:{" "}
            {c.r == null
              ? <span className="text-white/20">need {Math.max(0, 5 - c.n)} more clips</span>
              : <span className={c.r >= 0.3 ? "text-emerald-300" : c.r <= -0.1 ? "text-red-300" : "text-white/55"}>r = {c.r}</span>}
          </span>
        ))}
      </div>
      <p className="text-[10px] text-white/20 leading-relaxed">
        Views refresh automatically for 30 days after posting. Once enough clips accumulate, use the strongest signal to tune your confidence threshold.
      </p>
    </div>
  );
}

// ── Review card ──────────────────────────────────────────────────────────────
function ReviewCard({ item, busy, onApprove, onReject }: {
  item: QueueItem; busy: boolean; onApprove: (when: string) => void; onReject: () => void;
}) {
  const [when, setWhen] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 1);
    return localDatetimeValue(d);
  });
  const conf = item.confidence ?? 0;
  const confColor = conf >= 75 ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
    : conf >= 45 ? "text-amber-300 border-amber-500/30 bg-amber-500/10"
      : "text-white/50 border-white/15 bg-white/[0.05]";

  return (
    <article className="rounded-2xl border border-white/[0.08] bg-d0f overflow-hidden flex flex-col">
      <div className="relative bg-black">
        {item.url ? (
          <video src={item.url} controls preload="metadata" className="w-full aspect-[9/16] max-h-[380px] object-contain" />
        ) : (
          <div className="w-full aspect-[9/16] max-h-[380px] flex items-center justify-center text-white/20 text-sm">No preview</div>
        )}
        {item.confidence != null && (
          <span className={cn("absolute top-2 right-2 text-[10px] font-bold px-2 py-0.5 rounded-full border backdrop-blur", confColor)}>{conf}% match</span>
        )}
      </div>
      <div className="p-3.5 space-y-3 flex-1 flex flex-col">
        <p className="text-[13px] text-white/80 line-clamp-2 leading-snug font-medium">{item.videoTitle}</p>
        {(item.viralityScore != null || item.clipRequested) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {item.viralityScore != null && (
              <span title={item.viralityVerdict ?? undefined}
                className={cn("inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border",
                  item.viralityScore >= 70 ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10"
                    : item.viralityScore >= 55 ? "text-amber-300 border-amber-500/30 bg-amber-500/10"
                      : "text-white/45 border-white/15 bg-white/[0.05]")}>
                <Sparkles size={9} /> AI {item.viralityScore}
              </span>
            )}
            {item.clipRequested && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full border text-violet-300 border-violet-500/30 bg-violet-500/10">Chat said “clip it”</span>
            )}
          </div>
        )}
        {item.viralityVerdict && <p className="text-[11px] text-white/35 line-clamp-2">{item.viralityVerdict}</p>}
        <p className="text-[11px] text-white/30">→ {item.account.username} · {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</p>
        <div className="mt-auto space-y-2">
          <label className="block">
            <span className="sr-only">Post at</span>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white/80 outline-none focus:border-violet-500/50 [color-scheme:dark]" />
          </label>
          <div className="flex items-center gap-2">
            <button onClick={() => onApprove(new Date(when).toISOString())} disabled={busy}
              className="flex-1 flex items-center justify-center gap-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white font-semibold py-2 rounded-lg text-[13px] transition-colors">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />} Approve
            </button>
            <Link href={`/clips?gen=${encodeURIComponent(item.url ?? "")}&t=${encodeURIComponent(item.videoTitle)}`}
              className="px-3 py-2 rounded-lg border border-white/[0.08] text-white/60 hover:text-white text-[13px] transition-colors">Edit</Link>
            <button onClick={onReject} disabled={busy} title="Reject" aria-label="Reject clip"
              className="p-2 rounded-lg border border-white/[0.08] text-white/50 hover:text-red-400 transition-colors disabled:opacity-40">
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
