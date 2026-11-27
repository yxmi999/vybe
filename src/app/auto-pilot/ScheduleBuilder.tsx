"use client";
// Auto-Pilot schedule builder: four numbered steps (Source → Schedule → Look →
// Publish) beside a live 9:16 preview of what every produced clip will look
// like — framed on the creator's latest stream thumbnail, with the real
// caption fonts. Brings the clip editor's features to automation: copy-a-
// style AI edits, split screen (facecam on top), animated auto-subtitles,
// the bundled fonts, and revenue campaigns.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Loader2, X, Plus, Check, Sparkles, ShieldAlert, AlertCircle, ChevronDown, Wand2, Copy,
  Tv, CalendarClock, Palette, Send, Type as TypeIcon, LayoutGrid, Eye, DollarSign, Radio,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import Worker from "@/components/icons/Worker";
import {
  FONT_KEYS, TEXT_FONTS, COLOR_FILTERS, COLOR_FILTER_KEYS, ASPECTS, outputDims, defaultSplit, WATERMARK,
  type AspectKey, type ColorFilterKey, type SplitConfig, type TextStyle,
} from "@/lib/clip-filters";
import { DEFAULT_SUBTITLES, parsePilotTemplate, type PilotSubtitles, type PilotTemplate } from "@/lib/auto-pilot-template";
import { useStyles, CopyStyleModal, StyleThumb, type StyleOption } from "@/app/clips/StyleStudio";
import { fontCss, textStyleCss } from "@/app/clips/editor-ui";
import { SplitStage, SplitControls } from "@/app/clips/SplitScreen";
import { cn } from "@/lib/utils";
import {
  DAY_SHORT, DAY_FULL, parseJson, scheduleText,
  type Account, type CampaignOption, type ChannelInfo, type Pilot,
} from "./types";

const inputCls =
  "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/85 outline-none focus:border-violet-500/50 focus:bg-white/[0.06] transition-colors placeholder:text-white/20";
const chip = (on: boolean) => cn(
  "rounded-lg text-xs font-medium border transition-colors",
  on ? "bg-violet-600/15 border-violet-500/40 text-white" : "border-white/[0.08] text-white/50 hover:text-white/80 hover:border-white/[0.15]",
);
const COLORS = ["FFFFFF", "FFE000", "000000", "FF3B30", "34C759", "32ADE6", "FF2D92", "AF7BFF"];
const ASPECT_CHOICES: AspectKey[] = ["9:16", "1:1", "4:5", "16:9", "original"];
const SUB_STYLES: { k: PilotSubtitles["style"]; label: string; hint: string }[] = [
  { k: "karaoke", label: "Karaoke", hint: "Phrase + highlighted word" },
  { k: "word", label: "Word pop", hint: "One big word at a time" },
  { k: "classic", label: "Classic", hint: "Plain lines" },
];

// ── Small building blocks ───────────────────────────────────────────────────
function Step({ n, icon: Icon, title, hint, children, done }: {
  n: number; icon: React.ElementType; title: string; hint?: string; children: React.ReactNode; done?: boolean;
}) {
  return (
    <section className="relative rounded-2xl border border-white/[0.07] bg-d0f p-4 sm:p-5">
      <header className="flex items-center gap-3 mb-4">
        <span className={cn(
          "flex items-center justify-center w-7 h-7 rounded-full text-[12px] font-bold border flex-shrink-0",
          done ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300" : "bg-violet-600/15 border-violet-500/30 text-violet-200",
        )}>
          {done ? <Check size={13} /> : n}
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-white/90 flex items-center gap-2"><Icon size={14} className="text-white/35" /> {title}</h3>
          {hint && <p className="text-[11px] text-white/35 mt-0.5">{hint}</p>}
        </div>
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Label({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-[12px] font-medium text-white/60">{children}</span>
      {aside}
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className="w-full flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors">
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-white/80">{label}</span>
        {hint && <span className="block text-[11px] text-white/30">{hint}</span>}
      </span>
      <span className={cn("relative w-9 h-5 rounded-full transition-colors shrink-0", on ? "bg-violet-600" : "bg-white/15")}>
        <span className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", on ? "left-[18px]" : "left-0.5")} />
      </span>
    </button>
  );
}

function Range({ label, value, min, max, step = 1, onChange, format }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div>
      <Label aside={<span className="text-[11px] text-violet-300 tabular-nums">{format ? format(value) : value}</span>}>{label}</Label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-violet-500" aria-label={label} />
    </div>
  );
}

// Debounced Twitch channel lookup for the Source step + preview backdrop.
function useChannel(login: string) {
  const [info, setInfo] = useState<ChannelInfo | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    const q = login.trim();
    if (q.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      setState("loading");
      fetch(`/api/auto-pilot/channel?login=${encodeURIComponent(q)}`)
        .then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
        .then(({ ok, d }) => {
          if (!alive) return;
          if (ok) { setInfo(d as ChannelInfo); setState("ok"); setError(""); }
          else { setInfo(null); setState("error"); setError(d.error ?? "Channel not found"); }
        })
        .catch(() => { if (alive) { setState("error"); setError("Couldn't reach Twitch"); } });
    }, 550);
    return () => { alive = false; clearTimeout(t); };
  }, [login]);
  const active = login.trim().length >= 2;
  return { info: active ? info : null, state: active ? state : "idle", error };
}

// Whether this user's exports carry the brand watermark (free plan, or paid
// with "keep the watermark"). Server-decided; the preview just mirrors it.
function useWatermark(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/clips/usage").then((r) => (r.ok ? r.json() : null))
      .then((d: { watermark?: boolean } | null) => { if (alive) setOn(!!d?.watermark); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return on;
}

// The burned-in watermark, drawn with the same geometry as watermarkGraph()
// (clip-filters.ts) scaled to the preview: "Vybe." top-left at 5% height with
// the "clipped & edited" tagline under it.
function WatermarkOverlay({ W, outW, outH }: { W: number; outW: number; outH: number }) {
  const M = WATERMARK;
  // Output px → preview px, times watermarkGraph's own unit (1.0 at a 1080 short side).
  const k = (W / outW) * (Math.min(outW, outH) / 1080);
  const size = M.size * k;
  const baseline = (outH * M.topPct) * (W / outW) + size * 0.95;
  const shadow = `${M.shadow * k}px ${M.shadow * k}px 0 rgba(0,0,0,${M.shadowAlpha})`;
  const font = "var(--font-brand), ui-sans-serif, system-ui, sans-serif";
  return (
    <div className="absolute inset-0 pointer-events-none select-none" aria-hidden>
      <span className="absolute font-bold leading-none whitespace-nowrap"
        style={{ left: M.x * k, top: baseline - size * 0.8, fontSize: size, fontFamily: font, color: `rgba(255,255,255,${M.wordAlpha})`, textShadow: shadow }}>
        Vybe<span style={{ color: `rgba(62,166,230,${M.dotAlpha})` }}>.</span>
      </span>
      <span className="absolute font-bold leading-none whitespace-nowrap"
        style={{ left: (M.x + 2) * k, top: baseline + M.tagGap * k, fontSize: M.tagSize * k, fontFamily: font, color: `rgba(255,255,255,${M.tagAlpha})`, textShadow: shadow }}>
        clipped &amp; edited
      </span>
    </div>
  );
}

// ── Live preview ────────────────────────────────────────────────────────────
function LivePreview({ thumb, aspect, fill, split, caption, textStyle, subtitles, filterCss, styleName, watermark, onSplit }: {
  thumb: string; aspect: AspectKey; fill: "crop" | "blur" | "split"; split: SplitConfig;
  caption: string; textStyle: TextStyle; subtitles: PilotSubtitles; filterCss: string;
  styleName: string | null; watermark: boolean; onSplit: (s: SplitConfig) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [, force] = useState(0);
  const ar = aspect === "original" ? 16 / 9 : ASPECTS[aspect].ar!;
  const W = ar < 1 ? 230 : 300;
  const H = Math.round(W / ar);
  const out = outputDims(aspect, 1280, 720);
  const isSplit = fill === "split" && aspect !== "original";
  // Text sizes scale with the preview so it reads like the real 1080-wide frame.
  const subSize = Math.max(9, Math.round((H / 24) * 1.15 * subtitles.size));
  const capSize = Math.max(10, Math.round((H / 24) * 1.2));
  const hl = `#${subtitles.highlight}`;

  return (
    <div className="space-y-3">
      <div className="mx-auto relative overflow-hidden rounded-[22px] border-[5px] border-d1d bg-black shadow-2xl shadow-black/60"
        style={{ width: W + 10, height: H + 10 }}>
        <div className="relative overflow-hidden" style={{ width: W, height: H }}>
          {/* Hidden source image for the split canvas (cross-origin draw is display-only). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {thumb && <img ref={imgRef} src={thumb} alt="" className="hidden" onLoad={() => force((n) => n + 1)} />}
          {!thumb ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-violet-900/30 to-black text-white/25">
              <Tv size={22} />
              <span className="text-[10px] px-6 text-center">Enter a channel to preview on their latest stream</span>
            </div>
          ) : isSplit ? (
            <SplitStage videoRef={imgRef} mediaEls={{ current: {} }} split={split} onChange={onSplit}
              srcW={1280} srcH={720} outW={out.w} outH={out.h} width={W} height={H}
              filter={filterCss} mirror={false} onTap={() => {}} />
          ) : fill === "blur" && aspect !== "original" ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumb} alt="" className="absolute inset-0 w-full h-full object-cover scale-110"
                style={{ filter: `blur(10px) brightness(0.8) ${filterCss}` }} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumb} alt="" className="absolute inset-0 w-full h-full object-contain" style={{ filter: filterCss }} />
            </>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ filter: filterCss }} />
          )}

          {caption && (
            <div className="absolute inset-x-0 flex justify-center pointer-events-none" style={{ top: "13%" }}>
              <span className="text-center max-w-[90%]" style={textStyleCss(textStyle, capSize)}>{caption}</span>
            </div>
          )}
          {subtitles.enabled && (
            <div className="absolute inset-x-0 flex justify-center pointer-events-none" style={{ top: `${subtitles.y}%`, transform: "translateY(-50%)" }}>
              <span className="text-center max-w-[90%]" style={textStyleCss(textStyle, subSize)}>
                {subtitles.style === "word" ? (
                  <span style={{ color: hl }}>INSANE{subtitles.emoji ? " 🔥" : ""}</span>
                ) : subtitles.style === "karaoke" ? (
                  <>no way that was <span style={{ color: hl }}>insane</span>{subtitles.emoji ? " 🔥" : ""}</>
                ) : "no way that was insane"}
              </span>
            </div>
          )}
          {watermark && thumb && <WatermarkOverlay W={W} outW={out.w} outH={out.h} />}
          {styleName && (
            <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 backdrop-blur px-2 py-0.5 text-[9px] font-semibold text-violet-200 border border-violet-500/30">
              <Wand2 size={9} /> {styleName}
            </span>
          )}
        </div>
      </div>
      {isSplit && <p className="text-center text-[10px] text-white/30">Drag inside a screen to reframe it</p>}
    </div>
  );
}

// ── Builder ─────────────────────────────────────────────────────────────────
export default function ScheduleBuilder({ ytAccounts, campaigns, maxClipsPerRun, editPilot, onCancel, onSaved }: {
  ytAccounts: Account[]; campaigns: CampaignOption[]; maxClipsPerRun: number;
  editPilot?: Pilot; onCancel: () => void; onSaved: () => void;
}) {
  const isEdit = !!editPilot;
  const [tpl] = useState<PilotTemplate>(() => parsePilotTemplate(editPilot?.template));

  // 1 · Source
  const [channel, setChannel] = useState(editPilot?.channel ?? "");
  const [clipsPerRun, setClipsPerRun] = useState(editPilot?.clipsPerRun ?? Math.min(3, maxClipsPerRun));
  const ch = useChannel(channel);
  const watermark = useWatermark();
  const thumb = ch.info?.vods[0]?.thumbnail ?? "";

  // 2 · Schedule — or Live mode (clip while they stream)
  const [liveMode, setLiveMode] = useState(!!editPilot?.liveMode);
  const [cadence, setCadence] = useState<"daily" | "weekly" | "specific_days">((editPilot?.cadence as "daily") ?? "daily");
  const [days, setDays] = useState<number[]>(parseJson(editPilot?.days, [1, 3, 5]));
  const [postTimes, setPostTimes] = useState<string[]>(parseJson(editPilot?.postTimes, ["18:00"]));

  // 3 · Look
  const styles = useStyles();
  const [styleRef, setStyleRef] = useState(tpl.styleRef ?? "");
  const [copyOpen, setCopyOpen] = useState(false);
  const [aspect, setAspect] = useState<AspectKey>(tpl.cropAspect ?? "9:16");
  const [fill, setFill] = useState<"crop" | "blur" | "split">(tpl.cropFill ?? "blur");
  const [split, setSplit] = useState<SplitConfig>(tpl.split ?? defaultSplit("facecam"));
  // New pilots default to auto facecam — streamers move/resize their cams.
  const [autoFacecam, setAutoFacecam] = useState(isEdit ? !!tpl.autoFacecam : true);
  const [subtitles, setSubtitles] = useState<PilotSubtitles>(tpl.subtitles ?? { ...DEFAULT_SUBTITLES, enabled: !isEdit });
  const [caption, setCaption] = useState(tpl.caption ?? "");
  const [textStyle, setTextStyle] = useState<TextStyle>(tpl.textStyle ?? { font: "bold", color: "FFFFFF", template: "outline" });
  const [showGrade, setShowGrade] = useState(false);
  const [colorFilter, setColorFilter] = useState<ColorFilterKey>(tpl.colorFilter ?? "none");
  const [brightness, setBrightness] = useState(tpl.brightness ?? 0);
  const [contrast, setContrast] = useState(tpl.contrast ?? 0);
  const [saturation, setSaturation] = useState(tpl.saturation ?? 0);
  const [vignette, setVignette] = useState(!!tpl.vignette);
  const [fades, setFades] = useState(!!(tpl.fadeIn || tpl.fadeOut));
  const [loudnorm, setLoudnorm] = useState(isEdit ? !!tpl.loudnorm : true);
  const [introText, setIntroText] = useState(tpl.introText ?? "");
  const [outroText, setOutroText] = useState(tpl.outroText ?? "");

  // 4 · Publish
  const [targetAccountId, setTargetAccountId] = useState<number | "">(editPilot?.targetAccountId ?? ytAccounts[0]?.id ?? "");
  const [autoPost, setAutoPost] = useState(editPilot?.autoPost ?? false);
  const [minConfidence, setMinConfidence] = useState(editPilot ? (editPilot.minConfidence || 60) : 60);
  const [ack, setAck] = useState(isEdit && !!editPilot?.autoPost);
  const [campaignId, setCampaignId] = useState<number | "">(tpl.campaignId ?? "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const allStyles = [...styles.builtin, ...styles.saved];
  const activeStyle: StyleOption | undefined = allStyles.find((s) => s.ref === styleRef);
  const filterCss = [
    `brightness(${(1 + brightness / 100).toFixed(2)})`,
    `contrast(${(1 + contrast / 100).toFixed(2)})`,
    saturation ? `saturate(${Math.max(0, 1 + saturation / 100).toFixed(2)})` : "",
    COLOR_FILTERS[colorFilter].css,
  ].filter(Boolean).join(" ");
  const fillEff = aspect === "original" ? "crop" : fill;
  const defaultCampaign = campaigns.find((c) => c.isDefault);

  function setTime(i: number, v: string) { setPostTimes((p) => p.map((t, idx) => (idx === i ? v : t))); }

  async function submit() {
    setError("");
    if (!channel.trim()) return setError("Enter the Twitch channel to watch.");
    if (!liveMode && cadence !== "daily" && days.length === 0) return setError("Pick at least one day.");
    if (!targetAccountId) return setError("Pick a YouTube account to post to.");
    if (autoPost && !ack) return setError("Please confirm the auto-post notice.");
    setSaving(true);
    const template: PilotTemplate = { cropAspect: aspect, cropFill: fillEff, textStyle };
    if (fillEff === "split") { template.split = split; if (autoFacecam) template.autoFacecam = true; }
    if (caption.trim()) template.caption = caption.trim();
    if (subtitles.enabled) template.subtitles = subtitles;
    if (colorFilter !== "none") template.colorFilter = colorFilter;
    if (brightness) template.brightness = brightness;
    if (contrast) template.contrast = contrast;
    if (saturation) template.saturation = saturation;
    if (vignette) template.vignette = true;
    if (introText.trim()) template.introText = introText.trim();
    if (outroText.trim()) template.outroText = outroText.trim();
    if (fades) { template.fadeIn = 0.5; template.fadeOut = 0.5; }
    if (loudnorm) template.loudnorm = true;
    if (styleRef) template.styleRef = styleRef;
    if (campaignId) template.campaignId = campaignId;
    const payload = {
      platform: "twitch", channel: channel.trim(), targetAccountId,
      cadence, days, postTimes, clipsPerRun, autoPost, minConfidence: autoPost ? minConfidence : 0, template, liveMode,
      // Post times are the user's local clock; the server converts from this zone.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const res = await fetch(isEdit ? `/api/auto-pilot/${editPilot!.id}` : "/api/auto-pilot", {
      method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(data.error || "Could not save this Auto-Pilot."); return; }
    onSaved();
  }

  return (
    <div className="rounded-3xl border border-violet-500/15 bg-gradient-to-b from-violet-600/[0.05] to-transparent p-3 sm:p-5">
      <div className="flex items-center justify-between px-1 mb-4">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-violet-600/15 border border-violet-500/25">
            <Worker size={18} className="text-violet-300" />
          </span>
          <div>
            <h2 className="text-[16px] font-semibold">{isEdit ? `Edit · ${editPilot!.channel}` : "New Auto-Pilot"}</h2>
            <p className="text-[11px] text-white/35">Every new stream gets clipped, edited in this look, and queued or posted.</p>
          </div>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close builder" className="p-2 rounded-lg text-white/30 hover:text-white/80 hover:bg-white/[0.05]">
          <X size={18} />
        </button>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
        <div className="space-y-4 min-w-0">
          {/* 1 · Source */}
          <Step n={1} icon={Tv} title="Who to clip" hint="Vybe watches this Twitch channel for new streams." done={ch.state === "ok"}>
            <div>
              <Label>Twitch channel</Label>
              <div className="relative">
                <Tv size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="xqc, or a twitch.tv link"
                  className={inputCls + " pl-8 pr-8"} aria-label="Twitch channel" />
                {ch.state === "loading" && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-white/30" />}
              </div>
              {ch.state === "ok" && ch.info && (
                <div className="mt-2 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
                  {ch.info.avatar
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={ch.info.avatar} alt="" className="w-9 h-9 rounded-full" />
                    : <span className="w-9 h-9 rounded-full bg-violet-600/20" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-white/85 truncate">{ch.info.displayName}</p>
                    <p className="text-[11px] text-white/35 truncate">
                      {ch.info.vods[0]
                        ? <>Latest stream {formatDistanceToNow(new Date(ch.info.vods[0].startTime), { addSuffix: true })} · {ch.info.vods[0].title}</>
                        : "No past streams yet — Auto-Pilot will clip the next one."}
                    </p>
                  </div>
                  <Check size={15} className="text-emerald-400 flex-shrink-0" />
                </div>
              )}
              {ch.state === "error" && <p className="mt-1.5 text-[11px] text-amber-300/80 flex items-center gap-1"><AlertCircle size={11} /> {ch.error}</p>}
            </div>
            <Range label="Clips per stream" value={clipsPerRun} min={1} max={maxClipsPerRun} onChange={setClipsPerRun}
              format={(v) => `${v} clip${v === 1 ? "" : "s"} · max ${maxClipsPerRun} on your plan`} />
          </Step>

          {/* 2 · Schedule */}
          <Step n={2} icon={CalendarClock} title="When to clip"
            hint={liveMode ? "While they're live — new moments are clipped every ~10 minutes." : scheduleText(cadence, days, postTimes)}>
            <div className="grid sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Clipping mode">
              {([
                [false, CalendarClock, "After the stream", "Clips the finished stream on your schedule."],
                [true, Radio, "Live mode", "Clips while they're live, ~10–25 min after each moment."],
              ] as const).map(([v, Icon, title, desc]) => (
                <button key={String(v)} type="button" role="radio" aria-checked={liveMode === v} onClick={() => setLiveMode(v)}
                  className={cn("rounded-xl border p-3 text-left transition-colors",
                    liveMode === v ? "border-violet-500/50 bg-violet-600/10" : "border-white/[0.07] hover:border-white/[0.15]")}>
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-white/85">
                    <Icon size={14} className={v ? "text-red-400" : "text-violet-300"} /> {title}
                    {v && <span className="text-[9px] font-bold uppercase tracking-wider rounded px-1 py-px bg-red-500/15 text-red-300 border border-red-500/25">New</span>}
                  </span>
                  <span className="block text-[11px] text-white/35 mt-0.5">{desc}</span>
                </button>
              ))}
            </div>
            {liveMode ? (
              <div className="rounded-xl border border-red-500/15 bg-red-500/[0.03] p-3 space-y-1.5 text-[11px] text-white/45 leading-relaxed">
                <p className="flex items-start gap-1.5"><Radio size={12} className="text-red-400 mt-px flex-shrink-0" />
                  Vybe checks the channel every ~10 minutes. While they&apos;re live it scans the newest part of the stream and clips only real spikes — chat blowing up vs. the stream so far, or chat asking to clip.</p>
                <p>Up to <span className="text-white/70 font-medium">{clipsPerRun}</span> clip{clipsPerRun === 1 ? "" : "s"} per stream (spread across it). Auto-posted live clips go out right away instead of at set times.</p>
                <p className="text-white/30">Needs the streamer&apos;s VODs to be public — Twitch only exposes a live stream through its in-progress VOD.</p>
              </div>
            ) : (<>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="How often">
              {([["daily", "Every day"], ["weekly", "Weekly"], ["specific_days", "Pick days"]] as const).map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={cadence === v} onClick={() => setCadence(v)} className={cn(chip(cadence === v), "py-2")}>{l}</button>
              ))}
            </div>
            {cadence !== "daily" && (
              <div className="flex gap-1.5">
                {DAY_SHORT.map((d, i) => (
                  <button key={i} type="button" title={DAY_FULL[i]} aria-label={DAY_FULL[i]} aria-pressed={days.includes(i)}
                    onClick={() => setDays((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort()))}
                    className={cn(chip(days.includes(i)), "w-9 h-9")}>{d}</button>
                ))}
              </div>
            )}
            <div>
              <Label>Post clips at</Label>
              <div className="flex flex-wrap gap-2">
                {postTimes.map((t, i) => (
                  <div key={i} className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] pl-2">
                    <input type="time" value={t} onChange={(e) => setTime(i, e.target.value)} aria-label={`Post time ${i + 1}`}
                      className="bg-transparent text-sm text-white/85 py-1.5 outline-none [color-scheme:dark]" />
                    <button type="button" disabled={postTimes.length === 1} aria-label="Remove time"
                      onClick={() => setPostTimes((p) => p.filter((_, idx) => idx !== i))}
                      className="p-1.5 text-white/25 hover:text-red-400 disabled:opacity-0"><X size={13} /></button>
                  </div>
                ))}
                {postTimes.length < 6 && (
                  <button type="button" onClick={() => setPostTimes((p) => [...p, "21:00"])}
                    className="flex items-center gap-1 px-3 rounded-lg border border-dashed border-white/[0.12] text-white/45 hover:text-white/80 text-xs">
                    <Plus size={13} /> Add time
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-white/25">Times are in your local timezone. Several clips from one stream go out at the next free slots.</p>
            </div>
            </>)}
          </Step>

          {/* 3 · Look */}
          <Step n={3} icon={Palette} title="How clips look" hint="Applied to every clip — preview on the right.">
            {/* AI editing style */}
            <div>
              <Label aside={
                <button type="button" onClick={() => setCopyOpen(true)} className="flex items-center gap-1 text-[11px] font-medium text-violet-300 hover:text-violet-200">
                  <Copy size={11} /> Copy a style from a clip
                </button>
              }>AI editing style</Label>
              <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x">
                <button type="button" onClick={() => setStyleRef("")} aria-pressed={!styleRef}
                  className={cn("snap-start flex-shrink-0 w-[92px] rounded-xl border p-2 text-left transition-colors",
                    !styleRef ? "border-violet-500/50 bg-violet-600/10" : "border-white/[0.07] hover:border-white/[0.15]")}>
                  <div className="h-[60px] rounded-md border border-dashed border-white/15 flex items-center justify-center text-white/25"><X size={14} /></div>
                  <p className="mt-1.5 text-[11px] font-medium text-white/75 truncate">No AI edit</p>
                  <p className="text-[9px] text-white/30 truncate">Use the settings below</p>
                </button>
                {allStyles.map((s) => (
                  <button key={s.ref} type="button" onClick={() => setStyleRef(s.ref)} aria-pressed={styleRef === s.ref} title={s.style.summary}
                    className={cn("snap-start flex-shrink-0 w-[92px] rounded-xl border p-2 text-left transition-colors",
                      styleRef === s.ref ? "border-violet-500/50 bg-violet-600/10" : "border-white/[0.07] hover:border-white/[0.15]")}>
                    <div className="h-[60px] flex items-center justify-center"><StyleThumb style={s.style} size={34} /></div>
                    <p className="mt-1.5 text-[11px] font-medium text-white/75 truncate">{s.name}</p>
                    <p className="text-[9px] text-white/30 truncate">{s.builtin ? "Preset" : "Your style"}</p>
                  </button>
                ))}
                <button type="button" onClick={() => setCopyOpen(true)}
                  className="snap-start flex-shrink-0 w-[92px] rounded-xl border border-dashed border-violet-500/30 p-2 text-left hover:bg-violet-500/[0.05] transition-colors">
                  <div className="h-[60px] flex items-center justify-center text-violet-300"><Plus size={18} /></div>
                  <p className="mt-1.5 text-[11px] font-medium text-violet-200 truncate">Copy a style</p>
                  <p className="text-[9px] text-white/30 truncate">From any clip link</p>
                </button>
              </div>
              {activeStyle && (
                <p className="mt-1.5 text-[11px] text-white/35 flex items-start gap-1.5">
                  <Sparkles size={11} className="text-violet-400 mt-px flex-shrink-0" />
                  AI edits each clip in “{activeStyle.name}”: hook-first trim, punch-in zooms, its captions and grade. Split screen and subtitles below still apply.
                </p>
              )}
              <CopyStyleModal open={copyOpen} onClose={() => setCopyOpen(false)} save={styles.save} onSaved={(s) => setStyleRef(s.ref)} />
            </div>

            {/* Format */}
            <div>
              <Label>Format</Label>
              <div className="grid grid-cols-5 gap-1.5">
                {ASPECT_CHOICES.map((k) => (
                  <button key={k} type="button" onClick={() => setAspect(k)} aria-pressed={aspect === k} className={cn(chip(aspect === k), "py-2 flex flex-col items-center")}>
                    <span className="font-mono font-bold text-[11px]">{ASPECTS[k].label}</span>
                    <span className="text-[9px] opacity-60">{ASPECTS[k].sub}</span>
                  </button>
                ))}
              </div>
            </div>
            {aspect !== "original" && (
              <div>
                <Label>Fill the frame with</Label>
                <div className="grid grid-cols-3 gap-1.5">
                  {([
                    ["crop", "Crop in", "Zoom to fill"],
                    ["blur", "Blurred bg", "Whole stream"],
                    ["split", "Split screen", "Facecam + game"],
                  ] as const).map(([v, l, sub]) => (
                    <button key={v} type="button" onClick={() => setFill(v)} aria-pressed={fill === v} className={cn(chip(fill === v), "py-2")}>
                      <span className="flex items-center justify-center gap-1">{v === "split" && <LayoutGrid size={11} />}{l}</span>
                      <span className="block text-[9px] opacity-60">{sub}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {fillEff === "split" && (
              <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <div className="mb-3">
                  <Toggle on={autoFacecam} onChange={setAutoFacecam} label="Auto-detect the facecam on every clip"
                    hint="AI finds the webcam in each clip and frames Screen 1 on it — even if they move it." />
                </div>
                {thumb ? (
                  <SplitThumbControls thumb={thumb} split={split} onChange={setSplit} aspect={aspect} />
                ) : (
                  <p className="text-[11px] text-white/35">Enter a channel above to frame the screens on their stream.</p>
                )}
              </div>
            )}

            {/* Auto subtitles */}
            <div className="rounded-xl border border-white/[0.06] p-3 space-y-3">
              <Toggle on={subtitles.enabled} onChange={(v) => setSubtitles((s) => ({ ...s, enabled: v }))}
                label="Auto subtitles" hint="AI transcribes every clip and burns in animated captions." />
              {subtitles.enabled && (
                <>
                  <div className="grid grid-cols-3 gap-1.5">
                    {SUB_STYLES.map((o) => (
                      <button key={o.k} type="button" onClick={() => setSubtitles((s) => ({ ...s, style: o.k }))} aria-pressed={subtitles.style === o.k}
                        className={cn(chip(subtitles.style === o.k), "py-2")}>
                        {o.label}<span className="block text-[9px] opacity-60">{o.hint}</span>
                      </button>
                    ))}
                  </div>
                  {subtitles.style !== "classic" && (
                    <>
                      <div>
                        <Label>Highlight colour</Label>
                        <div className="flex gap-2">
                          {COLORS.filter((c) => c !== "000000").map((c) => (
                            <button key={c} type="button" aria-label={`Highlight #${c}`} onClick={() => setSubtitles((s) => ({ ...s, highlight: c }))}
                              className={cn("w-6 h-6 rounded-full border-2 transition-transform", subtitles.highlight === c ? "border-white scale-110" : "border-white/15")}
                              style={{ background: `#${c}` }} />
                          ))}
                        </div>
                      </div>
                      <Toggle on={subtitles.emoji} onChange={(v) => setSubtitles((s) => ({ ...s, emoji: v }))} label="Auto emoji" hint="Adds a fitting emoji on punchy words 🔥" />
                    </>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <Range label="Position" value={subtitles.y} min={20} max={90} onChange={(v) => setSubtitles((s) => ({ ...s, y: v }))}
                      format={(v) => (v < 40 ? "Top" : v < 62 ? "Middle" : "Bottom")} />
                    <Range label="Size" value={subtitles.size} min={0.7} max={2} step={0.05} onChange={(v) => setSubtitles((s) => ({ ...s, size: v }))}
                      format={(v) => `${v.toFixed(2)}×`} />
                  </div>
                </>
              )}
            </div>

            {/* Text style */}
            <div>
              <Label>Text style <span className="text-white/25 font-normal">· subtitles & caption</span></Label>
              <div className="grid grid-cols-4 gap-1.5">
                {FONT_KEYS.map((k) => (
                  <button key={k} type="button" onClick={() => setTextStyle((t) => ({ ...t, font: k }))} aria-pressed={textStyle.font === k}
                    className={cn(chip(textStyle.font === k), "py-2 text-[13px]")} style={{ fontFamily: fontCss(k) }}>
                    {TEXT_FONTS[k].label}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="flex gap-1">
                  {(["outline", "box", "shadow", "pop"] as const).map((t) => (
                    <button key={t} type="button" onClick={() => setTextStyle((s) => ({ ...s, template: t }))} aria-pressed={textStyle.template === t}
                      className={cn(chip(textStyle.template === t), "px-2.5 py-1.5 capitalize")}>{t}</button>
                  ))}
                </div>
                <div className="flex gap-1.5 ml-auto">
                  {COLORS.map((c) => (
                    <button key={c} type="button" aria-label={`Text colour #${c}`} onClick={() => setTextStyle((s) => ({ ...s, color: c }))}
                      className={cn("w-6 h-6 rounded-full border-2 transition-transform", textStyle.color === c ? "border-violet-400 scale-110" : "border-white/15")}
                      style={{ background: `#${c}` }} />
                  ))}
                </div>
              </div>
            </div>
            <div>
              <Label>Hook caption <span className="text-white/25 font-normal">· optional, on every clip</span></Label>
              <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={120} placeholder="e.g. HE DID NOT JUST DO THAT 😭" className={inputCls} />
            </div>

            {/* Grade & polish */}
            <div className="rounded-xl border border-white/[0.06] overflow-hidden">
              <button type="button" onClick={() => setShowGrade((v) => !v)} aria-expanded={showGrade}
                className="w-full flex items-center justify-between px-3 py-2.5 text-[13px] font-medium text-white/65 hover:text-white hover:bg-white/[0.02]">
                <span className="flex items-center gap-2"><Wand2 size={13} className="text-violet-400" /> Grade, sound & cards</span>
                <ChevronDown size={15} className={cn("text-white/30 transition-transform", showGrade && "rotate-180")} />
              </button>
              {showGrade && (
                <div className="px-3 pb-3 pt-1 space-y-4 border-t border-white/[0.05]">
                  <div className="flex flex-wrap gap-1.5">
                    {COLOR_FILTER_KEYS.map((k) => (
                      <button key={k} type="button" onClick={() => setColorFilter(k)} aria-pressed={colorFilter === k}
                        className={cn(chip(colorFilter === k), "flex items-center gap-1.5 pl-1.5 pr-2.5 py-1.5")}>
                        <span className="w-4 h-4 rounded bg-gradient-to-br from-violet-400 to-fuchsia-400" style={{ filter: COLOR_FILTERS[k].css || undefined }} />
                        {COLOR_FILTERS[k].label}
                      </button>
                    ))}
                  </div>
                  <div className="grid sm:grid-cols-3 gap-3">
                    <Range label="Brightness" value={brightness} min={-50} max={50} onChange={setBrightness} format={(v) => (v > 0 ? `+${v}` : `${v}`)} />
                    <Range label="Contrast" value={contrast} min={-50} max={50} onChange={setContrast} format={(v) => (v > 0 ? `+${v}` : `${v}`)} />
                    <Range label="Saturation" value={saturation} min={-50} max={50} onChange={setSaturation} format={(v) => (v > 0 ? `+${v}` : `${v}`)} />
                  </div>
                  <div className="grid sm:grid-cols-3 gap-2">
                    <Toggle on={loudnorm} onChange={setLoudnorm} label="Even loudness" hint="Recommended" />
                    <Toggle on={fades} onChange={setFades} label="Fade in/out" />
                    <Toggle on={vignette} onChange={setVignette} label="Vignette" />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div><Label>Intro card</Label><input value={introText} onChange={(e) => setIntroText(e.target.value)} maxLength={60} placeholder="CLIP OF THE DAY" className={inputCls} /></div>
                    <div><Label>Outro card</Label><input value={outroText} onChange={(e) => setOutroText(e.target.value)} maxLength={60} placeholder="Follow for more" className={inputCls} /></div>
                  </div>
                </div>
              )}
            </div>
          </Step>

          {/* 4 · Publish */}
          <Step n={4} icon={Send} title="Where clips go">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>YouTube channel</Label>
                {ytAccounts.length === 0 ? (
                  <Link href="/accounts" className="flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-300 hover:bg-amber-500/10">
                    Connect a YouTube account →
                  </Link>
                ) : (
                  <select value={targetAccountId} onChange={(e) => setTargetAccountId(Number(e.target.value))} className={inputCls} aria-label="YouTube channel">
                    {ytAccounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
                  </select>
                )}
              </div>
              <div>
                <Label aside={<Link href="/analytics" className="text-[11px] text-white/35 hover:text-white/70">Manage</Link>}>
                  <span className="flex items-center gap-1"><DollarSign size={11} /> Campaign</span>
                </Label>
                <select value={campaignId} onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : "")} className={inputCls} aria-label="Campaign">
                  <option value="">{defaultCampaign ? `Default · ${defaultCampaign.name}` : campaigns.length ? "No campaign" : "No campaigns yet"}</option>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.currency} {c.cpm} CPM</option>)}
                </select>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Posting mode">
              {([
                [false, Eye, "Review first", "Clips wait in your review queue. Recommended."],
                [true, Sparkles, "Auto-post", "Strong clips post on schedule with no review."],
              ] as const).map(([v, Icon, title, desc]) => (
                <button key={String(v)} type="button" role="radio" aria-checked={autoPost === v} onClick={() => setAutoPost(v)}
                  className={cn("rounded-xl border p-3 text-left transition-colors",
                    autoPost === v ? "border-violet-500/50 bg-violet-600/10" : "border-white/[0.07] hover:border-white/[0.15]")}>
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-white/85"><Icon size={14} className={v ? "text-violet-300" : "text-emerald-300"} /> {title}</span>
                  <span className="block text-[11px] text-white/35 mt-0.5">{desc}</span>
                </button>
              ))}
            </div>
            {autoPost && (
              <div className="space-y-3 rounded-xl border border-amber-500/15 bg-amber-500/[0.03] p-3">
                <Range label="Only auto-post clips above" value={minConfidence} min={0} max={100} onChange={setMinConfidence} format={(v) => `${v}% confidence`} />
                <p className="text-[11px] text-white/30 -mt-1">Weaker clips fall back to the review queue. A clip must also be a real chat spike and pass the AI virality check.</p>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 accent-violet-500" />
                  <span className="text-[12px] text-amber-200/80 flex items-start gap-1.5">
                    <ShieldAlert size={14} className="text-amber-400 mt-px shrink-0" />
                    I understand clips will post to my channel automatically, and I&apos;m responsible for what goes out.
                  </span>
                </label>
              </div>
            )}
          </Step>
        </div>

        {/* Live preview (sticky on desktop) */}
        <aside className="lg:sticky lg:top-6 space-y-3">
          <div className="rounded-2xl border border-white/[0.07] bg-d0c p-4">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-white/35 mb-3 flex items-center gap-1.5"><Eye size={11} /> Live preview</p>
            <LivePreview thumb={thumb} aspect={aspect} fill={fillEff} split={split} onSplit={setSplit}
              caption={caption} textStyle={textStyle} subtitles={subtitles} filterCss={filterCss}
              styleName={activeStyle?.name ?? null} watermark={watermark} />
            <div className="mt-4 flex flex-wrap gap-1.5 justify-center">
              {[
                liveMode ? "Live mode" : scheduleText(cadence, days, postTimes),
                `${clipsPerRun} clip${clipsPerRun === 1 ? "" : "s"} / stream`,
                autoPost ? `Auto-post ≥${minConfidence}%` : "Review first",
                ...(subtitles.enabled ? [`${SUB_STYLES.find((s) => s.k === subtitles.style)?.label} subtitles`] : []),
                ...(fillEff === "split" ? ["Split screen"] : []),
              ].map((t) => (
                <span key={t} className="rounded-full bg-white/[0.05] border border-white/[0.07] px-2 py-0.5 text-[10px] text-white/55">{t}</span>
              ))}
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300 flex items-start gap-1.5" role="alert">
              <AlertCircle size={13} className="mt-px flex-shrink-0" /> {error}
            </p>
          )}
          <button type="button" onClick={submit} disabled={saving || ytAccounts.length === 0}
            className="w-full flex items-center justify-center gap-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-colors shadow-[0_0_24px_rgba(51,92,186,0.3)]">
            {saving ? <Loader2 size={15} className="animate-spin" /> : isEdit ? <Check size={15} /> : <Worker size={16} />}
            {saving ? "Saving…" : isEdit ? "Save changes" : "Launch Auto-Pilot"}
          </button>
          <button type="button" onClick={onCancel} className="w-full py-2 rounded-xl text-sm text-white/45 hover:text-white/80">Cancel</button>
        </aside>
      </div>
    </div>
  );
}

// Split-screen framing on the channel's latest stream thumbnail (no video in
// the builder). Reuses the clip editor's controls with an image source.
function SplitThumbControls({ thumb, split, onChange, aspect }: {
  thumb: string; split: SplitConfig; onChange: (s: SplitConfig) => void; aspect: AspectKey;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const out = outputDims(aspect, 1280, 720);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imgRef} src={thumb} alt="" className="hidden" />
      <SplitControls videoRef={imgRef} mediaEls={{ current: {} }} split={split} onChange={onChange}
        srcW={1280} srcH={720} outW={out.w} outH={out.h} allowMedia={false} frameUrl={thumb} />
      <p className="mt-2 text-[10px] text-white/30 flex items-center gap-1"><TypeIcon size={10} /> Framed on their latest stream — streamers keep their facecam in the same spot, so it carries over to new streams.</p>
    </>
  );
}
