import { client } from "./db";

export async function migrate() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_expiry INTEGER,
      platform_user_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      content TEXT NOT NULL,
      media_urls TEXT,
      metadata TEXT,
      scheduled_at TEXT NOT NULL,
      status TEXT DEFAULT 'scheduled',
      platform_post_id TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      published_at TEXT
    );

    CREATE TABLE IF NOT EXISTS analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      reach INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auto_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      trigger_keyword TEXT,
      response_template TEXT NOT NULL,
      respond_to_likes INTEGER DEFAULT 0,
      respond_to_comments INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT,
      url TEXT,
      note TEXT,
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      kind TEXT NOT NULL,
      counts_quota INTEGER DEFAULT 1,
      size_bytes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_clips_user ON clips(user_id);
    CREATE INDEX IF NOT EXISTS idx_clips_expires ON clips(expires_at);

    CREATE TABLE IF NOT EXISTS auto_pilots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER DEFAULT 1,
      platform TEXT NOT NULL,
      channel TEXT NOT NULL,
      target_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      cadence TEXT NOT NULL,
      days TEXT,
      post_times TEXT,
      clips_per_run INTEGER DEFAULT 3,
      min_confidence INTEGER DEFAULT 0,
      auto_post INTEGER DEFAULT 0,
      template TEXT,
      last_run_at TEXT,
      last_vod_id TEXT,
      next_run_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_auto_pilots_user ON auto_pilots(user_id);
    CREATE INDEX IF NOT EXISTS idx_auto_pilots_due ON auto_pilots(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      input TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);

    CREATE TABLE IF NOT EXISTS clip_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      style TEXT NOT NULL,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_clip_styles_user ON clip_styles(user_id);

    -- Defined in schema.ts but was never created here, so account stats
    -- refresh failed with "Failed query: select … from account_stats".
    CREATE TABLE IF NOT EXISTS account_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      followers INTEGER DEFAULT 0,
      following INTEGER DEFAULT 0,
      posts INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_account_stats_account ON account_stats(account_id);

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cpm REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      max_payout REAL,
      min_payout REAL,
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);

    -- Every real charge from any provider, one row per provider payment.
    -- UNIQUE(provider, external_id) makes webhook re-deliveries idempotent and
    -- is what affiliate commissions hang off.
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      refunded INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

    CREATE TABLE IF NOT EXISTS affiliate_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL,
      method TEXT,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'requested',
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      settled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_user ON affiliate_payouts(user_id);

    -- One row per commission earned (or reversed via a negative adjustment row).
    CREATE TABLE IF NOT EXISTS referral_commissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'commission',
      amount_cents INTEGER NOT NULL,
      rate_pct REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'earned',
      available_at TEXT NOT NULL,
      payout_id INTEGER REFERENCES affiliate_payouts(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ref_comm_referrer ON referral_commissions(referrer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ref_comm_payment_kind ON referral_commissions(payment_id, kind);

    -- Exports that had the Vybe watermark burned in. Kept separately from the
    -- clips ledger because free-tier clip rows are deleted after 7 days, and the
    -- leaderboard still needs to know the video was watermarked.
    CREATE TABLE IF NOT EXISTS watermarked_exports (
      url TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_watermarked_exports_user ON watermarked_exports(user_id);
  `);

  // Idempotent column additions for databases created before these columns existed
  for (const sql of [
    "ALTER TABLE posts ADD COLUMN metadata TEXT",
    "ALTER TABLE posts ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL",
    "ALTER TABLE campaigns ADD COLUMN min_payout REAL",
    "ALTER TABLE auto_pilots ADD COLUMN live_mode INTEGER DEFAULT 0",
    "ALTER TABLE auto_pilots ADD COLUMN live_vod_id TEXT",
    "ALTER TABLE auto_pilots ADD COLUMN live_offset REAL DEFAULT 0",
    "ALTER TABLE auto_pilots ADD COLUMN live_clips INTEGER DEFAULT 0",
    "ALTER TABLE auto_pilots ADD COLUMN live_baseline REAL",
    "ALTER TABLE auto_pilots ADD COLUMN live_samples INTEGER DEFAULT 0",
    "ALTER TABLE auto_pilots ADD COLUMN live_state TEXT",
    "ALTER TABLE auto_pilots ADD COLUMN live_score_ref REAL",
    "ALTER TABLE auto_pilots ADD COLUMN live_windows INTEGER DEFAULT 0",
    "ALTER TABLE auto_pilots ADD COLUMN timezone TEXT",
    "ALTER TABLE accounts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
    "ALTER TABLE auto_responses ADD COLUMN last_checked_at TEXT",
    "ALTER TABLE users ADD COLUMN billing_provider TEXT",
    "ALTER TABLE users ADD COLUMN paddle_customer_id TEXT",
    "ALTER TABLE users ADD COLUMN paddle_subscription_id TEXT",
    "ALTER TABLE users ADD COLUMN subscription_status TEXT",
    "ALTER TABLE users ADD COLUMN current_period_end TEXT",
    "ALTER TABLE users ADD COLUMN keep_watermark INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN polar_subscription_id TEXT",
    "ALTER TABLE users ADD COLUMN referral_code TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)",
    "ALTER TABLE users ADD COLUMN referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL",
    "ALTER TABLE users ADD COLUMN referred_at TEXT",
    "ALTER TABLE users ADD COLUMN payout_method TEXT",
    "ALTER TABLE users ADD COLUMN payout_details TEXT",
    "ALTER TABLE users ADD COLUMN leaderboard_hidden INTEGER DEFAULT 0",
    // Drop the earlier Stripe-specific columns if a prior build added them.
    "ALTER TABLE users DROP COLUMN stripe_customer_id",
    "ALTER TABLE users DROP COLUMN stripe_subscription_id",
  ]) {
    try { await client.execute(sql); } catch { /* already exists */ }
  }

  // Email verification. Only on the run that first adds the column, every
  // existing account is grandfathered in as verified, so current users keep
  // their free clips. New email sign-ups start unverified.
  try {
    await client.execute("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
    await client.execute("UPDATE users SET email_verified_at = datetime('now') WHERE email_verified_at IS NULL");
  } catch { /* already exists */ }

  // Affiliate fraud protection + payout identity (see lib/affiliate-safety.ts).
  await client.executeMultiple(`
    -- Hashed IP / device ids seen per user (never raw IPs). Compared across
    -- users to spot self-referrals and referral farms.
    CREATE TABLE IF NOT EXISTS user_signals (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,              -- 'ip' | 'device'
      value_hash TEXT NOT NULL,
      first_event TEXT,                -- 'signup' | 'login' | 'payout'
      first_seen TEXT,
      last_seen TEXT,
      PRIMARY KEY (user_id, kind, value_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_user_signals_value ON user_signals(kind, value_hash);

    -- Who we're paying: collected at the first payout request.
    CREATE TABLE IF NOT EXISTS affiliate_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      legal_name TEXT,
      country TEXT,
      address TEXT,
      us_person INTEGER DEFAULT 0,
      terms_version TEXT,
      terms_accepted_at TEXT,
      id_status TEXT DEFAULT 'none',   -- 'none' | 'pending' | 'verified' | 'rejected'
      id_note TEXT,
      tax_form_on_file INTEGER DEFAULT 0,
      updated_at TEXT
    );
  `);
  for (const sql of [
    "ALTER TABLE referral_commissions ADD COLUMN reason TEXT",          // reversal cause: 'refund' | 'chargeback'
    "ALTER TABLE affiliate_payouts ADD COLUMN request_country TEXT",    // country the request came from
    "ALTER TABLE affiliate_payouts ADD COLUMN risk_snapshot TEXT",      // JSON flags at request time
  ]) {
    try { await client.execute(sql); } catch { /* already exists */ }
  }
}
