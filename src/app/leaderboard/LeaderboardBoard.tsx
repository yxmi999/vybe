"use client";
// Views leaderboard: creators ranked by views on watermarked Vybe videos,
// monthly and yearly. Rules and data live in lib/leaderboard.ts.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Crown, Eye, Film, Loader2, Trophy, EyeOff, Check, X } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { cn } from "@/lib/utils";

type Entry = { rank: number; name: string; initial: string; views: number; videos: number; bestVideoViews: number; plan: string; isMe: boolean };
type MyVideo = { id: number; platform: string; title: string; publishedAt: string; views: number; refreshedAt: string | null; eligible: boolean };
type Board = {
  period: { kind: "month" | "year"; key: string };
  entries: Entry[];
  me: (Entry & { hidden: boolean }) | null;
  myHidden: boolean;
  participants: number;
  totalViews: number;
  myVideos: MyVideo[];
};

const compact = (n: number) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const full = (n: number) => n.toLocaleString("en-US");

function currentKey(kind: "month" | "year") {
  const iso = new Date().toISOString();
  return kind === "year" ? iso.slice(0, 4) : iso.slice(0, 7);
}

function shiftKey(kind: "month" | "year", key: string, delta: number): string {
  if (kind === "year") return String(Number(key) + delta);
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function label(kind: "month" | "year", key: string) {
  if (kind === "year") return key;
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

const card = "rounded-2xl border border-white/[0.07] bg-white/[0.02]";

export default function LeaderboardPage() {
  const [kind, setKind] = useState<"month" | "year">("month");
  const [key, setKey] = useState(() => currentKey("month"));
  const [data, setData] = useState<Board | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`/api/leaderboard?period=${key}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Couldn't load the leaderboard.");
        if (alive) { setData(d); setFailed(null); }
      })
      .catch((e) => { if (alive) setFailed({ key, message: e instanceof Error ? e.message : "Something went wrong" }); });
    return () => { alive = false; };
  }, [key, reloads]);

  const error = failed?.key === key ? failed.message : "";
  const loading = !error && data?.period.key !== key;
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  function switchKind(k: "month" | "year") {
    if (k === kind) return;
    setKind(k);
    setKey(currentKey(k));
  }

  const isCurrent = key === currentKey(kind);
  const podium = useMemo(() => (data?.entries ?? []).slice(0, 3), [data]);
  const rest = useMemo(() => (data?.entries ?? []).slice(3), [data]);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <PageHeader
        eyebrow="Grow"
        title="Leaderboard"
        description="Creators ranked by views on videos made in Vybe that carry the Vybe watermark. Post through Vybe to a connected account and your views count automatically."
      />

      {/* Period controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div className="inline-grid grid-cols-2 gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.07] w-fit">
          {(["month", "year"] as const).map((k) => (
            <button key={k} type="button" onClick={() => switchKind(k)}
              className={cn("h-8 px-4 rounded-lg text-[13px] font-medium transition-colors",
                kind === k ? "bg-violet-600 text-white" : "text-white/50 hover:text-white/80")}>
              {k === "month" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous period" onClick={() => setKey(shiftKey(kind, key, -1))}
            className="w-9 h-9 rounded-lg border border-white/[0.08] text-white/60 hover:text-white hover:bg-white/[0.05] flex items-center justify-center">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[150px] text-center text-[14px] font-semibold text-white/85">
            {label(kind, key)}{isCurrent && <span className="ml-2 text-[10px] uppercase tracking-wider text-emerald-300/90 font-bold">Live</span>}
          </span>
          <button type="button" aria-label="Next period" onClick={() => setKey(shiftKey(kind, key, 1))} disabled={isCurrent}
            className="w-9 h-9 rounded-lg border border-white/[0.08] text-white/60 hover:text-white hover:bg-white/[0.05] disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {error && <p className="mb-4 text-[13px] text-red-300">{error}</p>}

      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="min-w-0">
          {loading && !data ? (
            <div className={cn(card, "py-16 flex justify-center")}><Loader2 size={18} className="animate-spin text-white/30" /></div>
          ) : !data || data.entries.length === 0 ? (
            <div className={cn(card, "py-14 px-6 text-center")}>
              <Trophy size={28} className="mx-auto text-white/20" />
              <p className="mt-3 text-[14px] font-semibold text-white/70">No ranked creators for {label(kind, key)} yet</p>
              <p className="mt-1 text-[13px] text-white/40">Post a watermarked Vybe clip to take the top spot.</p>
            </div>
          ) : (
            <div className={cn("transition-opacity", loading && "opacity-60")}>
              <Podium entries={podium} />
              {rest.length > 0 && (
                <ol className={cn(card, "mt-4 divide-y divide-white/[0.05] overflow-hidden")}>
                  {rest.map((e) => <Row key={`${e.rank}-${e.name}-${e.views}`} e={e} />)}
                </ol>
              )}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          {data && <MyStanding data={data} onToggled={reload} />}
          {data && (
            <div className={cn(card, "p-4 grid grid-cols-2 gap-3")}>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-white/40 font-medium">Creators</p>
                <p className="mt-1 text-lg font-bold text-white tabular-nums">{full(data.participants)}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-white/40 font-medium">Total views</p>
                <p className="mt-1 text-lg font-bold text-white tabular-nums">{compact(data.totalViews)}</p>
              </div>
            </div>
          )}
          <Rules />
        </aside>
      </div>

      {data && <MyVideos videos={data.myVideos} period={label(kind, key)} />}
    </div>
  );
}

function Avatar({ e, size = 40 }: { e: Entry; size?: number }) {
  return (
    <div style={{ width: size, height: size }}
      className={cn("rounded-full flex items-center justify-center font-bold text-white flex-shrink-0",
        e.isMe ? "bg-gradient-to-br from-violet-500 to-fuchsia-600" : "bg-gradient-to-br from-white/20 to-white/5")}>
      <span style={{ fontSize: size * 0.4 }}>{e.initial}</span>
    </div>
  );
}

const MEDALS = [
  { ring: "border-amber-400/40 bg-gradient-to-b from-amber-400/[0.12] to-transparent", text: "text-amber-300", h: "sm:pt-0" },
  { ring: "border-slate-300/30 bg-gradient-to-b from-slate-300/[0.08] to-transparent", text: "text-slate-200", h: "sm:pt-8" },
  { ring: "border-orange-500/30 bg-gradient-to-b from-orange-500/[0.08] to-transparent", text: "text-orange-300", h: "sm:pt-12" },
];

function Podium({ entries }: { entries: Entry[] }) {
  // Visual order on wide screens: 2nd, 1st, 3rd.
  const order = entries.length >= 2 ? [entries[1], entries[0], entries[2]].filter(Boolean) : entries;
  return (
    <div className={cn("grid gap-3", entries.length >= 3 ? "sm:grid-cols-3" : entries.length === 2 ? "sm:grid-cols-2" : "")}>
      {order.map((e) => {
        const m = MEDALS[e.rank - 1] ?? MEDALS[2];
        return (
          <div key={`${e.rank}-${e.name}`} className={cn("sm:self-end", e.rank === 1 ? "order-first sm:order-none" : "", m.h)}>
            <div className={cn("rounded-2xl border p-5 text-center", m.ring, e.isMe && "ring-1 ring-violet-400/50")}>
              <div className="flex justify-center mb-2">
                {e.rank === 1 ? <Crown size={20} className={m.text} /> : <span className={cn("text-[13px] font-bold", m.text)}>#{e.rank}</span>}
              </div>
              <div className="flex justify-center"><Avatar e={e} size={e.rank === 1 ? 56 : 46} /></div>
              <p className="mt-3 text-[14px] font-semibold text-white/90 truncate">{e.name}{e.isMe && <span className="text-violet-300"> (you)</span>}</p>
              <p className={cn("mt-1 text-2xl font-extrabold tabular-nums", m.text)}>{compact(e.views)}</p>
              <p className="text-[11px] text-white/40">views · {e.videos} video{e.videos === 1 ? "" : "s"}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Row({ e }: { e: Entry }) {
  return (
    <li className={cn("flex items-center gap-3 px-4 py-3", e.isMe && "bg-violet-500/[0.07]")}>
      <span className="w-8 text-[13px] font-bold text-white/40 tabular-nums">#{e.rank}</span>
      <Avatar e={e} size={34} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-white/85 truncate">{e.name}{e.isMe && <span className="text-violet-300"> (you)</span>}</p>
        <p className="text-[11px] text-white/35">{e.videos} video{e.videos === 1 ? "" : "s"} · best {compact(e.bestVideoViews)}</p>
      </div>
      <span className="text-[14px] font-bold text-white tabular-nums">{compact(e.views)}</span>
    </li>
  );
}

function MyStanding({ data, onToggled }: { data: Board; onToggled: () => void }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    await fetch("/api/leaderboard", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hidden: !data.myHidden }) }).catch(() => {});
    setBusy(false);
    onToggled();
  }
  const me = data.me;
  const above = me && me.rank > 1 ? data.entries.find((e) => e.rank === me.rank - 1) ?? null : null;
  return (
    <div className={cn(card, "p-5")}>
      <p className="text-[11px] uppercase tracking-wider text-white/40 font-medium">Your standing</p>
      {me ? (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white tabular-nums">#{me.rank}</span>
            <span className="text-[13px] text-white/45">of {full(data.participants)}</span>
          </div>
          <p className="mt-1 text-[13px] text-white/60"><Eye size={12} className="inline -mt-0.5 mr-1" />{full(me.views)} views · {me.videos} video{me.videos === 1 ? "" : "s"}</p>
          {above && above.views > me.views && (
            <p className="mt-2 text-[12px] text-violet-200/80">{compact(above.views - me.views)} more views to pass #{above.rank}.</p>
          )}
        </>
      ) : (
        <p className="mt-2 text-[13px] text-white/50 leading-relaxed">
          You’re not ranked this period yet. Export a clip with the Vybe watermark and post it from <Link href="/clips" className="text-violet-300 hover:underline">Clips</Link> or <Link href="/auto-pilot" className="text-violet-300 hover:underline">Auto-Pilot</Link>.
        </p>
      )}
      <button type="button" onClick={toggle} disabled={busy}
        className="mt-4 w-full h-9 rounded-xl text-[12px] font-medium text-white/70 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] disabled:opacity-50 flex items-center justify-center gap-2">
        {busy ? <Loader2 size={13} className="animate-spin" /> : data.myHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        {data.myHidden ? "Show my name" : "Hide my name (appear as Anonymous)"}
      </button>
    </div>
  );
}

function Rules() {
  return (
    <div className={cn(card, "p-5")}>
      <p className="text-[11px] uppercase tracking-wider text-white/40 font-medium mb-2">How it counts</p>
      <ul className="space-y-1.5 text-[12px] text-white/50 leading-relaxed list-disc pl-4">
        <li>Videos exported from Vybe <b className="text-white/70 font-semibold">with the watermark</b>, posted through Vybe to a connected TikTok, YouTube, Instagram or X account.</li>
        <li>Views come straight from each platform and refresh every few hours for 45 days after posting.</li>
        <li>A video counts toward the month and year it was published (UTC).</li>
        <li>Downloading a clip and uploading it yourself isn’t tracked, so post from Vybe to count.</li>
      </ul>
    </div>
  );
}

const PLATFORM: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube", instagram: "Instagram", twitter: "X" };

function MyVideos({ videos, period }: { videos: MyVideo[]; period: string }) {
  if (videos.length === 0) return null;
  return (
    <section className={cn(card, "mt-4 p-5 sm:p-6")}>
      <h2 className="text-[15px] font-semibold text-white/90 flex items-center gap-2 mb-3"><Film size={15} className="text-violet-300" /> Your videos · {period}</h2>
      <ul className="divide-y divide-white/[0.05]">
        {videos.map((v) => (
          <li key={v.id} className="py-2.5 flex items-center gap-3 text-[13px]">
            {v.eligible
              ? <Check size={14} className="text-emerald-300 flex-shrink-0" aria-label="Counts" />
              : <X size={14} className="text-white/25 flex-shrink-0" aria-label="Doesn't count" />}
            <div className="min-w-0 flex-1">
              <p className={cn("truncate", v.eligible ? "text-white/80" : "text-white/40")}>{v.title || "Untitled"}</p>
              <p className="text-[11px] text-white/35">
                {PLATFORM[v.platform] ?? v.platform} · {new Date(v.publishedAt).toLocaleDateString()}
                {!v.eligible && " · no Vybe watermark, doesn’t count"}
              </p>
            </div>
            <span className={cn("tabular-nums", v.eligible ? "text-white/85" : "text-white/35")}>{compact(v.views)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
