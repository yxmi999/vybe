// Plan limits + the free-tier clip cap / expiry helpers.
//
// The free tier is the dominant cost at a high free:paid ratio, so two levers
// live here: a monthly cap on new clips, and a TTL that lets the cleanup job
// auto-delete free-tier clips. All DB access fails OPEN — bookkeeping must never
// block the core clip flow.
import { client } from "./db";
import { isDesktop } from "./desktop";
import { isEmailVerified } from "./email-verification";

export type Plan = "free" | "creator" | "pro";

export type Limits = {
  clipsPerMonth: number;        // Infinity = unlimited
  maxAccounts: number;          // Infinity = unlimited
  maxShortSide: number;         // cap on the shorter export dimension (720 = "720p")
  watermark: boolean;           // free exports get a brand watermark burned in
  clipTtlDays: number | null;   // auto-delete stored clips after N days; null = keep

  // Auto-Pilot (recurring auto-clipping). Paid-only; Pro is 5× Creator.
  autoPilotEnabled: boolean;    // free is blocked entirely
  maxAutoPilots: number;        // concurrent active schedules
  autoClipsPerMonth: number;    // monthly cap on clips the engine produces
  maxClipsPerRun: number;       // clips produced from a single stream/VOD
};

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Free-tier knobs are env-overridable so pricing can be tuned without a deploy.
export const PLAN_LIMITS: Record<Plan, Limits> = {
  free: {
    clipsPerMonth: envInt("FREE_CLIPS_PER_MONTH", 10),
    maxAccounts: envInt("FREE_MAX_ACCOUNTS", 3),
    maxShortSide: envInt("FREE_MAX_SHORT_SIDE", 720),
    watermark: true,
    clipTtlDays: envInt("FREE_CLIP_TTL_DAYS", 7),
    autoPilotEnabled: false,
    maxAutoPilots: 0,
    autoClipsPerMonth: 0,
    maxClipsPerRun: 0,
  },
  creator: {
    clipsPerMonth: Infinity,
    maxAccounts: 6,
    maxShortSide: 1080,
    watermark: false,
    clipTtlDays: null,
    autoPilotEnabled: true,
    maxAutoPilots: envInt("CREATOR_MAX_AUTOPILOTS", 1),
    autoClipsPerMonth: envInt("CREATOR_AUTOCLIPS_PER_MONTH", 100),
    maxClipsPerRun: envInt("CREATOR_MAX_CLIPS_PER_RUN", 3),
  },
  pro: {
    clipsPerMonth: Infinity,
    maxAccounts: 15,
    maxShortSide: 2160,
    watermark: false,
    clipTtlDays: null,
    autoPilotEnabled: true,
    maxAutoPilots: envInt("PRO_MAX_AUTOPILOTS", 5),
    autoClipsPerMonth: envInt("PRO_AUTOCLIPS_PER_MONTH", 500),
    maxClipsPerRun: envInt("PRO_MAX_CLIPS_PER_RUN", 15),
  },
};

export function normalizePlan(raw: string | null | undefined): Plan {
  const p = (raw ?? "free").toLowerCase();
  if (p === "pro") return "pro";
  if (p === "creator") return "creator";
  return "free";
}

// Desktop app (VYBE_DESKTOP=1): everything runs on the user's machine with
// their own API keys, so it costs us nothing — the free tier is far more
// generous (more clips, 1080p, Auto-Pilot, no auto-delete of their own
// files), but the watermark is always on. A paid desktop license is what
// would remove it (not built yet), so for now every desktop plan uses these.
export const DESKTOP_LIMITS: Limits = {
  clipsPerMonth: envInt("DESKTOP_CLIPS_PER_MONTH", 150),
  maxAccounts: envInt("DESKTOP_MAX_ACCOUNTS", 5),
  maxShortSide: 1080,
  watermark: true,
  clipTtlDays: null,
  autoPilotEnabled: true,
  maxAutoPilots: envInt("DESKTOP_MAX_AUTOPILOTS", 2),
  autoClipsPerMonth: envInt("DESKTOP_AUTOCLIPS_PER_MONTH", 150),
  maxClipsPerRun: envInt("DESKTOP_MAX_CLIPS_PER_RUN", 5),
};

export function limitsFor(plan: Plan): Limits {
  if (isDesktop()) return DESKTOP_LIMITS;
  return PLAN_LIMITS[plan];
}

export async function getUserPlan(userId: number): Promise<Plan> {
  try {
    const res = await client.execute({ sql: "SELECT plan FROM users WHERE id = ?", args: [userId] });
    const row = res.rows[0] as { plan?: string } | undefined;
    return normalizePlan(row?.plan);
  } catch {
    return "free";
  }
}

// Whether exports must carry the watermark: always on free, and on paid plans
// bought with the discounted "keep the watermark" option. Fails toward the
// plan default (free → watermark, paid → none) if the column is missing.
export async function requiresWatermark(userId: number): Promise<boolean> {
  const plan = await getUserPlan(userId);
  if (limitsFor(plan).watermark) return true;
  try {
    const res = await client.execute({ sql: "SELECT keep_watermark FROM users WHERE id = ?", args: [userId] });
    return Number((res.rows[0] as { keep_watermark?: number } | undefined)?.keep_watermark ?? 0) === 1;
  } catch {
    return false;
  }
}

// Count of quota-bearing clips created in the current calendar month.
export async function clipsUsedThisMonth(userId: number): Promise<number> {
  try {
    const res = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM clips
            WHERE user_id = ? AND counts_quota = 1
              AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
      args: [userId],
    });
    return Number((res.rows[0] as { n?: number | bigint })?.n ?? 0);
  } catch {
    return 0; // table missing / db error → fail open
  }
}

export type QuotaStatus = { plan: Plan; used: number; limit: number; allowed: boolean; needsVerification?: boolean };

const VERIFY_MESSAGE = "Verify your email to unlock your free clips. Check your inbox for the link, or resend it from the dashboard.";

export async function checkClipQuota(userId: number): Promise<QuotaStatus> {
  const plan = await getUserPlan(userId);
  const limit = limitsFor(plan).clipsPerMonth;
  if (!Number.isFinite(limit)) return { plan, used: 0, limit, allowed: true };
  const used = await clipsUsedThisMonth(userId);
  // Free clips unlock only after the email is verified (paid plans skip this).
  if (!isDesktop() && !(await isEmailVerified(userId))) {
    return { plan, used, limit, allowed: false, needsVerification: true };
  }
  return { plan, used, limit, allowed: used < limit };
}

export function quotaMessage(q: QuotaStatus): string {
  if (q.needsVerification) return VERIFY_MESSAGE;
  return `You've reached the Free plan limit of ${q.limit} clips this month. `
    + `Upgrade to Creator for unlimited clips, or wait until next month.`;
}

// Insert a ledger row for a stored clip. Sets an expiry for plans with a TTL so
// the cleanup job can reclaim the storage later. Never throws.
export async function recordClip(opts: {
  userId: number;
  url: string;
  kind: "import" | "upload" | "export" | "autopilot" | "asset" | "media";
  countsQuota: boolean;
  sizeBytes?: number;
  /** Never expire sooner than this (e.g. post attachments for posts scheduled weeks out). */
  minTtlDays?: number;
}): Promise<void> {
  try {
    const planTtl = limitsFor(await getUserPlan(opts.userId)).clipTtlDays;
    const ttl = planTtl != null && opts.minTtlDays != null ? Math.max(planTtl, opts.minTtlDays) : planTtl;
    const expiresAt = ttl != null ? new Date(Date.now() + ttl * 86_400_000).toISOString() : null;
    await client.execute({
      sql: `INSERT INTO clips (user_id, url, kind, counts_quota, size_bytes, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [opts.userId, opts.url, opts.kind, opts.countsQuota ? 1 : 0, opts.sizeBytes ?? 0, expiresAt],
    });
  } catch {
    // Never let bookkeeping break the clip flow.
  }
}

// Ledger of exports that carry the burned-in watermark, which makes the
// video eligible for the views leaderboard (lib/leaderboard.ts). Never throws.
export async function recordWatermarkedExport(userId: number, url: string): Promise<void> {
  try {
    await client.execute({
      sql: "INSERT OR IGNORE INTO watermarked_exports (url, user_id) VALUES (?, ?)",
      args: [url, userId],
    });
  } catch {
    // Bookkeeping must never break the export.
  }
}

// Generated/derived files (tightened cuts, covers, B-roll, AI images/videos).
// They don't count toward the clip quota, but they're ledgered so the cleanup
// cron and account deletion can find them — before this they were orphaned in
// Blob storage forever.
export async function recordAsset(userId: number, url: string): Promise<void> {
  await recordClip({ userId, url, kind: "asset", countsQuota: false });
}

// ─── Uploads that skip the clip quota ────────────────────────────────────────
// Export re-uploads and post attachments don't count as clips, but the client
// picks the upload kind, so without a cap they'd be a way around the quota and
// a way to fill Blob storage for free. Plans with unlimited clips are uncapped.
const FREE_EXPORTS_PER_CLIP = envInt("FREE_EXPORTS_PER_CLIP", 5);
const FREE_MEDIA_PER_MONTH = envInt("FREE_MEDIA_PER_MONTH", 30);
export const MEDIA_TTL_DAYS = 30; // free-tier post attachments live long enough for scheduled posts

export async function checkSideUploadAllowance(
  userId: number,
  kind: "export" | "media",
): Promise<{ allowed: boolean; message: string }> {
  const limit = limitsFor(await getUserPlan(userId)).clipsPerMonth;
  if (!Number.isFinite(limit)) return { allowed: true, message: "" };
  if (!isDesktop() && !(await isEmailVerified(userId))) return { allowed: false, message: VERIFY_MESSAGE };
  const cap = kind === "export" ? limit * FREE_EXPORTS_PER_CLIP : FREE_MEDIA_PER_MONTH;
  try {
    const res = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM clips
            WHERE user_id = ? AND kind = ?
              AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
      args: [userId, kind],
    });
    const used = Number((res.rows[0] as { n?: number | bigint })?.n ?? 0);
    if (used < cap) return { allowed: true, message: "" };
  } catch {
    return { allowed: true, message: "" }; // fail open, like the clip quota
  }
  return {
    allowed: false,
    message: kind === "export"
      ? `You've reached the Free plan limit of ${cap} exports this month. Upgrade to Creator for unlimited exports.`
      : `You've reached the Free plan limit of ${cap} post attachments this month. Upgrade to Creator for unlimited uploads.`,
  };
}

// ─── Auto-Pilot quotas ───────────────────────────────────────────────────────
// Two independent caps guard cost: how many schedules a user can run at once,
// and how many clips the engine may produce per calendar month. Both Pro values
// are 5× Creator. Every helper fails OPEN on a DB error — bookkeeping must never
// wedge the engine — except the create check, which fails CLOSED so a glitch
// can't let a free user spin up an unbounded schedule.

// Count of auto-pilot-produced clips this calendar month (kind = 'autopilot').
export async function autoClipsUsedThisMonth(userId: number): Promise<number> {
  try {
    const res = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM clips
            WHERE user_id = ? AND kind = 'autopilot'
              AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
      args: [userId],
    });
    return Number((res.rows[0] as { n?: number | bigint })?.n ?? 0);
  } catch {
    return 0; // fail open
  }
}

// Number of active (enabled) schedules the user currently has.
export async function activeAutoPilotCount(userId: number): Promise<number> {
  try {
    const res = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM auto_pilots WHERE user_id = ? AND enabled = 1`,
      args: [userId],
    });
    return Number((res.rows[0] as { n?: number | bigint })?.n ?? 0);
  } catch {
    return 0; // fail open
  }
}

export type AutoClipQuota = { plan: Plan; enabled: boolean; used: number; limit: number; remaining: number; allowed: boolean };

// Monthly clip-production quota — checked at create AND mid-run so a long
// schedule can't overspend.
export async function checkAutoClipQuota(userId: number): Promise<AutoClipQuota> {
  const plan = await getUserPlan(userId);
  const lim = limitsFor(plan);
  if (!lim.autoPilotEnabled) {
    return { plan, enabled: false, used: 0, limit: 0, remaining: 0, allowed: false };
  }
  const limit = lim.autoClipsPerMonth;
  const used = await autoClipsUsedThisMonth(userId);
  const remaining = Math.max(0, limit - used);
  return { plan, enabled: true, used, limit, remaining, allowed: remaining > 0 };
}

export type AutoPilotCreateCheck = { plan: Plan; enabled: boolean; active: number; limit: number; allowed: boolean };

// Whether the user may create another schedule. Fails CLOSED.
export async function checkAutoPilotCreate(userId: number): Promise<AutoPilotCreateCheck> {
  try {
    const plan = await getUserPlan(userId);
    const lim = limitsFor(plan);
    if (!lim.autoPilotEnabled) return { plan, enabled: false, active: 0, limit: 0, allowed: false };
    const active = await activeAutoPilotCount(userId);
    return { plan, enabled: true, active, limit: lim.maxAutoPilots, allowed: active < lim.maxAutoPilots };
  } catch {
    return { plan: "free", enabled: false, active: 0, limit: 0, allowed: false };
  }
}

export function autoPilotUpgradeMessage(): string {
  return "Auto-Pilot is a paid feature. Upgrade to Creator or Pro to schedule automatic clipping.";
}

export function autoPilotLimitMessage(c: AutoPilotCreateCheck): string {
  return `You're running ${c.active} of ${c.limit} Auto-Pilot schedules on the ${c.plan} plan. `
    + (c.plan === "creator"
      ? "Upgrade to Pro for up to 5 schedules, or pause one to add another."
      : "Pause a schedule to add another.");
}

// Clamp a requested clips-per-run to what the plan allows.
export function cappedClipsPerRun(plan: Plan, requested: number): number {
  const max = limitsFor(plan).maxClipsPerRun;
  return Math.max(1, Math.min(max, Math.floor(requested) || 1));
}
