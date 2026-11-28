"use client";
import { useState } from "react";
import { Target, ChevronDown, Check, Loader2 } from "lucide-react";
import {
  VERDICTS, EARLY_HOURS, GOAL_METRICS, isPercentMetric,
  type Verdict, type PerfResult, type Goals, type GoalMetric, type MetricCheck,
} from "@/lib/performance";

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

export const fmtMetric = (m: GoalMetric, n: number) =>
  isPercentMetric(m) ? `${n.toFixed(1)}%` : m === "revenue" ? n.toFixed(2) : fmt(n);
const PLATFORM_METRICS = GOAL_METRICS.filter((g) => !g.campaignOnly);
const metricLabel = (m: GoalMetric) => GOAL_METRICS.find((g) => g.key === m)?.label ?? m;

const PLATFORM_LABEL: Record<string, string> = {
  youtube: "YouTube", instagram: "Instagram", twitter: "X / Twitter", tiktok: "TikTok",
};

// Order the summary reads in: good news first, then what needs attention.
const ORDER: Verdict[] = ["outperformer", "on_target", "below", "under", "early", "no_baseline"];

function checkLine(c: MetricCheck, source: PerfResult["source"]) {
  const bar = source === "baseline" ? "your median" : source === "campaign" ? "campaign goal" : "goal";
  return `${c.met ? "✓" : "✗"} ${metricLabel(c.metric)}: ${fmtMetric(c.metric, c.actual)} / ${fmtMetric(c.metric, c.target)} ${bar}`;
}

/** Small pill showing a video's verdict, with the per-metric math in the tooltip. */
export function VerdictBadge({ result, toQualify }: {
  result: PerfResult | undefined;
  /** Views still needed to reach the campaign's minimum payout, if any. */
  toQualify?: number | null;
}) {
  if (!result) return null;
  const v = VERDICTS[result.verdict];
  const met = result.checks.filter((c) => c.met).length;
  // Several goals → "2/3 goals"; a single bar → how far along it is.
  const detail = result.checks.length > 1
    ? `${met}/${result.checks.length}`
    : result.ratio != null ? `${Math.round(result.ratio * 100)}%` : null;
  const tip = [
    v.hint,
    ...result.checks.map((c) => checkLine(c, result.source)),
    result.engagementVsMedian != null ? `Engagement rate ${result.engagementVsMedian.toFixed(1)}× your usual` : null,
  ].filter(Boolean).join("\n");

  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <span title={tip} className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${v.tone}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
        {v.label}
        {detail && <span className="opacity-70 tabular-nums">{detail}</span>}
      </span>
      {/* Name the missed goals so the reason is visible without hovering. */}
      {result.source !== "baseline" && result.checks.length > 1 && met < result.checks.length && (
        <span className="text-[9px] text-white/30 whitespace-nowrap">
          missed {result.checks.filter((c) => !c.met).map((c) => metricLabel(c.metric).toLowerCase()).join(", ")}
        </span>
      )}
      {toQualify != null && toQualify > 0 && (
        <span className="text-[9px] text-amber-300/70 whitespace-nowrap">{fmt(toQualify)} views to qualify</span>
      )}
    </div>
  );
}

type Draft = Record<string, Partial<Record<GoalMetric, string>>>;

export function GoalCheckPanel({ results, platforms, baselines, goals, onGoalsSaved, filter, onFilter }: {
  results: PerfResult[];
  platforms: string[];
  /** Median of each metric per platform — shown as placeholders. */
  baselines: Record<string, Record<GoalMetric, number>>;
  goals: Goals;
  onGoalsSaved: (g: Goals) => void;
  filter: Verdict | null;
  onFilter: (v: Verdict | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = new Map<Verdict, number>();
  for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  const judged = results.filter((r) => !["early", "no_baseline"].includes(r.verdict)).length;
  const hit = (counts.get("outperformer") ?? 0) + (counts.get("on_target") ?? 0);
  const hitRate = judged > 0 ? Math.round((hit / judged) * 100) : null;
  const goalCount = Object.values(goals).reduce((s, g) => s + Object.keys(g).length, 0);

  function openEditor() {
    if (!open) {
      setDraft(Object.fromEntries(platforms.map((p) => [
        p, Object.fromEntries(PLATFORM_METRICS.map(({ key }) => [key, goals[p]?.[key] ? String(goals[p][key]) : ""])),
      ])));
      setError(null);
    }
    setOpen((v) => !v);
  }

  async function save() {
    setSaving(true);
    setError(null);
    // Accept "12K" / "1.5M" as well as plain numbers — the placeholders use that format.
    const num = (s?: string) => {
      const m = (s ?? "").replace(/[,\s%]/g, "").match(/^(\d*\.?\d+)([kKmM]?)$/);
      if (!m) return 0;
      return Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1);
    };
    const body = Object.fromEntries(Object.entries(draft).map(([p, m]) => [
      p, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, num(v)])),
    ]));
    try {
      const res = await fetch("/api/analytics/goals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error();
      onGoalsSaved(await res.json());
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch {
      setError("Couldn't save goals. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const setField = (p: string, k: GoalMetric, v: string) =>
    setDraft((d) => ({ ...d, [p]: { ...d[p], [k]: v } }));

  return (
    <div className="relative overflow-hidden bg-gradient-to-br from-sky-600/[0.08] via-d12 to-d0e border border-sky-500/20 rounded-2xl mb-4">
      <div className="flex flex-wrap items-center gap-4 p-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-500/25 flex-shrink-0">
          <Target size={18} className="text-sky-300" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wider text-sky-300/70 font-semibold mb-0.5">Goal check</p>
          <p className="text-2xl font-bold text-white/95 tabular-nums leading-tight">
            {hitRate != null ? <>{hitRate}% <span className="text-sm font-medium text-white/40">hit expectations</span></> : "—"}
          </p>
          <p className="text-[11px] text-white/35 mt-0.5">
            {judged > 0
              ? `${hit} of ${judged} settled video${judged === 1 ? "" : "s"} met ${goalCount > 0 ? "their goals" : "your usual views"}. Videos under ${EARLY_HOURS}h old are still growing.`
              : "Each video is compared to your goals, or to your median views on that platform."}
          </p>
        </div>
        <button type="button" onClick={openEditor} aria-expanded={open}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-white/75">
          {goalCount > 0 ? `Goals (${goalCount})` : "Set goals"}
          <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Verdict chips double as a table filter */}
      {results.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-4 -mt-1">
          {ORDER.filter((v) => counts.get(v)).map((v) => {
            const meta = VERDICTS[v];
            const on = filter === v;
            return (
              <button key={v} type="button" title={meta.hint} onClick={() => onFilter(on ? null : v)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors ${
                  on ? meta.tone : "border-white/[0.06] text-white/45 hover:text-white/70 hover:bg-white/[0.04]"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                {meta.label}
                <span className="tabular-nums opacity-70">{counts.get(v)}</span>
              </button>
            );
          })}
          {filter && (
            <button type="button" onClick={() => onFilter(null)} className="px-2.5 py-1 text-[11px] text-white/35 hover:text-white/60">
              Clear filter
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="border-t border-white/[0.06] p-4 bg-black/20 space-y-3">
          <p className="text-[11px] text-white/40 leading-relaxed">
            Targets per video. Fill in only what matters to you. A video hits its target when it meets <span className="text-white/65">every</span> goal
            you set for that platform. With no goals, it&apos;s compared to your median views. Placeholders show your current medians.
            Goals set on a campaign (Manage campaigns) take priority for that campaign&apos;s videos.
          </p>
          {platforms.length === 0 ? (
            <p className="text-xs text-white/30">Publish a video first to set goals.</p>
          ) : (
            <div className="space-y-2.5">
              {platforms.map((p) => (
                <div key={p} className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3">
                  <p className="text-xs font-semibold text-white/65 mb-2">{PLATFORM_LABEL[p] ?? p}</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    {PLATFORM_METRICS.map(({ key, label, unit, hint }) => {
                      const base = baselines[p]?.[key];
                      return (
                        <label key={key} title={hint} className="flex flex-col gap-1 rounded-md bg-black/20 border border-white/[0.05] px-2.5 py-1.5 focus-within:border-sky-500/40">
                          <span className="text-[9px] uppercase tracking-wider text-white/30 font-semibold">{label}</span>
                          <span className="flex items-center gap-1">
                            <input
                              inputMode="decimal"
                              value={draft[p]?.[key] ?? ""}
                              onChange={(e) => setField(p, key, e.target.value)}
                              placeholder={base ? fmtMetric(key, base).replace("%", "") : "—"}
                              aria-label={`${PLATFORM_LABEL[p] ?? p} ${label} goal`}
                              className="min-w-0 w-full bg-transparent text-sm text-white/85 tabular-nums placeholder:text-white/20 outline-none"
                            />
                            {unit && <span className="text-[10px] text-white/30">{unit}</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            {error && <span className="text-[11px] text-rose-300">{error}</span>}
            <button type="button" onClick={save} disabled={saving || platforms.length === 0}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-40">
              {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} /> : null}
              {saved ? "Saved" : "Save goals"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
