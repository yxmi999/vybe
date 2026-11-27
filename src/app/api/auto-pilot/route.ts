import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { autoPilots, accounts } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  getUserPlan, limitsFor, checkAutoPilotCreate, cappedClipsPerRun,
  autoClipsUsedThisMonth, autoPilotUpgradeMessage, autoPilotLimitMessage,
} from "@/lib/plan";
import { initialNextRun, cleanPilotTemplate, pilotStats } from "@/lib/auto-pilot";

const CADENCES = ["daily", "weekly", "specific_days"];
// The scheduler can only publish a video to YouTube today (Shorts). Other
// platforms either need an image (IG) or don't take video (X/TikTok), so a
// schedule must target a YouTube account to be postable.
const POSTABLE_PLATFORMS = ["youtube"];

function validTimes(times: unknown): string[] | null {
  if (!Array.isArray(times) || times.length === 0) return null;
  const out: string[] = [];
  for (const t of times) {
    if (typeof t !== "string" || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) return null;
    out.push(t);
  }
  return out;
}

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(session.userId);
  const lim = limitsFor(plan);
  const [pilots, used, stats] = await Promise.all([
    db.select().from(autoPilots).where(eq(autoPilots.userId, session.userId)).orderBy(desc(autoPilots.createdAt)),
    autoClipsUsedThisMonth(session.userId),
    pilotStats(session.userId),
  ]);

  return NextResponse.json({
    plan,
    limits: {
      autoPilotEnabled: lim.autoPilotEnabled,
      maxAutoPilots: lim.maxAutoPilots,
      autoClipsPerMonth: lim.autoClipsPerMonth,
      maxClipsPerRun: lim.maxClipsPerRun,
    },
    used,
    pilots: pilots.map((p) => ({ ...p, stats: stats[p.id] ?? { review: 0, scheduled: 0, posted: 0, failed: 0 } })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Plan gate (fails closed) — block free, and enforce the schedule cap.
  const create = await checkAutoPilotCreate(session.userId);
  if (!create.enabled) return NextResponse.json({ error: autoPilotUpgradeMessage() }, { status: 403 });
  if (!create.allowed) return NextResponse.json({ error: autoPilotLimitMessage(create) }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const {
    platform = "twitch", channel, targetAccountId,
    cadence, days, postTimes, clipsPerRun, minConfidence = 0,
    autoPost = false, template, liveMode = false,
  } = body;

  if (platform !== "twitch") return NextResponse.json({ error: "Only Twitch is supported right now." }, { status: 400 });
  if (!channel || !String(channel).trim()) return NextResponse.json({ error: "Enter a Twitch channel." }, { status: 400 });
  if (!CADENCES.includes(cadence)) return NextResponse.json({ error: "Pick how often to run." }, { status: 400 });

  const times = validTimes(postTimes);
  if (!times) return NextResponse.json({ error: "Add at least one valid post time (HH:MM)." }, { status: 400 });

  let dayList: number[] = [];
  if (cadence !== "daily") {
    dayList = Array.isArray(days) ? days.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) : [];
    if (dayList.length === 0) return NextResponse.json({ error: "Pick at least one day of the week." }, { status: 400 });
  }

  // Target account must belong to the user and be able to receive a video.
  const acct = (await db.select().from(accounts)
    .where(and(eq(accounts.id, Number(targetAccountId)), eq(accounts.userId, session.userId))).limit(1))[0];
  if (!acct) return NextResponse.json({ error: "Pick a connected account to post to." }, { status: 400 });
  if (!POSTABLE_PLATFORMS.includes(acct.platform)) {
    return NextResponse.json(
      { error: `Clips can only be auto-posted to YouTube right now. Connect a YouTube account, or use review mode and post the clip manually.` },
      { status: 400 },
    );
  }

  const plan = await getUserPlan(session.userId);
  const cappedRun = cappedClipsPerRun(plan, Number(clipsPerRun) || 1);
  const conf = Math.max(0, Math.min(100, Number(minConfidence) || 0));

  const [created] = await db.insert(autoPilots).values({
    userId: session.userId,
    enabled: true,
    platform: "twitch",
    channel: String(channel).trim(),
    targetAccountId: acct.id,
    cadence,
    days: cadence === "daily" ? null : JSON.stringify(dayList),
    postTimes: JSON.stringify(times),
    clipsPerRun: cappedRun,
    minConfidence: conf,
    autoPost: !!autoPost,
    liveMode: liveMode === true,
    template: await cleanPilotTemplate(session.userId, template),
    nextRunAt: initialNextRun(cadence, dayList, times),
  }).returning();

  return NextResponse.json(created, { status: 201 });
}
