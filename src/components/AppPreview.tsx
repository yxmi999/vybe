"use client";
import { useEffect, useState } from "react";
import {
  Zap, Calendar, BarChart2, MessageSquare, Scissors, Globe,
  TrendingUp, Clock, Heart, Eye, Trophy, Sparkles,
} from "lucide-react";
import Worker from "@/components/icons/Worker";
import { Monogram } from "@/components/brand/Wordmark";

// Animated, responsive product preview for the landing hero. Auto-cycles between
// a few app screens (and you can click the sidebar to jump), so it reads like
// someone navigating the real app.

const NAV = [
  { icon: TrendingUp,    label: "Dashboard", route: "dashboard", screen: 0 },
  { icon: Calendar,      label: "Calendar",  route: "calendar",  screen: 1 },
  { icon: BarChart2,     label: "Analytics", route: "analytics", screen: 2 },
  { icon: Worker,        label: "Auto-Pilot", route: "auto-pilot", screen: 3 },
  { icon: Scissors,      label: "Clips",     route: "clips" },
  { icon: MessageSquare, label: "Responses", route: "responses" },
  { icon: Globe,         label: "Accounts",  route: "accounts" },
];

export default function AppPreview() {
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setPage((p) => (p + 1) % 4), 3400);
    return () => clearInterval(t);
  }, [paused]);

  const route = NAV.find((n) => n.screen === page)?.route ?? "dashboard";
  const screens = [<DashboardScreen key="d" />, <CalendarScreen key="c" />, <AnalyticsScreen key="a" />, <AutoPilotScreen key="p" />];

  return (
    <div
      className="relative w-full max-w-[820px] mx-auto select-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Glow behind the mock */}
      <div className="absolute inset-0 rounded-2xl bg-violet-600/10 blur-3xl scale-95 -z-10" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] bg-violet-500/5 rounded-full blur-3xl -z-10" />

      {/* Browser chrome */}
      <div className="rounded-2xl border border-white/[0.08] bg-d0e overflow-hidden shadow-[0_40px_120px_rgba(0,0,0,0.7)]">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 border-b border-white/[0.05] bg-d11">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-white/10" />
            <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-white/10" />
            <div className="w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full bg-white/10" />
          </div>
          <div className="flex-1 mx-2 sm:mx-4 bg-white/[0.04] border border-white/[0.06] rounded-md px-3 py-1 text-[10px] sm:text-[11px] text-white/20 font-mono truncate">
            vybecut.com/<span className="text-white/35 transition-all duration-300">{route}</span>
          </div>
        </div>

        {/* App layout */}
        <div className="flex h-[340px] sm:h-[420px]">
          {/* Sidebar — icon-only on mobile, full on sm+ */}
          <div className="w-12 sm:w-[160px] flex-shrink-0 border-r border-white/[0.04] bg-d0c flex flex-col">
            <div className="flex items-center gap-2 px-2 sm:px-4 py-3.5 sm:py-4 border-b border-white/[0.04] justify-center sm:justify-start">
              <Monogram size={24} className="flex-shrink-0" />
            </div>
            <nav className="flex-1 px-1.5 sm:px-2 py-3 space-y-0.5">
              {NAV.map(({ icon: Icon, label, screen }) => {
                const active = screen !== undefined && screen === page;
                const clickable = screen !== undefined;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => clickable && setPage(screen!)}
                    className={`w-full flex items-center gap-2.5 px-2 sm:px-2.5 py-2 rounded-lg text-[11px] font-medium justify-center sm:justify-start transition-colors duration-300
                      ${active ? "bg-violet-500/15 text-violet-300" : "text-white/25 hover:text-white/45"}`}
                  >
                    <Icon size={13} className={active ? "text-violet-400" : ""} />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="px-2 sm:px-3 py-3 border-t border-white/[0.04] hidden sm:block">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-violet-600/30 flex items-center justify-center text-[9px] font-bold text-violet-300">Z</div>
                <div>
                  <div className="text-[10px] text-white/50 font-medium">@yourchannel</div>
                  <div className="text-[8px] text-white/20">Pro plan</div>
                </div>
              </div>
            </div>
          </div>

          {/* Main content — crossfade between screens */}
          <div className="relative flex-1 min-w-0 overflow-hidden bg-d0b">
            {screens.map((Screen, i) => (
              <div
                key={i}
                className={`absolute inset-0 p-3 sm:p-5 transition-all duration-500 ease-out ${
                  page === i ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"
                }`}
              >
                {Screen}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Screens ──────────────────────────────────────────────────────────────────

function DashboardScreen() {
  const posts = [
    { platform: "YT", color: "bg-red-500",   time: "Today 3:00 PM",    title: "Best Gaming Moments #24" },
    { platform: "TT", color: "bg-white/40",  time: "Today 6:00 PM",    title: "Trending sound duet" },
    { platform: "IG", color: "bg-pink-500",  time: "Tomorrow 9:00 AM", title: "Behind the scenes reel" },
  ];
  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs sm:text-sm font-semibold text-white/70">Good morning 👋</div>
          <div className="text-[10px] sm:text-[11px] text-white/25 mt-0.5">4 posts scheduled this week</div>
        </div>
        <div className="flex items-center gap-1.5 bg-violet-600/15 border border-violet-500/25 text-violet-300 text-[9px] sm:text-[10px] font-semibold px-2.5 py-1.5 rounded-lg">
          <Zap size={10} className="fill-violet-400" /> New post
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {[
          { label: "Followers",   value: "48.2K", delta: "+2.4%", glow: "bg-violet-500/20" },
          { label: "Impressions", value: "1.2M",  delta: "+18%",  glow: "bg-sky-500/20" },
          { label: "Scheduled",   value: "12",    delta: "this wk", glow: "bg-emerald-500/20" },
          { label: "Engagement",  value: "4.8%",  delta: "+0.6%", glow: "bg-fuchsia-500/20" },
        ].map(({ label, value, delta, glow }) => (
          <div key={label} className="relative overflow-hidden bg-gradient-to-br from-d16 to-d0e border border-white/[0.05] rounded-xl p-2.5">
            <div className={`absolute -right-3 -top-3 w-10 h-10 rounded-full blur-xl ${glow}`} />
            <div className="relative">
              <div className="text-[9px] text-white/30 mb-1 font-medium">{label}</div>
              <div className="text-sm font-bold text-white/85">{value}</div>
              <div className="text-[8px] text-emerald-400/70 mt-0.5 font-medium">{delta}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="text-[10px] text-white/25 font-semibold tracking-wider uppercase mb-2">Upcoming</div>
      <div className="space-y-1.5">
        {posts.map((p) => (
          <div key={p.title} className="flex items-center gap-3 bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-2">
            <div className="relative flex-shrink-0">
              <div className="w-7 h-7 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-[8px] font-bold text-white/70">{p.platform}</div>
              <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ${p.color} border-2 border-d0b`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-white/55 font-medium truncate">{p.title}</div>
              <div className="flex items-center gap-1 text-[8px] text-white/20 font-mono mt-0.5"><Clock size={7} />{p.time}</div>
            </div>
            <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300/80 border border-sky-500/20 flex-shrink-0">Scheduled</span>
          </div>
        ))}
      </div>
    </>
  );
}

function CalendarScreen() {
  // chips keyed by day-of-month → color
  const chips: Record<number, string[]> = {
    4: ["bg-sky-400"], 9: ["bg-emerald-400", "bg-rose-400"], 12: ["bg-sky-400"],
    15: ["bg-violet-400"], 18: ["bg-emerald-400"], 23: ["bg-sky-400", "bg-violet-400"], 27: ["bg-rose-400"],
  };
  const today = 15;
  const cells = Array.from({ length: 35 }, (_, i) => i - 2); // first 3 cells = trailing prev month
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs sm:text-sm font-semibold text-white/70">June 2026</div>
        <div className="flex items-center gap-1 text-[10px] text-white/30">
          <span className="px-2 py-1 rounded-md bg-white/[0.04]">Today</span>
        </div>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i} className="text-center text-[8px] font-semibold text-white/20 uppercase py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((n, i) => {
          const valid = n >= 1 && n <= 30;
          const isToday = n === today;
          return (
            <div
              key={i}
              className={`aspect-square rounded-md border p-1 flex flex-col ${
                isToday ? "bg-violet-500/[0.07] border-violet-500/30" : valid ? "border-white/[0.04] bg-white/[0.015]" : "border-transparent opacity-30"
              }`}
            >
              <span className={`text-[8px] font-semibold ${isToday ? "text-violet-300" : "text-white/40"}`}>{valid ? n : ""}</span>
              <div className="flex flex-wrap gap-0.5 mt-auto">
                {(chips[n] ?? []).map((c, j) => (
                  <span key={j} className={`h-1 flex-1 min-w-[6px] rounded-full ${c}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function AnalyticsScreen() {
  const rows = [
    { t: "Best Gaming Moments #24", v: 92, n: "12.4K" },
    { t: "Trending sound duet",     v: 64, n: "8.1K" },
    { t: "Behind the scenes reel",  v: 41, n: "5.2K" },
    { t: "Product launch thread",   v: 24, n: "3.0K" },
  ];
  return (
    <>
      <div className="text-xs sm:text-sm font-semibold text-white/70 mb-3">Analytics</div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { label: "Likes",   value: "28.7K", icon: Heart, color: "text-rose-300",    glow: "bg-rose-500/20" },
          { label: "Reach",   value: "1.2M",  icon: Eye,   color: "text-violet-300",  glow: "bg-violet-500/20" },
          { label: "Eng.",    value: "4.8%",  icon: TrendingUp, color: "text-emerald-300", glow: "bg-emerald-500/20" },
        ].map(({ label, value, icon: Icon, color, glow }) => (
          <div key={label} className="relative overflow-hidden bg-gradient-to-br from-d16 to-d0e border border-white/[0.05] rounded-xl p-2.5">
            <div className={`absolute -right-3 -top-3 w-10 h-10 rounded-full blur-xl ${glow}`} />
            <div className="relative">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[8px] uppercase tracking-wider text-white/30 font-semibold">{label}</span>
                <Icon size={11} className={color} />
              </div>
              <div className="text-sm font-bold text-white/85">{value}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 bg-gradient-to-r from-violet-600/[0.12] to-fuchsia-600/[0.05] border border-violet-500/20 rounded-lg px-3 py-2 mb-2.5">
        <Trophy size={13} className="text-amber-300 flex-shrink-0" />
        <span className="text-[10px] text-white/70 truncate flex-1">Top: Best Gaming Moments #24</span>
        <span className="text-[10px] font-bold text-white/85">12.4K</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.t} className="flex items-center gap-2 bg-white/[0.02] border border-white/[0.04] rounded-lg px-3 py-1.5">
            <span className="text-[10px] text-white/50 truncate flex-1">{r.t}</span>
            <div className="h-1.5 w-14 rounded-full bg-white/[0.06] overflow-hidden flex-shrink-0">
              <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-400" style={{ width: `${r.v}%` }} />
            </div>
            <span className="text-[10px] font-semibold text-white/60 w-10 text-right tabular-nums">{r.n}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function AutoPilotScreen() {
  const queue = [
    { t: "He actually clutched the 1v4", score: 94, when: "Posts today 6:00 PM", state: "Queued" },
    { t: "Chat lost it at the jumpscare", score: 88, when: "Posts tomorrow 12:00 PM", state: "Queued" },
    { t: "Speedrun PB on stream", score: 81, when: "Rendering…", state: "Editing" },
  ];
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs sm:text-sm font-semibold text-white/70">Auto-Pilot</div>
          <div className="text-[10px] text-white/25 mt-0.5">Watching 2 creators · style “Streamer Hype”</div>
        </div>
        <span className="flex items-center gap-1 text-[9px] font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live
        </span>
      </div>
      <div className="flex items-center gap-2 bg-gradient-to-r from-violet-600/[0.12] to-fuchsia-600/[0.05] border border-violet-500/20 rounded-lg px-3 py-2 mb-2.5">
        <Sparkles size={12} className="text-violet-300 flex-shrink-0" />
        <span className="text-[10px] text-white/70 truncate flex-1">New VOD found · 5h 41m · 12 moments scored</span>
      </div>
      <div className="space-y-1.5">
        {queue.map((q) => (
          <div key={q.t} className="flex items-center gap-2.5 bg-white/[0.02] border border-white/[0.04] rounded-lg px-2.5 py-2">
            <div className="w-6 h-10 rounded bg-gradient-to-b from-[#2b2140] to-[#0f3b52] border border-white/[0.06] flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-white/60 font-medium truncate">{q.t}</div>
              <div className="flex items-center gap-1 text-[8px] text-white/25 font-mono mt-0.5"><Clock size={7} />{q.when}</div>
            </div>
            <span className="text-[10px] font-bold text-fuchsia-300 tabular-nums">{q.score}</span>
            <span className={`text-[8px] font-medium px-1.5 py-0.5 rounded-full border flex-shrink-0 ${q.state === "Queued" ? "bg-sky-500/15 text-sky-300/80 border-sky-500/20" : "bg-amber-500/15 text-amber-300/80 border-amber-500/20"}`}>{q.state}</span>
          </div>
        ))}
      </div>
    </>
  );
}
