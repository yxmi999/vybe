import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts, posts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { extractVodSection, type VodPlatform } from "@/lib/vod-extract";
import { renderClip } from "@/lib/clip-render";
import { slotsForClips } from "@/lib/auto-pilot";
import { checkClipQuota, quotaMessage } from "@/lib/plan";
import { resolveStyle } from "@/lib/style-store";
import { buildStyledRender } from "@/lib/styled-render";

// VOD → a week of clips: take the top moments from one VOD scan, cut + render
// each to a vertical short, and drop them onto the calendar spread one-per-slot
// across the coming days. A batch, on-demand version of the Auto-Pilot engine —
// it reuses the same section cutter, renderer, and slot spreader.

export const maxDuration = 300;

// One invocation has a ~300s budget; cap so a batch can't blow it (each clip is a
// download + render). Matches the Auto-Pilot per-run ceiling.
const MAX_BATCH = 6;
const PLATFORMS: VodPlatform[] = ["twitch", "kick", "youtube", "rumble"];
// "Auto" clip length: cut this generous a raw window around each moment, then
// let silence-snapping (src/lib/silence.ts) trim it down to the natural pause
// boundaries around the peak — so each clip in the batch gets its own
// content-appropriate length instead of one fixed length for all of them.
const AUTO_RAW_WINDOW = 90;

type MomentIn = { t: number; kind?: string };

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const {
    platform, vodRef, vodTitle = "", accountId,
    moments = [], postTimes = ["12:00"], startDate, status = "draft", clipLen, styleRef,
  } = (await req.json()) as {
    platform?: VodPlatform;
    vodRef?: string;        // Twitch/YouTube video id, Kick uuid, or full Rumble URL
    vodTitle?: string;
    accountId?: number;
    moments?: MomentIn[];
    postTimes?: string[];
    startDate?: string;     // YYYY-MM-DD; defaults to today
    status?: "scheduled" | "draft";
    // Omitted, null, "auto", or "full" → each clip's length is picked
    // automatically per moment (silence-snapped); a number forces every clip
    // to that length. "full" only means something in the single-moment
    // preview/editor flow (a wide manual-trim window) — batch scheduling has
    // no editor step to trim in, so it falls back to auto-length here too.
    clipLen?: number | "auto" | "full" | null;
    // Optional editing style ("builtin:hype", "user:12") — when set, every
    // clip is AI-edited in that style instead of a plain center-crop.
    styleRef?: string | number | null;
  };

  if (!platform || !PLATFORMS.includes(platform)) {
    return NextResponse.json({ error: "Unsupported platform." }, { status: 400 });
  }
  if (!vodRef) return NextResponse.json({ error: "Missing VOD reference." }, { status: 400 });
  if (!Array.isArray(moments) || moments.length === 0) {
    return NextResponse.json({ error: "No moments to schedule." }, { status: 400 });
  }

  // An account is required even for drafts: the calendar/queue joins posts to
  // accounts, so an accountless post would be orphaned and invisible.
  if (!accountId) return NextResponse.json({ error: "Pick an account to queue these clips to." }, { status: 400 });
  const [account] = await db.select().from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, session.userId))).limit(1);
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  // Monthly clip cap — each produced clip is ledgered by renderClip below.
  const quota = await checkClipQuota(session.userId);
  if (!quota.allowed) return NextResponse.json({ error: quotaMessage(quota) }, { status: 403 });
  const remaining = Number.isFinite(quota.limit) ? quota.limit - quota.used : Infinity;

  const style = await resolveStyle(session.userId, styleRef);
  if (styleRef && !style) return NextResponse.json({ error: "That editing style no longer exists." }, { status: 400 });

  const auto = clipLen == null || clipLen === "auto" || clipLen === "full";
  const len = auto ? AUTO_RAW_WINDOW : Math.max(10, Math.min(180, Math.round(Number(clipLen))));
  const want = Math.min(moments.length, MAX_BATCH, remaining);
  if (want <= 0) return NextResponse.json({ error: quotaMessage(quota) }, { status: 403 });

  // First slot is at/after the chosen start date, never in the past.
  const startOfDay = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  const from = new Date(Math.max(Date.now(), startOfDay.getTime()));
  const slots = slotsForClips(from, want, postTimes.length ? postTimes : ["12:00"]);

  const made: { url: string; scheduledAt: string; title: string; notes?: string[] }[] = [];
  const failures: string[] = [];

  const src = { platform, vodRef }; // narrowed above; closures don't keep narrowing
  async function produce(i: number) {
    const m = moments[i];
    // Chat reacts a beat after the moment (lead the peak); a replay peak *is* the
    // moment, so center on it. Mirrors the editor's openMoment().
    const lead = m.kind === "replay" ? 0.5 : 0.55;
    const start = Math.max(0, Math.round(m.t - len * lead));
    try {
      // Auto mode: analyse the raw cut for silence and snap trimStart/trimEnd
      // to the natural pause boundaries around the peak, so this clip's final
      // length reflects its own content instead of the batch's fixed length.
      const section = await extractVodSection(src.platform, src.vodRef, start, len, auto ? { peakOffset: m.t - start } : {});
      const title = (vodTitle || section.title).slice(0, 90);
      const clipStart = section.trimStart ?? 0;
      const clipEnd = section.trimEnd ?? len;

      // With a style: the AI edits the cut (hook trim, punch-ins, captions,
      // look). Without one: a plain post-ready vertical center-crop.
      let edit: Partial<Parameters<typeof renderClip>[0]> = {
        trimStart: clipStart, trimEnd: clipEnd, cropAspect: "9:16", cropFill: "crop", cropX: 50, loudnorm: true,
      };
      let notes: string[] | undefined;
      if (style) {
        const styled = await buildStyledRender({
          videoUrl: section.videoUrl,
          clip: { title, platform: src.platform, duration: len, streamer: "" },
          trimStart: clipStart, trimEnd: clipEnd, style,
        });
        edit = styled.fields;
        notes = styled.notes;
      }

      const { url } = await renderClip({
        ...edit,
        userId: session!.userId,
        recordKind: "export",
        countsQuota: true,
        videoUrl: section.videoUrl,
        srcW: section.width,
        srcH: section.height,
        duration: len,
        title,
      });

      await db.insert(posts).values({
        accountId: account.id,
        platform: account.platform,
        content: (vodTitle || title).slice(0, 150),
        mediaUrls: JSON.stringify([url]),
        metadata: JSON.stringify({
          source: "vod-week",
          vodTitle,
          moment: m.t,
          isShort: true,
          videoTitle: title,
          ...(style ? { style: style.name, editNotes: notes } : {}),
        }),
        scheduledAt: slots[i],
        status,
      });
      made.push({ url, scheduledAt: slots[i], title, notes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[schedule-vod] moment ${i} (@${m.t}s) failed:`, msg);
      failures.push(msg);
    }
  }

  // Styled clips spend most of their time waiting on the AI, so run two at a
  // time to stay inside the request budget; plain cuts stay sequential.
  const concurrency = style ? 2 : 1;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, want) }, async () => {
    while (next < want) await produce(next++);
  }));
  made.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  if (made.length === 0) {
    return NextResponse.json(
      { error: failures[0] ?? "Couldn't produce any clips from this VOD." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    produced: made.length,
    requested: want,
    failed: failures.length,
    status,
    clips: made,
  });
}
