// Auto-Pilot engine — the recurring orchestrator that turns a creator + a
// schedule into posted clips. It chains pieces that already exist:
//   discover newest VOD (twitch-gql) → find best moments (twitch-highlights)
//   → cut each moment (vod-extract) → render with the saved template
//   (clip-render) → drop a post row (review draft or scheduled).
//
// Invoked by the cron route on a cadence, or for a single pilot via run-now.
// Every produced clip is plan-capped and ledgered so cost stays bounded.
import { db, client } from "./db";
import { autoPilots, accounts, posts, campaigns } from "./schema";
import { sanitizePilotTemplate, parsePilotTemplate, type PilotTemplate } from "./auto-pilot-template";
import { generateSubtitles } from "./subtitle-generation";
import { pickCaptionEmojis } from "./caption-emojis";
import type { Subtitle } from "./timeline";
import { detectFacecamInVideo, facecamAvailable } from "./facecam";
import { outputDims, fitSplitToFacecam, panelForGameplay, splitCropRect, splitSlots } from "./clip-filters";
import { eq, and, lte, or, isNull } from "drizzle-orm";
import { getArchiveVods, getLiveStatus, parseTwitchLogin } from "./twitch-gql";
import { scanTwitchVodHighlights } from "./twitch-highlights";
import { lift } from "./chat-highlights";
import { extractTwitchVodSection } from "./vod-extract";
import { renderClip, type RenderClipInput } from "./clip-render";
import { resolveStyle } from "./style-store";
import { buildStyledRender } from "./styled-render";
import { getUserPlan, checkAutoClipQuota, cappedClipsPerRun } from "./plan";
import { scoreClipVirality, viralityAvailable, type ViralityResult } from "./virality";
import type { AutoPilot, Account } from "./schema";

// How much of the stream around a detected peak each clip covers.
// Chat reacts to a moment several seconds AFTER it happens, so the cut starts
// well before the chat peak; the AI then trims dead setup off the front.
const SECTION_PAD_BEFORE = 25;   // seconds of build-up before the peak
const SECTION_LENGTH = 60;       // total clip length, seconds
// A single cron invocation has a 300s budget; cap work so one pilot can't hog it.
const MAX_CLIPS_PER_INVOCATION = 6;
// Auto-post floor: a moment must spike to at least this multiple of the VOD's
// normal chat rate to fire unattended. Below it, the clip still gets made but is
// routed to the review queue — this is what stops a quiet stream's "loudest"
// (but unremarkable) moment from being posted on its own.
const MIN_AUTOPOST_LIFT = 2.0;
// Second, independent auto-post gate: the AI watches the cut section (frames +
// audio) and scores its stand-alone short-form potential. Chat spikes prove the
// moment mattered to live viewers; this proves it survives being cut out of
// context. Clips below the floor still get made — they land in the review queue
// with the score attached. Skipped (fail-open) when AI isn't configured/reachable.
const MIN_AUTOPOST_AI_SCORE = 60;
// Hook-aware trimming: only act on AI hook-start suggestions of at least this
// many seconds (smaller ones are noise), and never trim a clip below this length.
const MIN_HOOK_TRIM = 1.5;
const MIN_CLIP_LENGTH = 20;
// Always keep this much after the chat peak (the reaction to the moment).
const PEAK_TAIL = 4;
// How long the AI hook text stays on screen at the start of a clip.
const HOOK_CAPTION_SEC = 3.5;

export type RunResult = {
  pilotId: number;
  produced: number;
  skipped?: string;     // reason if nothing was produced
  error?: string;
  vodId?: string;
};

// ─── Scheduling helpers ──────────────────────────────────────────────────────

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function eligibleDay(date: Date, cadence: string, days: number[]): boolean {
  if (cadence === "daily") return true;
  return days.includes(date.getDay()); // weekly / specific_days
}

/** Next datetime the engine should scan this pilot again (the watcher interval). */
export function nextScanAt(from: Date, cadence: string, days: number[], postTimes: string[]): string {
  const [h, m] = (postTimes[0] ?? "12:00").split(":").map(Number);
  for (let i = 1; i <= 14; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h || 0, m || 0, 0, 0);
    if (eligibleDay(d, cadence, days)) return d.toISOString();
  }
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.toISOString();
}

/** Upcoming release slots for `count` produced clips, at the user's post times. */
export function slotsForClips(from: Date, count: number, postTimes: string[]): string[] {
  const times = postTimes.length ? postTimes : ["12:00"];
  const out: string[] = [];
  for (let day = 0; day <= 30 && out.length < count; day++) {
    for (const t of times) {
      if (out.length >= count) break;
      const [h, m] = t.split(":").map(Number);
      const d = new Date(from);
      d.setDate(d.getDate() + day);
      d.setHours(h || 0, m || 0, 0, 0);
      if (d.getTime() > from.getTime()) out.push(d.toISOString());
    }
  }
  while (out.length < count) {
    const base = out.length ? new Date(out[out.length - 1]) : new Date(from);
    base.setHours(base.getHours() + 1);
    out.push(base.toISOString());
  }
  return out;
}

// ─── Core: run one pilot ─────────────────────────────────────────────────────

// Live mode cadence: how often a live-mode pilot re-checks the channel, and
// how the in-progress VOD is consumed.
const LIVE_POLL_MS = 10 * 60_000;        // re-check every 10 min (live or not)
const LIVE_EDGE_MARGIN = 75;             // leave the newest 75s for next pass — a clip needs ~45s after its peak
const LIVE_MIN_WINDOW = 180;             // don't scan less than 3 min of new stream
const LIVE_MAX_WINDOW = 45 * 60;         // catch up at most 45 min per pass
const LIVE_FIRST_LOOKBACK = 20 * 60;     // joining mid-stream: start 20 min back, not from the top
const LIVE_MAX_CLIPS_PER_PASS = 2;       // spread a stream's clips across its length
const LIVE_RELEASE_DELAY_MS = 2 * 60_000; // auto-posted live clips go out ~immediately
// Scheduled mode on marathon / 24-7 streams: clip a still-live broadcast once
// it has run this long, and only when this much of it is new since last time.
const MARATHON_MIN_SEC = 6 * 3600;
const MARATHON_MIN_NEW_SEC = 30 * 60;

type PilotContext = {
  pilot: AutoPilot;
  tmpl: PilotTemplate;
  style: Awaited<ReturnType<typeof resolveStyle>>;
  account: Account | undefined;
  channelName: string;
};

export type ClipJob = {
  vodId: string;
  vodTitle: string;
  moment: { t: number; msgsPer5: number; clipRequested?: boolean };
  confidence: number;      // 0-100
  momentLift: number;      // chat rate vs baseline
  standsOut: boolean;      // genuine spike or chat asked for a clip
  releaseAt: string;       // when to publish if auto-posted
  live?: boolean;          // produced from a live broadcast
  // A cut plan already made for this exact section (e.g. re-rendering a
  // draft after a render fix) — skips the AI call instead of re-spending quota.
  presetAi?: ViralityResult;
};

export async function loadContext(pilot: AutoPilot, channelName: string): Promise<PilotContext> {
  // Re-validated on read too, so templates saved before validation existed
  // can't smuggle arbitrary render options in.
  const tmpl = parsePilotTemplate(pilot.template);
  // A copied/builtin editing style turns each clip into a full AI edit in that
  // style (hook trim, punch-ins, captions). A deleted style falls back to the
  // template's static look rather than failing the run.
  const style = tmpl.styleRef ? await resolveStyle(pilot.userId!, tmpl.styleRef) : null;
  const account = pilot.targetAccountId
    ? (await db.select().from(accounts).where(eq(accounts.id, pilot.targetAccountId)).limit(1))[0]
    : undefined;
  return { pilot, tmpl, style, account, channelName };
}

/**
 * Cut → AI check → (style edit) → subtitles → render → post row, for one
 * moment. Shared by scheduled runs and live passes. Throws on failure; the
 * caller decides whether one bad moment sinks the run.
 */
export async function produceClip(ctx: PilotContext, job: ClipJob): Promise<{ postId: number; url: string; ai: ViralityResult | null; autoPost: boolean }> {
  const { pilot, tmpl, style, account, channelName } = ctx;
  const m = job.moment;
  const start = Math.max(0, m.t - SECTION_PAD_BEFORE);
  const section = await extractTwitchVodSection(job.vodId, start, SECTION_LENGTH, { peakOffset: m.t - start });
  const title = `${channelName} — ${job.vodTitle}`.slice(0, 90);
  const peakInSection = m.t - start;

  // Silence-snapped in/out points (when detected) so the clip opens and
  // closes on a pause instead of mid-word; falls back to the full section.
  const baseStart = section.trimStart ?? 0;
  const baseEnd = section.trimEnd ?? SECTION_LENGTH;

  // AI eye-check BEFORE the render (frames + audio of the raw section): it
  // gates auto-posting, and plans the cut — where the hook starts (dead setup
  // trimmed off the front), where the payoff ends (dead aftermath trimmed off
  // the back), a title for the post and hook text for the video. Fail-open:
  // an AI outage downgrades to the chat-only decision and the untrimmed cut.
  let ai: ViralityResult | null = job.presetAi ?? null;
  if (!ai && viralityAvailable()) {
    ai = await scoreClipVirality({
      videoUrl: section.videoUrl,
      clip: { title, platform: "twitch", duration: baseEnd - baseStart, streamer: channelName },
      trimStart: baseStart,
      trimEnd: baseEnd,
      includeAudio: true,
      planCut: true,
    }).catch((err) => {
      console.error(`[auto-pilot] pilot ${pilot.id} virality scoring failed:`, err instanceof Error ? err.message : err);
      return null;
    });
  }
  // With AI configured, a clip it couldn't watch (quota/outage) goes to the
  // review queue instead of auto-posting: unscored also means un-trimmed and
  // untitled, so it's exactly the clip that most needs a human look. Only a
  // setup with no AI at all keeps the chat-only decision.
  const aiPass = ai === null ? !viralityAvailable() : ai.score >= MIN_AUTOPOST_AI_SCORE;

  // Hook-aware start: open the clip where the AI heard/saw the hook begin,
  // but never cut into the build-up right before the chat peak and always
  // keep a viable clip length. Small suggestions (<1.5s) are noise — skip.
  let clipStart = baseStart;
  if (ai && ai.hookStartSec >= MIN_HOOK_TRIM) {
    clipStart = Math.max(baseStart, Math.min(
      baseStart + ai.hookStartSec,
      peakInSection - 5,
      baseEnd - MIN_CLIP_LENGTH,
    ));
  }
  const hookTrimSec = Math.round((clipStart - baseStart) * 10) / 10;
  // Payoff-aware end: stop once the reaction has landed. Chat reacts AFTER
  // the moment, so the peak itself plus a few seconds is always kept.
  let clipEnd = baseEnd;
  if (ai?.plan && baseStart + ai.plan.endSec < baseEnd - MIN_HOOK_TRIM) {
    clipEnd = Math.min(baseEnd, Math.max(baseStart + ai.plan.endSec, peakInSection + PEAK_TAIL, clipStart + MIN_CLIP_LENGTH));
  }
  const tailTrimSec = Math.round((baseEnd - clipEnd) * 10) / 10;

  // The saved template carries the look (aspect, captions, filters); the
  // source-specific bits (videoUrl, dimensions, trim) come from the cut.
  const { styleRef: _sr, subtitles: subCfg, campaignId: _c, autoFacecam, ...look } = tmpl;
  void _sr; void _c;
  // Auto facecam: find the webcam overlay in this clip (around the peak) and
  // frame screen 1 on it — follows the streamer if their layout changes —
  // and frame the gameplay screen clear of letterbox bars and the cam.
  // Fail-open: keeps the saved framing if detection misses or errors.
  let facecam: "found" | "full_camera" | "none" | null = null;
  if (look.cropFill === "split" && look.split && autoFacecam && facecamAvailable()) {
    // Hint for AI outages: the region the saved cam screen shows today —
    // pixel edge-snapping can confirm the overlay there without the AI.
    const hintOut = outputDims(look.cropAspect ?? "9:16", section.width, section.height);
    const hint = splitCropRect(look.split.panels[0], splitSlots(look.split)[0], hintOut.w, hintOut.h, section.width, section.height);
    const fc = await detectFacecamInVideo(section.videoUrl, Math.max(0, peakInSection), hint).catch((err) => {
      console.error(`[auto-pilot] pilot ${pilot.id} facecam detection failed:`, err instanceof Error ? err.message : err);
      return null;
    });
    if (fc) {
      const out = outputDims(look.cropAspect ?? "9:16", section.width, section.height);
      const layout = look.split.layout;
      facecam = fc.found ? "found" : fc.reason === "full_camera" ? "full_camera" : "none";
      if (fc.found) {
        // Cam screen sized to the cam's shape and framed on all of it; the
        // gameplay screen then framed for its (possibly new) slot size.
        const fitted = fitSplitToFacecam(look.split, fc.box, 0, out.w, out.h, section.width, section.height);
        look.split = {
          ...fitted,
          panels: fitted.panels.map((p, i) => (
            layout === "facecam" && i === 1 ? panelForGameplay(p, fc.content ?? null, fc.box, fitted, 1, out.w, out.h, section.width, section.height)
            : p)),
        };
      } else if (fc.reason === "full_camera") {
        // The whole frame is the camera (just chatting / IRL): a cam screen
        // over a "gameplay" screen would show the same picture twice, or a
        // random corner. One full-height crop is the right layout here.
        look.cropFill = "crop";
        look.split = undefined;
      }
    }
  }
  const isSplit = look.cropFill === "split" && !!look.split;
  let styled: Partial<RenderClipInput> = {};
  let editNotes: string[] | null = null;
  if (style) {
    const r = await buildStyledRender({
      videoUrl: section.videoUrl,
      clip: { title, platform: "twitch", duration: SECTION_LENGTH, streamer: channelName },
      trimStart: clipStart, trimEnd: clipEnd, style,
    });
    styled = r.fields;
    editNotes = r.notes;
  }
  // Split screen is an explicit layout choice — it wins over whatever
  // framing an AI style picked (moving crops/zooms don't apply to it).
  if (isSplit) {
    styled = {
      ...styled,
      cropAspect: look.cropAspect, cropFill: "split", split: look.split,
      cropKeys: [], zoom: 1, zoomKeys: [],
    };
  }

  // The style's planner may only tighten the AI-planned window, never widen
  // it back over trimmed dead air.
  const finalStart = Math.max(clipStart, Math.min(styled.trimStart ?? clipStart, clipEnd - MIN_CLIP_LENGTH));
  const finalEnd = Math.min(clipEnd, Math.max(styled.trimEnd ?? clipEnd, finalStart + MIN_CLIP_LENGTH));
  // The style's keyframes/effects are relative to ITS trim start; re-base
  // them if the clamp above moved the start.
  const drift = finalStart - (styled.trimStart ?? finalStart);
  if (drift !== 0) {
    const tl = (t: number) => Math.max(0, t - drift);
    if (styled.cropKeys) styled.cropKeys = styled.cropKeys.map((k) => ({ ...k, time: tl(k.time) }));
    if (styled.zoomKeys) styled.zoomKeys = styled.zoomKeys.map((k) => ({ ...k, time: tl(k.time) }));
    if (styled.effects) styled.effects = (styled.effects as { start: number; end: number }[]).map((x) => ({ ...x, start: tl(x.start), end: tl(x.end) }));
    if (styled.volumeKeys) styled.volumeKeys = (styled.volumeKeys as { time: number }[]).map((k) => ({ ...k, time: tl(k.time) }));
  }

  // Subtitles: the pilot's own caption settings are the user's explicit
  // choice for this schedule, so they win over a style's (an AI style with
  // captions only decides when the template has none). Fail-open: a
  // transcription hiccup ships the clip without subtitles.
  let subtitleFields: Partial<RenderClipInput> = {};
  if (subCfg?.enabled) {
    delete styled.subtitles;
    const subs = await templateSubtitles(section.videoUrl, finalStart, finalEnd, subCfg.language, subCfg.emoji && subCfg.style !== "classic")
      .catch((err) => {
        console.error(`[auto-pilot] pilot ${pilot.id} subtitles failed:`, err instanceof Error ? err.message : err);
        return [] as Subtitle[];
      });
    subtitleFields = subs.length > 0
      ? { subtitles: subs, subtitleStyle: subCfg.style, subtitleHighlight: subCfg.highlight, subtitleX: 50, subtitleY: subCfg.y, subtitleSize: subCfg.size }
      : { subtitles: [] };
  }

  // Hook text over the opening seconds (when the template has no fixed
  // caption of its own): sits on the seam between cam and gameplay in a
  // split, near the top otherwise — clear of the subtitles either way.
  let hookFields: Partial<RenderClipInput> = {};
  const hookText = ai?.plan?.hookCaption ?? "";
  if (hookText && !look.caption) {
    const seam = isSplit && look.split ? splitSlots(look.split)[0].h * 100 : 14;
    hookFields = {
      caption: hookText,
      captionX: 50,
      captionY: Math.round(seam),
      captionSize: 1.15,
      // Caption windows are TIMELINE time (0 = the clip's first frame) to
      // renderClip; 0 means "whole clip", hence the tiny start offset.
      captionStart: 0.01,
      captionEnd: HOOK_CAPTION_SEC,
    };
  }

  const { url } = await renderClip({
    ...look,
    ...styled,
    ...subtitleFields,
    ...hookFields,
    userId: pilot.userId!,
    recordKind: "autopilot",
    countsQuota: true,
    videoUrl: section.videoUrl,
    srcW: section.width,
    srcH: section.height,
    fps: 30,
    duration: SECTION_LENGTH,
    trimStart: finalStart,
    trimEnd: finalEnd,
    title,
  });

  // Decide where it goes: only auto-post when it clears the confidence bar,
  // is a genuine spike over the baseline (lift), AND the AI judges the
  // rendered clip to stand on its own (when available).
  const autoPost = !!pilot.autoPost && job.confidence >= (pilot.minConfidence ?? 0) && job.standsOut && aiPass;
  // Post title: the AI's title for THIS moment; the stream title (the same
  // for every clip of a broadcast, and full of 🔴 spam) is only a fallback.
  const postTitle = (ai?.plan?.title || title).slice(0, 100);
  const [row] = await db.insert(posts).values({
    accountId: pilot.targetAccountId ?? null,
    platform: account?.platform ?? "youtube",
    // Description: the title plus a credit line back to the streamer —
    // clip channels that credit the source get far fewer claims/strikes.
    content: (look.caption as string) || `${postTitle}\n\n🎥 ${channelName} on Twitch — twitch.tv/${parseTwitchLogin(pilot.channel)}`,
    mediaUrls: JSON.stringify([url]),
    metadata: JSON.stringify({
      source: "autopilot",
      autoPilotId: pilot.id,
      confidence: job.confidence,
      lift: Number.isFinite(job.momentLift) ? Math.round(job.momentLift * 10) / 10 : null,
      clipRequested: !!m.clipRequested,
      viralityScore: ai?.score ?? null,
      viralityVerdict: ai?.verdict ?? null,
      hookStrength: ai?.hookStrength ?? null,
      hookTrimSec: hookTrimSec > 0 ? hookTrimSec : null,
      tailTrimSec: tailTrimSec > 0 ? tailTrimSec : null,
      hookCaption: hookFields.caption ?? null,
      facecam,
      clipLength: Math.round((finalEnd - finalStart) * 10) / 10,
      ...(style ? { style: style.name, editNotes } : {}),
      ...(job.live ? { live: true } : {}),
      vodId: job.vodId,
      moment: m.t,
      isShort: true,
      videoTitle: postTitle,
      tags: [channelName, "twitch", "streamer clips"],
      streamTitle: job.vodTitle,
    }),
    scheduledAt: autoPost ? job.releaseAt : new Date().toISOString(),
    status: autoPost ? "scheduled" : "draft",
    campaignId: tmpl.campaignId ?? null,
  }).returning({ id: posts.id });
  return { postId: row.id, url, ai, autoPost };
}

// Plan + monthly clip quota — re-checked every run so a long-lived schedule
// can't overspend after an upgrade/downgrade or month rollover.
async function quotaGate(pilot: AutoPilot) {
  const plan = await getUserPlan(pilot.userId!);
  const quota = await checkAutoClipQuota(pilot.userId!);
  if (!quota.enabled) return { ok: false as const, error: "Auto-Pilot is not available on the current plan.", skipped: "plan does not allow auto-pilot" };
  if (quota.remaining <= 0) return { ok: false as const, error: `Monthly cap reached (${quota.used}/${quota.limit} clips).`, skipped: "monthly cap reached" };
  return { ok: true as const, plan, remaining: quota.remaining };
}

export async function runOneAutoPilot(pilot: AutoPilot): Promise<RunResult> {
  if (pilot.platform !== "twitch") {
    return { pilotId: pilot.id, produced: 0, skipped: `platform ${pilot.platform} not supported yet` };
  }
  return pilot.liveMode ? runLivePass(pilot) : runScheduledPass(pilot);
}

// ── Scheduled: once per slot, clip the newest FINISHED stream ───────────────
async function runScheduledPass(pilot: AutoPilot): Promise<RunResult> {
  const now = new Date();
  const result: RunResult = { pilotId: pilot.id, produced: 0 };

  try {
    const gate = await quotaGate(pilot);
    if (!gate.ok) {
      await markRun(pilot, now, null, gate.error);
      return { ...result, skipped: gate.skipped };
    }

    // ── Discover the newest VOD since the last run ──
    const login = parseTwitchLogin(pilot.channel);
    const data = await getArchiveVods(login);
    if (!data || data.vods.length === 0) {
      await markRun(pilot, now, pilot.lastVodId ?? null, `No VODs found for "${login}".`);
      return { ...result, skipped: "no vods" };
    }
    // A broadcast that's still live isn't finished: clipping it now would take
    // only its first part and then mark the whole stream done. Wait for it to
    // end (Live mode is the option that clips while live) — unless it's a
    // marathon (below).
    const finished = data.vods.filter((v) => !v.recording);
    const lastRunAt = pilot.lastRunAt ? Date.parse(pilot.lastRunAt) : 0;
    let fresh: (typeof data.vods)[number] | undefined = finished
      // A stream partly clipped while it was still live (marathon) started
      // before the last run but still has an unclipped tail — keep it eligible.
      .filter((v) => v.uuid !== pilot.lastVodId && (Date.parse(v.startTime) > lastRunAt || v.uuid === pilot.liveVodId))
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))[0]
      // First-ever run (no lastRunAt): take the newest finished VOD so the
      // pilot does something immediately instead of waiting for the next stream.
      ?? (lastRunAt === 0 ? finished[0] : undefined);

    // Marathon / 24-7 streams can stay live for days — "wait for it to end"
    // would mean never posting. Once a broadcast has run long enough, clip
    // what's recorded so far and remember how far we got (liveVodId/
    // liveOffset), so the next run and the finished VOD continue from there
    // instead of re-clipping the same moments.
    let range: { from: number; to: number } | undefined;
    let partial = false;
    if (!fresh) {
      const rec = data.vods.find((v) => v.recording);
      if (rec && rec.durationSec >= MARATHON_MIN_SEC) {
        const from = pilot.liveVodId === rec.uuid ? (pilot.liveOffset ?? 0) : 0;
        const to = rec.durationSec - LIVE_EDGE_MARGIN;
        if (to - from >= MARATHON_MIN_NEW_SEC) { fresh = rec; range = { from, to }; partial = true; }
      }
    } else if (pilot.liveVodId === fresh.uuid && (pilot.liveOffset ?? 0) > 0) {
      // The marathon has ended: only its not-yet-scanned tail is new.
      const from = pilot.liveOffset ?? 0;
      if (fresh.durationSec - from < 120) {
        await markRun(pilot, now, fresh.uuid, null);
        return { ...result, vodId: fresh.uuid, skipped: "stream already clipped" };
      }
      range = { from, to: fresh.durationSec };
    }
    if (!fresh) {
      const stillLive = data.vods.some((v) => v.recording);
      await markRun(pilot, now, pilot.lastVodId ?? null, null);
      return { ...result, skipped: stillLive ? "stream still live — waiting for it to end" : "no new vod" };
    }

    // ── Find the best moments ──
    const planCap = cappedClipsPerRun(gate.plan, pilot.clipsPerRun ?? 3);
    const want = Math.min(planCap, gate.remaining, MAX_CLIPS_PER_INVOCATION);
    const scan = await scanTwitchVodHighlights(fresh.uuid, fresh.durationSec, want, [], range);
    // Bookkeeping for "this part of the stream is done": a marathon pass
    // only advances the offset (the stream itself isn't finished, so it must
    // not become lastVodId); a finished stream is marked done as before.
    const vodId = fresh.uuid;
    const finishPart = (error: string | null) => partial
      ? markRun(pilot, now, pilot.lastVodId ?? null, error, { patch: { liveVodId: vodId, liveOffset: range!.to } })
      : markRun(pilot, now, vodId, error);
    if (!scan.ok) {
      // A partial pass retries the same window next run.
      if (partial) await markRun(pilot, now, pilot.lastVodId ?? null, `Highlight scan failed: ${scan.error}`);
      else await markRun(pilot, now, vodId, `Highlight scan failed: ${scan.error}`);
      return { ...result, vodId, skipped: scan.error };
    }
    const moments = scan.moments.slice(0, want);
    if (moments.length === 0) {
      await finishPart(partial ? null : "No highlights detected in this VOD.");
      return { ...result, vodId, skipped: "no highlights" };
    }

    // Confidence = relative match strength within this batch (top moment = 100).
    const maxScore = Math.max(...moments.map((m) => m.score), 1);
    const ctx = await loadContext(pilot, data.channel.displayName);
    const slots = slotsForClips(now, moments.length, parseJsonArray<string>(pilot.postTimes, ["12:00"]));

    let produced = 0;
    for (let i = 0; i < moments.length; i++) {
      const m = moments[i];
      // How far this moment spikes above the VOD's normal chat level — an
      // absolute check, unlike confidence which is only relative to this batch.
      const momentLift = lift(m.msgsPer5, scan.baselineMsgsPer5);
      try {
        await produceClip(ctx, {
          vodId: fresh.uuid, vodTitle: fresh.title, moment: m,
          confidence: Math.round((m.score / maxScore) * 100),
          momentLift,
          // A genuine spike over baseline, OR chat explicitly asking to clip
          // it — a "!clip" is a direct human vote, so it clears the bar even
          // when the raw chat-rate lift is only marginal.
          standsOut: (m.msgsPer5 > 0 && momentLift >= MIN_AUTOPOST_LIFT) || !!m.clipRequested,
          releaseAt: slots[i],
        });
        produced++;
      } catch (err) {
        console.error(`[auto-pilot] pilot ${pilot.id} clip ${i} failed:`, err);
        // One bad moment shouldn't sink the whole run; keep going.
      }
    }

    if (produced === 0) {
      // Every clip failed (CDN hiccup, render crash…): don't mark this stream
      // as done, or "Run now"/the next slot would skip it as "no new vod".
      // Keep the previous VOD + run time so a retry picks it up again.
      await markRun(pilot, now, pilot.lastVodId ?? null, "All clips failed to render — will retry this stream next run.", { keepLastRun: true });
    } else {
      await finishPart(null);
    }
    return { ...result, produced, vodId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[auto-pilot] pilot ${pilot.id} run error:`, message);
    await markRun(pilot, now, pilot.lastVodId ?? null, message).catch(() => {});
    return { ...result, error: message };
  }
}

// ── Live: clip the broadcast while it's live, window by window ──────────────
//
// Every ~10 min: is the channel live with its broadcast being recorded? Scan
// only the part of the in-progress VOD not scanned yet (minus the newest 75s,
// which a clip around a late peak would still need), clip moments that are
// genuine spikes against the RUNNING chat baseline of the whole broadcast so
// far, and post/queue them right away. When the broadcast ends, one last pass
// covers its tail. State resets when a new broadcast starts.
async function runLivePass(pilot: AutoPilot): Promise<RunResult> {
  const now = new Date();
  const result: RunResult = { pilotId: pilot.id, produced: 0 };
  const next = new Date(now.getTime() + LIVE_POLL_MS).toISOString();
  const save = (patch: Partial<typeof autoPilots.$inferInsert>) =>
    db.update(autoPilots).set({ lastRunAt: now.toISOString(), nextRunAt: next, ...patch }).where(eq(autoPilots.id, pilot.id));

  try {
    const gate = await quotaGate(pilot);
    if (!gate.ok) {
      await save({ lastError: gate.error });
      return { ...result, skipped: gate.skipped };
    }

    const login = parseTwitchLogin(pilot.channel);
    const status = await getLiveStatus(login);
    if (!status) {
      await save({ lastError: `No Twitch channel called "${login}".`, liveState: "offline" });
      return { ...result, skipped: "channel not found" };
    }

    // Which broadcast to work on: the one recording now, or — if the one we
    // were following just ended — its finished VOD, for a final pass.
    let vod: { uuid: string; durationSec: number; recording: boolean; title: string } | null = null;
    if (status.recordingVod) {
      vod = { ...status.recordingVod, recording: true };
    } else if (pilot.liveVodId && status.latestVod?.uuid === pilot.liveVodId && (pilot.liveOffset ?? 0) < status.latestVod.durationSec - 30) {
      vod = { uuid: status.latestVod.uuid, durationSec: status.latestVod.durationSec, recording: false, title: "Stream" };
    }

    if (!vod) {
      const vodsOff = status.live; // live, but no recording archive
      await save({
        liveState: vodsOff ? "vods_off" : "offline",
        lastError: vodsOff ? "Live now, but this channel's VODs are off or subscriber-only — Live mode needs public VODs." : null,
      });
      return { ...result, skipped: vodsOff ? "live but no vod" : "offline" };
    }

    // New broadcast → reset per-stream state. Joining mid-stream starts a bit
    // back from "now" rather than at the top of a long stream.
    const isNew = vod.uuid !== pilot.liveVodId;
    let offset = isNew ? Math.max(0, vod.durationSec - LIVE_FIRST_LOOKBACK) : (pilot.liveOffset ?? 0);
    let clipsSoFar = isNew ? 0 : (pilot.liveClips ?? 0);
    let baseline = isNew ? null : pilot.liveBaseline ?? null;
    let samples = isNew ? 0 : (pilot.liveSamples ?? 0);
    let scoreRef = isNew ? null : pilot.liveScoreRef ?? null;
    let windows = isNew ? 0 : (pilot.liveWindows ?? 0);

    const planCap = cappedClipsPerRun(gate.plan, pilot.clipsPerRun ?? 3);
    const edge = vod.recording ? vod.durationSec - LIVE_EDGE_MARGIN : vod.durationSec;
    const to = Math.min(edge, offset + LIVE_MAX_WINDOW);
    const liveState = vod.recording ? "live" : "offline";

    if (clipsSoFar >= planCap) {
      await save({ liveVodId: vod.uuid, liveOffset: Math.max(offset, to), liveClips: clipsSoFar, liveState, lastError: null });
      return { ...result, vodId: vod.uuid, skipped: `stream cap reached (${planCap} clips)` };
    }
    if (to - offset < (vod.recording ? LIVE_MIN_WINDOW : 120)) {
      // Not enough new stream yet — or a finished tail too short to bother.
      await save({
        liveVodId: vod.uuid, liveOffset: vod.recording ? offset : vod.durationSec,
        liveClips: clipsSoFar, liveBaseline: baseline, liveSamples: samples,
        liveScoreRef: scoreRef, liveWindows: windows, liveState, lastError: null,
      });
      return { ...result, vodId: vod.uuid, skipped: "waiting for more stream" };
    }

    const want = Math.min(LIVE_MAX_CLIPS_PER_PASS, planCap - clipsSoFar, gate.remaining);
    const scan = await scanTwitchVodHighlights(vod.uuid, vod.durationSec, Math.max(want * 2, 3), [], { from: offset, to });
    if (!scan.ok) {
      // Keep the offset: a transient chat/CDN failure retries the same window.
      await save({ liveVodId: vod.uuid, liveClips: clipsSoFar, liveState, lastError: `Live scan failed: ${scan.error}` });
      return { ...result, vodId: vod.uuid, skipped: scan.error };
    }

    // Running chat baseline across every window of this broadcast, so "is
    // this a spike?" is judged against the whole stream so far, not just a
    // quiet (or hyped) last few minutes.
    if (scan.baselineMsgsPer5 > 0 && scan.scanned > 0) {
      baseline = baseline == null
        ? scan.baselineMsgsPer5
        : (baseline * samples + scan.baselineMsgsPer5 * scan.scanned) / (samples + scan.scanned);
      samples += scan.scanned;
    }
    const ref = baseline ?? scan.baselineMsgsPer5;

    // Which moments are genuinely clip-worthy? Chat-rate lift alone can't
    // decide on big channels: a chat-replay page holds ~50 messages, so the
    // measured rate saturates (~45 msgs/5s) and nothing ever reads as a 2×
    // spike. The scanner's fused score (hype, sharpness, clip requests,
    // audio) still separates moments, so a moment qualifies when it
    //   • clearly beats this window's other candidates (≥1.5× the median), AND
    //   • beats this stream's typical best-moment-per-window (≥1.1× the
    //     running mean), so a dull stretch's "best" doesn't get clipped —
    // or, regardless: a real chat-rate spike (smaller channels) or chat
    // explicitly asking to clip it.
    const scores = scan.moments.map((m) => m.score).sort((a, b) => a - b);
    const median = scores.length ? scores[Math.floor((scores.length - 1) / 2)] : 0;
    const top = scores.length ? scores[scores.length - 1] : 0;
    const bar = Math.max(median * 1.5, scoreRef != null ? scoreRef * 1.1 : 0);
    const picks = scan.moments
      .map((m) => ({ m, l: lift(m.msgsPer5, ref) }))
      .filter(({ m, l }) => !!m.clipRequested || (m.msgsPer5 > 0 && l >= MIN_AUTOPOST_LIFT) || (median > 0 && m.score >= bar))
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, want);
    const confDenom = scoreRef ?? Math.max(1, median);
    // Fold this window's best into the running reference AFTER judging it.
    if (top > 0) { scoreRef = scoreRef == null ? top : (scoreRef * windows + top) / (windows + 1); windows += 1; }

    let produced = 0;
    if (picks.length > 0) {
      const ctx = await loadContext(pilot, login);
      for (const { m, l } of picks) {
        try {
          await produceClip(ctx, {
            vodId: vod.uuid, vodTitle: vod.title, moment: m,
            // Live confidence: how far the moment's score clears the stream's
            // typical best (1.1× ≈ 60, 1.5× ≈ 100); a clip request floors at 80.
            confidence: Math.max(m.clipRequested ? 80 : 0, Math.min(100, Math.round((m.score / confDenom - 0.5) * 100))),
            momentLift: l,
            standsOut: true,
            releaseAt: new Date(Date.now() + LIVE_RELEASE_DELAY_MS).toISOString(),
            live: true,
          });
          produced++;
        } catch (err) {
          console.error(`[auto-pilot] pilot ${pilot.id} live clip at ${m.t}s failed:`, err);
        }
      }
    }
    clipsSoFar += produced;
    offset = to;

    await save({
      liveVodId: vod.uuid, liveOffset: offset, liveClips: clipsSoFar,
      liveBaseline: baseline, liveSamples: samples, liveScoreRef: scoreRef, liveWindows: windows, liveState,
      lastVodId: vod.recording ? pilot.lastVodId : vod.uuid,
      lastError: picks.length > 0 && produced === 0 ? "Live clips failed to render." : null,
    });
    return { ...result, produced, vodId: vod.uuid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[auto-pilot] pilot ${pilot.id} live pass error:`, message);
    await save({ lastError: message }).catch(() => {});
    return { ...result, error: message };
  }
}

// Transcribe the cut section and keep the segments inside the final trim
// (times stay source-relative, as the renderer expects). Optionally tags
// impactful words with emoji for the animated caption styles.
async function templateSubtitles(videoUrl: string, start: number, end: number, language: string, emoji: boolean): Promise<Subtitle[]> {
  const res = await generateSubtitles({ videoUrl, language });
  let subs: Subtitle[] = (res.segments ?? [])
    .filter((s) => s.end > start && s.start < end)
    .map((s, i) => ({ id: `s${i}`, start: s.start, end: s.end, text: s.text, words: s.words }));
  if (emoji && subs.length > 0) {
    const flat: { seg: number; word: number; text: string }[] = [];
    subs.forEach((s, si) => (s.words ?? []).forEach((w, wi) => flat.push({ seg: si, word: wi, text: w.word })));
    const picks = await pickCaptionEmojis(flat.map((f) => f.text)).catch(() => []);
    subs = subs.map((s) => ({ ...s, words: s.words?.map((w) => ({ ...w })) }));
    for (const p of picks) {
      const f = flat[p.index];
      const w = f && subs[f.seg].words?.[f.word];
      if (w) w.emoji = p.emoji;
    }
  }
  return subs;
}

// Persist run bookkeeping: advance lastRunAt / nextRunAt, remember the VOD, and
// record any error. Never throws into the caller's happy path.
async function markRun(
  pilot: AutoPilot, ranAt: Date, vodId: string | null, error: string | null,
  opts: { keepLastRun?: boolean; patch?: Partial<typeof autoPilots.$inferInsert> } = {},
): Promise<void> {
  const days = parseJsonArray<number>(pilot.days, []);
  const postTimes = parseJsonArray<string>(pilot.postTimes, ["12:00"]);
  await db.update(autoPilots).set({
    // keepLastRun: the stream filter is "started after lastRunAt", so advancing
    // it after a total failure would also hide the stream from a retry.
    lastRunAt: opts.keepLastRun ? pilot.lastRunAt : ranAt.toISOString(),
    lastVodId: vodId,
    nextRunAt: nextScanAt(ranAt, pilot.cadence, days, postTimes),
    lastError: error,
    ...opts.patch,
  }).where(eq(autoPilots.id, pilot.id));
}

// ─── Cron entry: run all due pilots ──────────────────────────────────────────

export async function runDueAutoPilots(limit = 3): Promise<RunResult[]> {
  // Ensure the table exists even on a fresh DB that hasn't hit /api/init yet.
  await client.execute("SELECT 1 FROM auto_pilots LIMIT 1").catch(() => {});

  const nowIso = new Date().toISOString();
  const due = await db
    .select()
    .from(autoPilots)
    .where(and(
      eq(autoPilots.enabled, true),
      or(isNull(autoPilots.nextRunAt), lte(autoPilots.nextRunAt, nowIso)),
    ))
    .limit(limit);

  const results: RunResult[] = [];
  for (const pilot of due) {
    results.push(await runOneAutoPilot(pilot));
  }
  return results;
}

// Validate a template from the client (whitelist + the campaign must be the
// user's own). Returns the JSON to store, or null for "no template".
export async function cleanPilotTemplate(userId: number, raw: unknown): Promise<string | null> {
  if (!raw) return null;
  const t = sanitizePilotTemplate(raw);
  if (t.campaignId != null) {
    const [c] = await db.select({ id: campaigns.id }).from(campaigns)
      .where(and(eq(campaigns.id, t.campaignId), eq(campaigns.userId, userId))).limit(1);
    if (!c) delete t.campaignId;
  }
  return Object.keys(t).length ? JSON.stringify(t) : null;
}

// Per-schedule production stats for the dashboard cards: clips waiting for
// review, scheduled to post, and already posted.
export async function pilotStats(userId: number): Promise<Record<number, { review: number; scheduled: number; posted: number; failed: number }>> {
  const out: Record<number, { review: number; scheduled: number; posted: number; failed: number }> = {};
  try {
    const res = await client.execute({
      sql: `SELECT json_extract(p.metadata, '$.autoPilotId') AS pid, p.status AS status, COUNT(*) AS n
              FROM posts p JOIN accounts a ON a.id = p.account_id
             WHERE a.user_id = ? AND json_extract(p.metadata, '$.source') = 'autopilot'
             GROUP BY pid, status`,
      args: [userId],
    });
    for (const r of res.rows as unknown as { pid: number | null; status: string; n: number }[]) {
      if (r.pid == null) continue;
      const s = (out[Number(r.pid)] ??= { review: 0, scheduled: 0, posted: 0, failed: 0 });
      const n = Number(r.n);
      if (r.status === "draft") s.review += n;
      else if (r.status === "scheduled") s.scheduled += n;
      else if (r.status === "published") s.posted += n;
      else if (r.status === "failed") s.failed += n;
    }
  } catch { /* stats are decorative — never fail the page */ }
  return out;
}

// Used by the create route to seed nextRunAt so a brand-new pilot runs soon.
export function initialNextRun(cadence: string, days: number[], postTimes: string[]): string {
  // Run within the next few minutes on first activation; the engine dedupes via
  // lastVodId so an immediate first run is safe.
  void cadence; void days; void postTimes;
  return new Date(Date.now() + 60_000).toISOString();
}
