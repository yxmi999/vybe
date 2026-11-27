import { sql } from "drizzle-orm";
import { text, integer, real, sqliteTable } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  plan: text("plan").default("free"), // 'free' | 'creator' | 'pro'
  // Provider-agnostic billing. 'paddle' = card subscription (MoR); 'crypto' =
  // NOWPayments one-time time-block. Plan is granted by each provider's webhook.
  billingProvider: text("billing_provider"),           // 'paddle' | 'polar' | 'crypto' | null
  paddleCustomerId: text("paddle_customer_id"),
  paddleSubscriptionId: text("paddle_subscription_id"),
  polarSubscriptionId: text("polar_subscription_id"),  // Polar customers are keyed by our user id (external id)
  subscriptionStatus: text("subscription_status"),     // provider status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'crypto' | ...
  currentPeriodEnd: text("current_period_end"),
  keepWatermark: integer("keep_watermark", { mode: "boolean" }).default(false), // paid at the discounted "keep the watermark" price         // ISO; when the paid plan lapses if not renewed (drives crypto expiry)
  // Affiliate program (see lib/affiliate.ts).
  referralCode: text("referral_code").unique(),       // this user's own share code, created lazily
  referredBy: integer("referred_by"),                  // user id of whoever referred them
  referredAt: text("referred_at"),
  payoutMethod: text("payout_method"),                 // 'paypal' | 'crypto' | 'wise'
  payoutDetails: text("payout_details"),               // PayPal email / wallet address / Wise email
  leaderboardHidden: integer("leaderboard_hidden", { mode: "boolean" }).default(false), // show as "Anonymous creator"
  emailVerifiedAt: text("email_verified_at"),          // null = unverified; free clips are locked until set
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Every real charge from any provider. UNIQUE(provider, external_id) makes
// webhook re-deliveries idempotent; affiliate commissions hang off these rows.
export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  provider: text("provider").notNull(),               // 'polar' | 'paddle' | 'crypto'
  externalId: text("external_id").notNull(),          // order / transaction id
  amountCents: integer("amount_cents").notNull().default(0), // net of tax and discounts
  currency: text("currency").notNull().default("USD"),
  refunded: integer("refunded", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const affiliatePayouts = sqliteTable("affiliate_payouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  method: text("method"),
  details: text("details"),
  status: text("status").notNull().default("requested"), // 'requested' | 'paid' | 'rejected'
  note: text("note"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  settledAt: text("settled_at"),
  requestCountry: text("request_country"),            // country the request came from (host geo header)
  riskSnapshot: text("risk_snapshot"),                // JSON risk flags at request time
});

// One row per commission; a refund adds a negative 'reversal' row instead of
// editing history, so already-paid-out money nets off the next payout.
export const referralCommissions = sqliteTable("referral_commissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  referrerId: integer("referrer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referredUserId: integer("referred_user_id").references(() => users.id, { onDelete: "set null" }),
  paymentId: integer("payment_id").references(() => payments.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("commission"), // 'commission' | 'reversal'
  amountCents: integer("amount_cents").notNull(),
  ratePct: real("rate_pct").notNull().default(0),
  status: text("status").notNull().default("earned"),
  availableAt: text("available_at").notNull(),        // end of the refund hold
  payoutId: integer("payout_id").references(() => affiliatePayouts.id, { onDelete: "set null" }),
  reason: text("reason"),                             // reversal cause: 'refund' | 'chargeback'
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Affiliate fraud signals: hashed IPs / device ids per user (see lib/affiliate-safety.ts).
// Primary key (user_id, kind, value_hash) is created in migrate().
export const userSignals = sqliteTable("user_signals", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                       // 'ip' | 'device'
  valueHash: text("value_hash").notNull(),
  firstEvent: text("first_event"),
  firstSeen: text("first_seen"),
  lastSeen: text("last_seen"),
});

// Payout identity collected at the first payout request (KYC-lite).
export const affiliateProfiles = sqliteTable("affiliate_profiles", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  legalName: text("legal_name"),
  country: text("country"),
  address: text("address"),
  usPerson: integer("us_person", { mode: "boolean" }).default(false),
  termsVersion: text("terms_version"),
  termsAcceptedAt: text("terms_accepted_at"),
  idStatus: text("id_status").default("none"),        // 'none' | 'pending' | 'verified' | 'rejected'
  idNote: text("id_note"),
  taxFormOnFile: integer("tax_form_on_file", { mode: "boolean" }).default(false),
  updatedAt: text("updated_at"),
});

// Exports that had the watermark burned in (survives the free-tier clip TTL).
export const watermarkedExports = sqliteTable("watermarked_exports", {
  url: text("url").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // 'instagram' | 'twitter' | 'tiktok' | 'youtube'
  username: text("username").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  tokenExpiry: integer("token_expiry"),
  platformUserId: text("platform_user_id"),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Account columns that are safe to send to the browser: everything except the
// OAuth tokens. Use this in any query whose result is returned to the client.
export const publicAccountColumns = {
  id: accounts.id,
  userId: accounts.userId,
  platform: accounts.platform,
  username: accounts.username,
  displayName: accounts.displayName,
  avatarUrl: accounts.avatarUrl,
  platformUserId: accounts.platformUserId,
  isActive: accounts.isActive,
  createdAt: accounts.createdAt,
};

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  content: text("content").notNull(),
  mediaUrls: text("media_urls"), // JSON array of file paths
  metadata: text("metadata"), // JSON — e.g. { isShort: true }
  scheduledAt: text("scheduled_at").notNull(),
  status: text("status").default("scheduled"), // 'scheduled' | 'published' | 'failed' | 'draft'
  platformPostId: text("platform_post_id"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  publishedAt: text("published_at"),
  // Paid campaign this video earns from. null = the user's default campaign
  // (resolved at read time, so changing the default re-prices those videos).
  campaignId: integer("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
});

// Paid clipping/creator campaigns: revenue = views / 1000 × CPM, optionally
// capped per video. One campaign per user may be the default.
export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  cpm: real("cpm").notNull().default(0),            // payout per 1,000 views
  currency: text("currency").notNull().default("USD"),
  maxPayout: real("max_payout"),                    // per-video cap; null = uncapped
  minPayout: real("min_payout"),                    // per-video qualifying minimum; null = none
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const analytics = sqliteTable("analytics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),
  likes: integer("likes").default(0),
  comments: integer("comments").default(0),
  shares: integer("shares").default(0),
  reach: integer("reach").default(0),
  impressions: integer("impressions").default(0),
  fetchedAt: text("fetched_at").default(sql`(datetime('now'))`),
});

export const autoResponses = sqliteTable("auto_responses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  triggerKeyword: text("trigger_keyword"), // null = respond to all comments
  responseTemplate: text("response_template").notNull(),
  respondToLikes: integer("respond_to_likes", { mode: "boolean" }).default(false),
  respondToComments: integer("respond_to_comments", { mode: "boolean" }).default(true),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
  lastCheckedAt: text("last_checked_at"), // ISO timestamp — only fetch comments after this
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const accountStats = sqliteTable("account_stats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  followers: integer("followers").default(0),    // subs for YouTube
  following: integer("following").default(0),
  posts: integer("posts").default(0),            // videos for YouTube/TikTok
  views: integer("views").default(0),            // total channel views (YT) or total likes (TikTok)
  fetchedAt: text("fetched_at").default(sql`(datetime('now'))`),
});

export const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  title: text("title"),          // optional label
  url: text("url"),              // optional clip link to continue in the editor
  note: text("note"),           // optional free-text note
  done: integer("done", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Ledger of stored clip blobs per user — powers the free-tier monthly cap and
// the auto-expiry cleanup. One row per stored asset (import / upload / export).
export const clips = sqliteTable("clips", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  kind: text("kind").notNull(),                                 // 'import' | 'upload' | 'export' | 'autopilot'
  countsQuota: integer("counts_quota", { mode: "boolean" }).default(true),
  sizeBytes: integer("size_bytes").default(0),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  expiresAt: text("expires_at"),                                // ISO; null = keep forever
});

// Auto-Pilot: a recurring job that watches a creator, auto-clips their newest
// stream, edits each clip with a saved template, and either posts it on a
// schedule or drops it in a review queue. Paid-only; capped per plan.
export const autoPilots = sqliteTable("auto_pilots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  platform: text("platform").notNull(),            // 'twitch' (more later)
  channel: text("channel").notNull(),              // creator login / url
  targetAccountId: integer("target_account_id").references(() => accounts.id, { onDelete: "cascade" }),
  cadence: text("cadence").notNull(),              // 'daily' | 'weekly' | 'specific_days'
  days: text("days"),                              // JSON [0-6] for weekly/specific_days
  postTimes: text("post_times"),                   // JSON ["18:00","21:00"] local release slots
  timezone: text("timezone"),                      // IANA zone postTimes/days are in (e.g. "Europe/Paris"); null = UTC
  clipsPerRun: integer("clips_per_run").default(3),
  minConfidence: integer("min_confidence").default(0), // 0-100; below → review even in auto mode
  autoPost: integer("auto_post", { mode: "boolean" }).default(false), // false = approval queue
  template: text("template"),                      // JSON: clips/process param set
  lastRunAt: text("last_run_at"),                  // ISO of last engine run
  lastVodId: text("last_vod_id"),                  // last source VOD processed (dedupe)
  nextRunAt: text("next_run_at"),                  // ISO; engine picks up when due
  lastError: text("last_error"),
  // ── Live mode: clip the creator's stream WHILE it's live, in windows of
  // the in-progress VOD. State is per broadcast and resets on a new one. ──
  liveMode: integer("live_mode", { mode: "boolean" }).default(false),
  liveVodId: text("live_vod_id"),                  // broadcast VOD being followed
  liveOffset: real("live_offset").default(0),      // seconds of it already scanned
  liveClips: integer("live_clips").default(0),     // clips produced from it (≤ clipsPerRun)
  liveBaseline: real("live_baseline"),             // running chat baseline (msgs/5s) so far
  liveSamples: integer("live_samples").default(0), // samples behind that baseline
  liveState: text("live_state"),                   // 'offline' | 'live' | 'vods_off' (for the UI)
  liveScoreRef: real("live_score_ref"),            // running mean of each window's best moment score
  liveWindows: integer("live_windows").default(0), // windows behind that mean
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Saved editing styles ("copy this clip's style"): a ClipStyle recipe (see
// lib/clip-style.ts) extracted from a reference clip. Applied by Auto-edit,
// Schedule-a-week and Auto-Pilot (template.styleRef).
export const clipStyles = sqliteTable("clip_styles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  style: text("style").notNull(),                  // JSON ClipStyle
  source: text("source"),                          // reference link / file name (display only)
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// Mobile refresh tokens — one row per logged-in device, so a session can be
// revoked (logout-this-device / logout-all-devices) unlike a bare JWT.
export const refreshTokens = sqliteTable("refresh_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  deviceId: text("device_id"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
});

// Generic async job envelope for long-running AI-assist work the mobile app
// polls for instead of holding a foreground request open (some routes run
// up to 300s). `type` matches a registered handler in src/lib/jobs.ts.
export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  status: text("status").notNull().default("queued"), // 'queued' | 'running' | 'done' | 'error'
  input: text("input"),   // JSON
  result: text("result"), // JSON
  error: text("error"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export type User = typeof users.$inferSelect;
export type Clip = typeof clips.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Analytics = typeof analytics.$inferSelect;
export type AutoResponse = typeof autoResponses.$inferSelect;
export type AccountStat = typeof accountStats.$inferSelect;
export type Todo = typeof todos.$inferSelect;
export type AutoPilot = typeof autoPilots.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
