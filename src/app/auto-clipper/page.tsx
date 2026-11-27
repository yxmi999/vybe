"use client";
import { useState, useEffect } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import PageHeader from "@/components/PageHeader";
import {
  Wand2, Search, Loader2, Eye, Clock, Film, ArrowRight, ExternalLink, AlertCircle, Trophy,
  MessageSquare, Radio, ChevronLeft, Flame, Scissors, CalendarPlus, Check, CalendarDays,
  PlayCircle, X,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { parseJsonResponse } from "@/lib/utils";
import { useStyles, CopyStyleModal, StyleThumb, StyleTags } from "@/app/clips/StyleStudio";

type Clip = {
  id: string;
  url: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  creator_name: string;
};
type ChannelInfo = { id?: number | string; login: string; displayName: string; avatar: string };
type Vod = {
  uuid: string;
  title: string;
  startTime: string;
  durationSec: number;
  views: number;
  thumbnail: string;
};
type Account = { id: number; platform: string; username: string; isActive: boolean };
type Moment = {
  rank: number;
  t: number;
  score: number;
  msgsPer5?: number;          // chat rate (Kick/Twitch, or YouTube chat fallback)
  sampleMessages?: string[];  // example chat lines
  clipRequested?: boolean;    // chat explicitly asked to clip this moment (!clip / "clip it")
  intensity?: number;                  // % of the hottest moment (heatmap or loudness)
  kind?: "replay" | "chat" | "loud";   // which signal produced this moment
  keywordHit?: boolean;        // chat mentioned one of your requested keywords
  keywordMatch?: boolean;      // transcript-confirmed: a keyword was actually said
  matchedKeywords?: string[];  // which requested keywords were confirmed
};

// Kick only buckets time as day/week/month/all, so its last option reads
// "All time" (the server maps 90 → all). Twitch takes exact day counts.
const PERIODS: Record<string, { label: string; days: number }[]> = {
  twitch: [
    { label: "24h", days: 1 },
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
  ],
  kick: [
    { label: "24h", days: 1 },
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "All time", days: 90 },
  ],
};
const COUNTS = [5, 10, 20, 50];
// "auto" lets the server pick each clip's length per moment (silence-snapped
// to the natural pause boundaries around the peak) instead of forcing every
// clip in the batch to the same fixed length. "full" skips picking a length at
// all — it cuts the widest window the pipeline supports (5 min) so you trim
// the exact start/end by hand in the editor instead of committing to one up front.
const CLIP_LENGTHS = [30, 60, 90, "auto", "full"] as const;
const FULL_WINDOW_SEC = 300; // hard cap enforced server-side too — see /api/clips/fetch

const PLATFORMS = [
  { id: "kick",    label: "Kick",    ready: true },
  { id: "twitch",  label: "Twitch",  ready: true },
  { id: "youtube", label: "YouTube", ready: true },
  { id: "rumble",  label: "Rumble",  ready: true },
];

const PLATFORM_NAME: Record<string, string> = { kick: "Kick", twitch: "Twitch", youtube: "YouTube", rumble: "Rumble" };

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
function dur(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function durLong(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function hms(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
// YouTube's flat video list sometimes omits the upload date — render nothing
// rather than crash on an Invalid Date.
function ago(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : formatDistanceToNow(d, { addSuffix: true });
}

export default function AutoClipperPage() {
  const [platform, setPlatform] = useState("kick");
  const [mode, setMode] = useState<"top" | "vod">("top");
  const [channel, setChannel] = useState("");
  const [days, setDays] = useState(7);
  const [limit, setLimit] = useState(10);
  const [clipLen, setClipLen] = useState<number | "auto" | "full">("auto");
  const [keywords, setKeywords] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<ChannelInfo | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [searched, setSearched] = useState(false);

  const [vods, setVods] = useState<Vod[]>([]);
  const [selectedVod, setSelectedVod] = useState<Vod | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [momentNote, setMomentNote] = useState("");
  const [analyzing, setAnalyzing] = useState(false);

  // ── Preview modal: cut the moment's window server-side and play it back
  //    before committing to opening the (separate-tab) editor. ──
  const [previewMoment, setPreviewMoment] = useState<Moment | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewResult, setPreviewResult] = useState<{
    videoUrl: string; title: string; trimStart?: number; trimEnd?: number;
  } | null>(null);

  // ── "Schedule a week" batch: cut + render the top moments and spread them
  //    across the calendar in one go. ──
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [weekOpen, setWeekOpen] = useState(false);
  const [weekAccountId, setWeekAccountId] = useState<number | null>(null);
  const [weekCount, setWeekCount] = useState(5);
  const [weekStart, setWeekStart] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [weekTime, setWeekTime] = useState("12:00");
  const [weekSchedule, setWeekSchedule] = useState(false); // false = save as drafts
  const [scheduling, setScheduling] = useState(false);
  const [weekResult, setWeekResult] = useState<{ produced: number; failed: number; status: string } | null>(null);
  const [weekError, setWeekError] = useState("");
  // Editing style for the batch ("" = plain crop). Defaults to the streamer preset.
  const styles = useStyles();
  const [weekStyleRef, setWeekStyleRef] = useState("builtin:hype");
  const [copyStyleOpen, setCopyStyleOpen] = useState(false);
  const weekStyle = [...styles.builtin, ...styles.saved].find((s) => s.ref === weekStyleRef) ?? null;

  useEffect(() => {
    fetch("/api/accounts").then((r) => (r.ok ? r.json() : [])).then((data: Account[]) => {
      const active = (Array.isArray(data) ? data : []).filter((a) => a.isActive);
      setAccounts(active);
      setWeekAccountId((id) => id ?? active[0]?.id ?? null);
    }).catch(() => {});
  }, []);

  // Only Kick/Twitch have a "top clips" API. YouTube and Rumble are scan-only,
  // so they're always in VOD mode and the top/VOD toggle is hidden. Rumble has
  // no channel listing either, so it takes a direct video URL.
  const hasTopMode = platform === "kick" || platform === "twitch";
  const isYoutube = platform === "youtube";
  const isRumble = platform === "rumble";
  const scanOnly = isYoutube || isRumble;
  const vodCapable = hasTopMode || scanOnly;
  const vodMode = scanOnly || (vodCapable && mode === "vod");
  const unit = scanOnly ? "video" : "stream";   // singular noun for this platform

  function resetResults() {
    setClips([]); setVods([]); setMoments([]); setMomentNote(""); setSelectedVod(null);
    setInfo(null); setError(""); setSearched(false);
  }

  function switchPlatform(id: string) {
    setPlatform(id);
    setMode(id === "youtube" || id === "rumble" ? "vod" : "top");
    resetResults();
  }

  function switchMode(m: "top" | "vod") {
    if (m === mode) return;
    setMode(m);
    resetResults();
  }

  async function generate(e?: React.FormEvent) {
    e?.preventDefault();
    if (!channel.trim() || loading) return;
    setLoading(true); resetResults();
    try {
      if (vodMode) {
        const res = await fetch(`/api/auto-clipper/${platform}-vods`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: channel.trim() }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error ?? "Failed to load streams");
        setInfo(data.channel);
        setVods(data.vods ?? []);
      } else {
        const res = await fetch(`/api/auto-clipper/${platform}-top`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: channel.trim(), days, limit }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error ?? "Failed to load clips");
        setInfo(data.channel);
        setClips(data.clips ?? []);
      }
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function scanVod(v: Vod) {
    if (analyzing || (platform === "kick" && !info?.id)) return;
    setSelectedVod(v); setMoments([]); setMomentNote(""); setError(""); setAnalyzing(true);
    try {
      const kw = keywords.split(",").map((k) => k.trim()).filter(Boolean);
      const body =
        platform === "twitch" ? { videoId: v.uuid, durationSec: v.durationSec, count: limit, keywords: kw }
        : platform === "youtube" ? { videoId: v.uuid, durationSec: v.durationSec, count: limit, keywords: kw }
        : platform === "rumble" ? { videoUrl: v.uuid, durationSec: v.durationSec, count: limit, keywords: kw }
        : { channelId: info?.id, startTime: v.startTime, durationSec: v.durationSec, count: limit, keywords: kw, vodRef: v.uuid };
      const res = await fetch(`/api/auto-clipper/${platform}-vod-highlights`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error ?? "Failed to scan the VOD");
      setMoments(data.moments ?? []);
      setWeekResult(null); setWeekError(""); setWeekOpen(false);
      setWeekCount(Math.min(5, (data.moments ?? []).length || 5));
      if (data.source === "chat") {
        const coveredMin = Math.round((data.coveredSec ?? 0) / 60);
        setMomentNote(
          data.partial
            ? `No “most replayed” graph yet, so these come from the live chat — and the stream's so busy we could only scan its first ~${coveredMin} min. Re-scan in a day once YouTube publishes the replay graph for the whole video.`
            : "No “most replayed” graph yet, so these moments come from live-chat spikes instead.",
        );
      } else if (data.source === "loudness") {
        setMomentNote("Rumble has no replay graph or chat data, so these are the loudest moments in the audio — laughs, reactions, and big plays.");
      } else {
        setMomentNote("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSelectedVod(null);
    } finally {
      setAnalyzing(false);
    }
  }

  // New tab, so the clip/moment list stays intact behind the editor.
  function openInEditor(url: string) {
    window.open(`/clips?url=${encodeURIComponent(url)}`, "_blank", "noopener");
  }

  // Shared by the preview modal: the window (and, for "Auto", the peak offset
  // so the server can silence-snap it) to cut for a given moment. "Auto" cuts
  // a generous 90s window and asks the server to snap it to the nearest
  // natural pause; "full" just hands back the widest window the pipeline
  // supports (5 min) with no snapping, for a fully manual trim in the editor.
  function momentWindow(m: Moment) {
    const len = clipLen === "auto" ? 90 : clipLen === "full" ? FULL_WINDOW_SEC : clipLen;
    // Chat reacts a beat after the moment (so lead the peak), but a replay peak
    // *is* the moment, so center the window on it instead.
    const lead = m.kind === "replay" ? 0.5 : 0.55;
    const start = Math.max(0, Math.round(m.t - len * lead));
    const peak = clipLen === "auto" ? Math.round(m.t - start) : undefined;
    return { start, len, peak };
  }

  function momentVodUrl(m: Moment): string {
    if (!selectedVod) return "";
    const { start, len, peak } = momentWindow(m);
    const vodUrl =
      platform === "twitch" ? `https://www.twitch.tv/videos/${selectedVod.uuid}`
      : platform === "youtube" ? `https://www.youtube.com/watch?v=${selectedVod.uuid}`
      : platform === "rumble" ? selectedVod.uuid   // already the full Rumble URL
      : `https://kick.com/video/${selectedVod.uuid}`;
    const sep = vodUrl.includes("?") ? "&" : "?";
    const peakParam = peak != null ? `&peak=${peak}` : "";
    return `${vodUrl}${sep}t=${start}&d=${len}${peakParam}`;
  }

  async function openPreview(m: Moment) {
    setPreviewMoment(m);
    setPreviewResult(null);
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/clips/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: momentVodUrl(m) }),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error ?? "Could not cut a preview");
      setPreviewResult({ videoUrl: data.videoUrl, title: data.title, trimStart: data.trimStart, trimEnd: data.trimEnd });
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPreviewLoading(false);
    }
  }

  function closePreview() {
    setPreviewMoment(null); setPreviewResult(null); setPreviewError(""); setPreviewLoading(false);
  }

  // The preview already did the (expensive) server-side cut — hand that exact
  // result straight to the editor via ?gen= so it doesn't get cut a second time.
  function editPreviewed() {
    if (!previewResult) return;
    const params = new URLSearchParams({ gen: previewResult.videoUrl, t: previewResult.title || "Clip" });
    if (previewResult.trimStart != null && previewResult.trimEnd != null) {
      params.set("ts", String(previewResult.trimStart));
      params.set("te", String(previewResult.trimEnd));
    }
    window.open(`/clips?${params.toString()}`, "_blank", "noopener");
    closePreview();
  }

  const weekMax = Math.min(moments.length, 6); // server caps a batch at 6 clips

  // Cut + render the top N moments and queue them across the calendar in one go.
  async function scheduleWeek() {
    if (!selectedVod || scheduling) return;
    if (!weekAccountId) {
      setWeekError("Connect an account first — clips are queued to an account.");
      return;
    }
    setScheduling(true);
    setWeekError("");
    setWeekResult(null);
    try {
      const res = await fetch("/api/auto-clipper/schedule-vod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          vodRef: selectedVod.uuid,
          vodTitle: selectedVod.title,
          accountId: weekAccountId ?? undefined,
          moments: moments.slice(0, Math.min(weekCount, weekMax)).map((m) => ({ t: m.t, kind: m.kind })),
          postTimes: [weekTime],
          startDate: weekStart,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          status: weekSchedule ? "scheduled" : "draft",
          clipLen,
          styleRef: weekStyleRef || null,
        }),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error ?? "Couldn't schedule these clips");
      setWeekResult({ produced: data.produced ?? 0, failed: data.failed ?? 0, status: data.status ?? "draft" });
    } catch (e) {
      setWeekError(e instanceof Error ? e.message : "Couldn't schedule these clips");
    } finally {
      setScheduling(false);
    }
  }

  return (
    <div className="min-h-full bg-d0a text-white">
      <CopyStyleModal open={copyStyleOpen} onClose={() => setCopyStyleOpen(false)} save={styles.save}
        onSaved={(s) => setWeekStyleRef(s.ref)} />
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-8">

        {/* Header */}
        <PageHeader
          eyebrow="Auto-Clipper"
          title="Find your best moments"
          description="Pull a channel's top clips — or scan a stream VOD for clippable moments and queue a week of them."
        />

        {/* Platform tabs */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => p.ready && switchPlatform(p.id)}
              disabled={!p.ready}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                platform === p.id
                  ? "bg-white/[0.08] text-white/85"
                  : p.ready
                    ? "text-white/40 hover:text-white/65 hover:bg-white/[0.04]"
                    : "text-white/20 cursor-not-allowed"
              }`}
            >
              <BrandIcon platform={p.id} size={13} fill={p.ready ? undefined : "currentColor"} className="flex-shrink-0" />
              {p.label}
              {!p.ready && <span className="text-[9px] text-white/20 bg-white/[0.05] px-1.5 py-px rounded-full">soon</span>}
            </button>
          ))}

          {/* Source toggle — Kick and Twitch support scanning full stream VODs */}
          {hasTopMode && (
            <div className="ml-auto flex rounded-lg overflow-hidden border border-white/[0.08]">
              <button type="button" onClick={() => switchMode("top")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  mode === "top" ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                }`}>
                <Trophy size={11} /> Top clips
              </button>
              <button type="button" onClick={() => switchMode("vod")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  mode === "vod" ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                }`}>
                <Radio size={11} /> From VOD
              </button>
            </div>
          )}
        </div>

        {/* Controls */}
        <form onSubmit={generate} className="bg-d12 border border-white/[0.06] rounded-2xl p-4 mb-6">
          <div className="flex items-center gap-2 bg-black/30 border border-white/[0.07] rounded-xl px-3 mb-3 focus-within:border-violet-500/40 transition-colors">
            <Search size={14} className="text-white/25 flex-shrink-0" />
            <input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              placeholder={
                platform === "kick" ? "Kick channel (e.g. xqc or kick.com/xqc)"
                : platform === "youtube" ? "YouTube channel or video URL (e.g. @mkbhd or a youtu.be link)"
                : platform === "rumble" ? "Rumble video URL (e.g. rumble.com/v…-title.html)"
                : "Twitch channel (e.g. xqc or twitch.tv/xqc)"}
              className="flex-1 bg-transparent py-2.5 text-sm text-white/80 placeholder:text-white/25 outline-none"
            />
          </div>

          <div className="flex flex-wrap items-end gap-4">
            {!vodMode && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">Period</p>
                <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                  {(PERIODS[platform] ?? PERIODS.twitch).map((p) => (
                    <button key={p.days} type="button" onClick={() => setDays(p.days)}
                      className={`px-3 py-1.5 text-[11px] font-medium transition-colors ${
                        days === p.days ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                      }`}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">How many</p>
              <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                {COUNTS.map((c) => (
                  <button key={c} type="button" onClick={() => setLimit(c)}
                    className={`px-3 py-1.5 text-[11px] font-medium tabular-nums transition-colors ${
                      limit === c ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                    }`}>
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {vodMode && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">Clip length</p>
                <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                  {CLIP_LENGTHS.map((c) => (
                    <button key={c} type="button" onClick={() => setClipLen(c)}
                      className={`px-3 py-1.5 text-[11px] font-medium tabular-nums transition-colors ${
                        clipLen === c ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                      }`}>
                      {c === "auto" ? "Auto" : c === "full" ? "Full" : `${c}s`}
                    </button>
                  ))}
                </div>
                {clipLen === "auto" && (
                  <p className="text-[9px] text-white/25 leading-relaxed mt-1.5">
                    Each clip&apos;s length is picked per moment, snapped to the nearest natural pause.
                  </p>
                )}
                {clipLen === "full" && (
                  <p className="text-[9px] text-white/25 leading-relaxed mt-1.5">
                    Cuts a wide {FULL_WINDOW_SEC / 60}-min window around the moment — no length is picked for you, trim the exact start/end yourself in the editor.
                  </p>
                )}
              </div>
            )}

            {vodMode && (
              <div className="flex-1 min-w-[200px]">
                <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">Keywords (optional)</p>
                <input
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="e.g. clutch, backflip, giveaway"
                  className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-3 py-1.5 text-[11px] text-white/80 placeholder:text-white/25 outline-none focus:border-violet-500/40 transition-colors"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !channel.trim()}
              className="ml-auto flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors shadow-[0_0_20px_rgba(51,92,186,0.25)] disabled:shadow-none"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
              {loading
                ? (vodMode ? (scanOnly ? "Loading…" : "Loading streams…") : "Finding clips…")
                : (vodMode ? (isRumble ? "Find video" : scanOnly ? "Find videos" : "Find streams") : "Find clips")}
            </button>
          </div>
        </form>

        {error && (
          <div className="flex items-start gap-2 mb-6 px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
            <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Results */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 size={22} className="animate-spin text-violet-400/60" />
            <p className="text-white/30 text-sm">{vodMode ? (scanOnly ? "Loading…" : "Loading recent streams…") : "Pulling the top clips…"}</p>
          </div>
        ) : vodMode && selectedVod ? (
          /* ── VOD mode: scanning / moments for the selected stream ── */
          <>
            <div className="flex items-center gap-3 mb-4">
              <button
                type="button"
                onClick={() => { setSelectedVod(null); setMoments([]); setMomentNote(""); }}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-colors"
              >
                <ChevronLeft size={13} /> Streams
              </button>
              {info?.avatar && <img src={info.avatar} alt="" className="w-8 h-8 rounded-full border border-white/[0.08]" />}
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white/80 truncate">{selectedVod.title}</p>
                <p className="text-[11px] text-white/30">
                  {durLong(selectedVod.durationSec)} {unit}{ago(selectedVod.startTime) && ` · ${ago(selectedVod.startTime)}`}
                </p>
              </div>
            </div>

            {analyzing ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Loader2 size={22} className="animate-spin text-violet-400/60" />
                <p className="text-white/30 text-sm">
                  {isRumble
                    ? "Analyzing the audio for the loudest moments…"
                    : isYoutube
                      ? "Reading the most-replayed graph — or chat replay for a fresh stream…"
                      : "Scanning the chat replay for hype spikes…"}
                </p>
                <p className="text-white/15 text-xs">Long streams can take a minute or two.</p>
              </div>
            ) : moments.length > 0 ? (
              <>
              {momentNote && (
                <div className="flex items-start gap-2 mb-4 px-3.5 py-2.5 bg-violet-500/[0.07] border border-violet-500/20 text-violet-200/80 rounded-xl text-[11px] leading-relaxed">
                  <Flame size={13} className="flex-shrink-0 mt-0.5 text-violet-400/70" />
                  <span>{momentNote}</span>
                </div>
              )}

              {/* ── Schedule a week: batch-render the top moments onto the calendar ── */}
              <div className="mb-4 bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
                <button
                  onClick={() => setWeekOpen((o) => !o)}
                  className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
                >
                  <div className="w-7 h-7 rounded-lg bg-sky-500/15 border border-sky-400/25 flex items-center justify-center flex-shrink-0">
                    <CalendarPlus size={14} className="text-sky-300" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-white/85">Schedule a week of clips</p>
                    <p className="text-[11px] text-white/35">Cut &amp; render the top moments and spread them across your calendar — up to 6 at once.</p>
                  </div>
                  <ChevronLeft size={16} className={`text-white/30 flex-shrink-0 transition-transform ${weekOpen ? "-rotate-90" : "rotate-180"}`} />
                </button>

                {weekOpen && (
                  <div className="px-4 pb-4 pt-1 border-t border-white/[0.06] space-y-3.5">
                    {weekResult ? (
                      <div className="flex items-start gap-2.5 px-3.5 py-3 bg-emerald-500/[0.08] border border-emerald-500/25 rounded-xl">
                        <Check size={15} className="flex-shrink-0 mt-0.5 text-emerald-400" />
                        <div className="text-[12px] text-emerald-100/90 leading-relaxed">
                          <p className="font-semibold">
                            {weekResult.produced} clip{weekResult.produced === 1 ? "" : "s"} {weekResult.status === "scheduled" ? "scheduled" : "saved as drafts"}
                            {weekResult.failed > 0 && <span className="text-emerald-200/60 font-normal"> · {weekResult.failed} failed</span>}
                          </p>
                          <a href="/calendar" className="underline hover:text-white">View them on the calendar →</a>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block">
                            <span className="text-[10px] font-semibold text-white/35 uppercase tracking-wider">How many</span>
                            <select
                              value={Math.min(weekCount, weekMax)}
                              onChange={(e) => setWeekCount(Number(e.target.value))}
                              className="mt-1 w-full bg-d0a border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white/85 focus:border-sky-500/40 outline-none"
                            >
                              {Array.from({ length: weekMax }, (_, i) => i + 1).map((n) => (
                                <option key={n} value={n}>{n} clip{n === 1 ? "" : "s"}</option>
                              ))}
                            </select>
                          </label>
                          <label className="block">
                            <span className="text-[10px] font-semibold text-white/35 uppercase tracking-wider">First clip on</span>
                            <input
                              type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)}
                              className="mt-1 w-full bg-d0a border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white/85 focus:border-sky-500/40 outline-none"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[10px] font-semibold text-white/35 uppercase tracking-wider">Post time (daily)</span>
                            <input
                              type="time" value={weekTime} onChange={(e) => setWeekTime(e.target.value)}
                              className="mt-1 w-full bg-d0a border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white/85 focus:border-sky-500/40 outline-none"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[10px] font-semibold text-white/35 uppercase tracking-wider">Account</span>
                            <select
                              value={weekAccountId ?? ""}
                              onChange={(e) => setWeekAccountId(e.target.value ? Number(e.target.value) : null)}
                              className="mt-1 w-full bg-d0a border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white/85 focus:border-sky-500/40 outline-none"
                            >
                              {accounts.length === 0 && <option value="">No accounts connected</option>}
                              {accounts.map((a) => (
                                <option key={a.id} value={a.id}>{PLATFORM_NAME[a.platform] ?? a.platform} · @{a.username}</option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-white/35 uppercase tracking-wider">Editing style</span>
                            <button type="button" onClick={() => setCopyStyleOpen(true)}
                              className="text-[10px] text-sky-300/80 hover:text-sky-200 transition-colors">
                              + Copy a style from a clip
                            </button>
                          </div>
                          <select
                            value={weekStyleRef}
                            onChange={(e) => setWeekStyleRef(e.target.value)}
                            className="mt-1 w-full bg-d0a border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white/85 focus:border-sky-500/40 outline-none"
                          >
                            <option value="">Plain cut — vertical crop only, no AI edit</option>
                            <optgroup label="Presets">
                              {styles.builtin.map((s) => <option key={s.ref} value={s.ref}>{s.name}</option>)}
                            </optgroup>
                            {styles.saved.length > 0 && (
                              <optgroup label="Your styles">
                                {styles.saved.map((s) => <option key={s.ref} value={s.ref}>{s.name}</option>)}
                              </optgroup>
                            )}
                          </select>
                          {weekStyle ? (
                            <div className="mt-2 flex gap-2.5 items-start">
                              <StyleThumb style={weekStyle.style} size={34} />
                              <div className="space-y-1 min-w-0">
                                <p className="text-[11px] text-white/45 leading-snug">{weekStyle.style.summary}</p>
                                <StyleTags style={weekStyle.style} />
                              </div>
                            </div>
                          ) : (
                            <p className="mt-1.5 text-[10px] text-white/25">Pick a style to have AI edit every clip — hook-first trim, punch-ins on the beats, animated captions and the style&apos;s look.</p>
                          )}
                        </div>

                        <label className="flex items-center gap-2.5 cursor-pointer select-none">
                          <input
                            type="checkbox" checked={weekSchedule} onChange={(e) => setWeekSchedule(e.target.checked)}
                            className="w-4 h-4 accent-sky-500"
                          />
                          <span className="text-[12px] text-white/65">
                            Schedule them to post automatically <span className="text-white/30">(otherwise saved as drafts to review first)</span>
                          </span>
                        </label>

                        {weekError && (
                          <p className="flex items-center gap-1.5 text-[11px] text-red-400/90"><AlertCircle size={12} /> {weekError}</p>
                        )}

                        <button
                          onClick={scheduleWeek} disabled={scheduling || weekMax === 0 || !weekAccountId}
                          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/30 text-sky-100 text-[13px] font-semibold disabled:opacity-50 transition-colors"
                        >
                          {scheduling
                            ? <><Loader2 size={14} className="animate-spin" /> {weekStyle ? "AI-editing" : "Rendering"} {Math.min(weekCount, weekMax)} clips… this can take {weekStyle ? "a few minutes" : "a minute"}</>
                            : <><CalendarDays size={14} /> {weekSchedule ? "Schedule" : "Save"} {Math.min(weekCount, weekMax)} clip{Math.min(weekCount, weekMax) === 1 ? "" : "s"}</>}
                        </button>
                        <p className="text-[10px] text-white/25 leading-relaxed">
                          Each clip is cut at its moment, {weekStyle ? `AI-edited in “${weekStyle.name}”` : "rendered to 9:16"}, and placed one per day from your start date. Open any clip from the calendar to fine-tune before it posts.
                          {clipLen === "full" && " (\"Full\" only applies to the single-clip preview above — batches use Auto-length snapping instead.)"}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {moments.map((m) => (
                  <div key={m.rank} className="bg-d12 border border-white/[0.06] rounded-2xl p-4 hover:border-white/[0.12] transition-colors flex flex-col">
                    <div className="flex items-center gap-2.5 mb-2">
                      {m.rank === 1 ? (
                        <span className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-amber-500/20 text-amber-200 border border-amber-400/30">
                          <Trophy size={9} /> #1
                        </span>
                      ) : (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-white/[0.06] text-white/50">#{m.rank}</span>
                      )}
                      <span className="font-mono text-sm text-white/80 tabular-nums">{hms(m.t)}</span>
                      {m.clipRequested && (
                        <span className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-violet-500/20 text-violet-200 border border-violet-400/30"
                          title="Chat asked to clip this moment (!clip / “clip it”)">
                          <Scissors size={9} /> Chat said clip
                        </span>
                      )}
                      {m.keywordMatch ? (
                        <span className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-200 border border-emerald-400/30"
                          title={m.matchedKeywords?.length ? `Confirmed said: ${m.matchedKeywords.join(", ")}` : "A requested keyword was confirmed spoken here"}>
                          <Search size={9} /> Keyword match
                        </span>
                      ) : m.keywordHit ? (
                        <span className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-white/[0.06] text-white/50 border border-white/[0.08]"
                          title="Chat mentioned a requested keyword">
                          <Search size={9} /> Keyword mentioned
                        </span>
                      ) : null}
                      <span className="ml-auto flex items-center gap-1 text-[11px] text-white/35">
                        <Flame size={11} className="text-violet-400/70" />
                        {m.kind === "replay" ? `${m.intensity ?? 0}% replays`
                          : m.kind === "loud" ? `${m.intensity ?? 0}% volume`
                          : `${(m.msgsPer5 ?? 0) * 12}/min`}
                      </span>
                    </div>
                    {(m.kind === "replay" || m.kind === "loud") ? (
                      <div className="mb-3">
                        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                          <div className="h-full rounded-full bg-violet-500/70" style={{ width: `${m.intensity ?? 0}%` }} />
                        </div>
                        <p className="mt-1.5 text-[11px] text-white/30">{m.kind === "loud" ? "Loudest moment" : "Most-replayed moment"}</p>
                      </div>
                    ) : (m.sampleMessages?.length ?? 0) > 0 ? (
                      <div className="mb-3 space-y-0.5">
                        {m.sampleMessages!.map((msg, i) => (
                          <p key={i} className="flex items-center gap-1.5 text-[11px] text-white/35 truncate">
                            <MessageSquare size={10} className="flex-shrink-0 text-white/20" />
                            <span className="truncate italic">{msg}</span>
                          </p>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-auto flex items-center gap-2">
                      <button
                        onClick={() => openPreview(m)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-white/70 text-xs font-semibold transition-colors"
                      >
                        <PlayCircle size={13} /> Preview
                      </button>
                      <button
                        onClick={() => openInEditor(momentVodUrl(m))}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-200 text-xs font-semibold transition-colors"
                      >
                        <Film size={13} /> Edit <ArrowRight size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              </>
            ) : null}
          </>
        ) : vodMode && vods.length > 0 ? (
          /* ── VOD mode: stream list ── */
          <>
            {info && (
              <div className="flex items-center gap-3 mb-4">
                {info.avatar && <img src={info.avatar} alt="" className="w-8 h-8 rounded-full border border-white/[0.08]" />}
                <div>
                  <p className="text-sm font-semibold text-white/80">{info.displayName}</p>
                  <p className="text-[11px] text-white/30">
                    {isRumble
                      ? "Scan this video's audio for its loudest moments"
                      : `${vods.length} recent ${scanOnly ? "videos" : "streams"} · pick one to scan its ${isYoutube ? "most-replayed graph" : "chat"} for highlights`}
                  </p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {vods.map((v) => (
                <div key={v.uuid} className="group bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden hover:border-white/[0.12] transition-colors flex flex-col">
                  <div className="relative aspect-video bg-black">
                    {v.thumbnail && <img src={v.thumbnail} alt="" className="w-full h-full object-cover" />}
                    <span className="absolute bottom-2 right-2 text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/70 text-white/70 backdrop-blur-sm">{durLong(v.durationSec)}</span>
                  </div>
                  <div className="p-3 flex flex-col flex-1">
                    <p className="text-[13px] font-medium text-white/80 leading-snug line-clamp-2 mb-1.5">{v.title}</p>
                    <div className="flex items-center gap-3 text-[11px] text-white/30 mb-3">
                      {v.views > 0 && <span className="flex items-center gap-1"><Eye size={11} /> {fmt(v.views)}</span>}
                      {ago(v.startTime) && <span className="flex items-center gap-1"><Clock size={11} /> {ago(v.startTime)}</span>}
                    </div>
                    <button
                      onClick={() => scanVod(v)}
                      className="mt-auto flex items-center justify-center gap-1.5 py-2 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-200 text-xs font-semibold transition-colors"
                    >
                      <Flame size={13} /> Scan for highlights <ArrowRight size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : !vodMode && clips.length > 0 ? (
          <>
            {info && (
              <div className="flex items-center gap-3 mb-4">
                {info.avatar && <img src={info.avatar} alt="" className="w-8 h-8 rounded-full border border-white/[0.08]" />}
                <div>
                  <p className="text-sm font-semibold text-white/80">{info.displayName}</p>
                  <p className="text-[11px] text-white/30">Top {clips.length} clips · {(PERIODS[platform] ?? PERIODS.twitch).find((p) => p.days === days)?.label}</p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {clips.map((c, i) => (
                <div key={c.id} className="group bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden hover:border-white/[0.12] transition-colors flex flex-col">
                  {/* Thumbnail */}
                  <div className="relative aspect-video bg-black">
                    {c.thumbnail_url && <img src={c.thumbnail_url} alt="" className="w-full h-full object-cover" />}
                    {i === 0 && (
                      <span className="absolute top-2 left-2 flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-amber-500/20 text-amber-200 border border-amber-400/30 backdrop-blur-sm">
                        <Trophy size={9} /> #1
                      </span>
                    )}
                    {i > 0 && (
                      <span className="absolute top-2 left-2 text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-black/60 text-white/60 backdrop-blur-sm">#{i + 1}</span>
                    )}
                    <span className="absolute bottom-2 right-2 text-[9px] font-mono px-1.5 py-0.5 rounded bg-black/70 text-white/70 backdrop-blur-sm">{dur(c.duration)}</span>
                    <a href={c.url} target="_blank" rel="noopener noreferrer"
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white/50 hover:text-white hover-reveal transition-all backdrop-blur-sm"
                      title={`Watch on ${PLATFORM_NAME[platform] ?? platform}`}>
                      <ExternalLink size={12} />
                    </a>
                  </div>

                  {/* Body */}
                  <div className="p-3 flex flex-col flex-1">
                    <p className="text-[13px] font-medium text-white/80 leading-snug line-clamp-2 mb-1.5">{c.title || "Untitled clip"}</p>
                    <div className="flex items-center gap-3 text-[11px] text-white/30 mb-3">
                      <span className="flex items-center gap-1"><Eye size={11} /> {fmt(c.view_count)}</span>
                      <span className="flex items-center gap-1"><Clock size={11} /> {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</span>
                    </div>
                    <button
                      onClick={() => openInEditor(c.url)}
                      className="mt-auto flex items-center justify-center gap-1.5 py-2 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-200 text-xs font-semibold transition-colors"
                    >
                      <Film size={13} /> Open in editor <ArrowRight size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : searched ? (
          <div className="text-center py-16">
            <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4">
              <Film size={28} className="text-white/15" />
            </div>
            <p className="text-white/30 font-medium text-sm mb-1">
              {vodMode ? (isRumble ? "Video not found" : scanOnly ? "No videos found" : "No recent streams found") : "No clips found"}
            </p>
            <p className="text-white/15 text-xs">
              {vodMode
                ? (isRumble ? "Double-check the Rumble video URL."
                  : isYoutube ? "Check the channel handle, or paste a video URL directly."
                  : "This channel has no VODs available.")
                : "Try a longer period, or check the channel name."}
            </p>
          </div>
        ) : (
          <div className="text-center py-16">
            <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4">
              <Wand2 size={28} className="text-white/15" />
            </div>
            <p className="text-white/30 font-medium text-sm mb-1">
              {vodMode
                ? (isRumble ? "Scan a video for its loudest moments"
                  : isYoutube ? "Scan a video for its most-replayed moments"
                  : "Scan a stream for clippable moments")
                : "Find a channel's best clips"}
            </p>
            <p className="text-white/15 text-xs">
              {vodMode
                ? (isRumble
                    ? "Paste a Rumble video URL — the loudest moments in the audio mark the highlights."
                    : isYoutube
                      ? "Enter a YouTube channel or paste a video URL — the parts viewers rewound to most mark the highlights."
                      : `Enter a ${PLATFORM_NAME[platform] ?? ""} channel and pick a recent stream — chat spikes mark the highlights.`)
                : `Enter a ${PLATFORM_NAME[platform] ?? "Twitch"} channel, pick a period, and how many you want.`}
            </p>
          </div>
        )}
      </div>

      {/* ── Preview modal: cut & play the moment before jumping to the editor ── */}
      {previewMoment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4" onClick={closePreview}>
          <div
            className="w-full max-w-lg bg-d12 border border-white/[0.08] rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
              <PlayCircle size={15} className="text-violet-400/80" />
              <p className="text-[13px] font-semibold text-white/85 flex-1">
                Preview · {hms(previewMoment.t)}
              </p>
              <button onClick={closePreview} className="p-1 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors">
                <X size={15} />
              </button>
            </div>

            <div className="p-4">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center py-14 gap-3">
                  <Loader2 size={20} className="animate-spin text-violet-400/60" />
                  <p className="text-white/30 text-sm">Cutting this moment out of the {unit}…</p>
                </div>
              ) : previewError ? (
                <div className="flex flex-col items-center gap-3 py-6">
                  <div className="flex items-start gap-2 px-3.5 py-2.5 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-[12px]">
                    <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                    <span>{previewError}</span>
                  </div>
                  <button
                    onClick={() => openPreview(previewMoment)}
                    className="px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white/70 text-xs font-semibold transition-colors"
                  >
                    Try again
                  </button>
                </div>
              ) : previewResult ? (
                <>
                  <video
                    key={previewResult.videoUrl}
                    src={previewResult.videoUrl}
                    controls
                    autoPlay
                    className="w-full rounded-xl bg-black max-h-[60vh]"
                  />
                  {previewResult.trimStart != null && previewResult.trimEnd != null && (
                    <p className="mt-2.5 text-[11px] text-violet-200/70 flex items-center gap-1.5">
                      <Flame size={11} className="text-violet-400/70" />
                      Snapped to a natural pause: {dur(previewResult.trimStart)}–{dur(previewResult.trimEnd)} of this window.
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-4">
                    <button
                      onClick={closePreview}
                      className="flex-1 py-2.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white/60 text-[13px] font-semibold transition-colors"
                    >
                      Discard
                    </button>
                    <button
                      onClick={editPreviewed}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[13px] font-semibold transition-colors"
                    >
                      <Film size={14} /> Edit this clip <ArrowRight size={13} />
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
