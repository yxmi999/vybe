// Account self-service: data export ("download my data") and permanent account
// deletion. Server-only.
//
// The DB is SQLite/libsql without `PRAGMA foreign_keys`, so the schema's
// ON DELETE CASCADE rules don't fire — every table is cleared explicitly here.
// Keep both lists in sync with schema.ts when adding a user-owned table.
import { client } from "./db";
import { deleteStored } from "./storage";
import { cancelPaddleSubscription, paddleEnabled } from "./paddle";
import { revokePolarSubscription, polarEnabled } from "./polar";

type Row = Record<string, unknown>;

const ACCOUNT_IDS = "SELECT id FROM accounts WHERE user_id = ?";
const POST_IDS = `SELECT id FROM posts WHERE account_id IN (${ACCOUNT_IDS})`;

// Columns that must never leave the server, even to the account owner.
const SECRET_COLUMNS = new Set(["password_hash", "access_token", "refresh_token", "token_hash"]);

function scrub(rows: Row[]): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (!SECRET_COLUMNS.has(k)) out[k] = parseJsonish(k, v);
    return out;
  });
}

// JSON-in-text columns read better in the export as real JSON.
const JSON_COLUMNS = new Set(["media_urls", "metadata", "days", "post_times", "template", "style", "input", "result"]);
function parseJsonish(key: string, v: unknown): unknown {
  if (!JSON_COLUMNS.has(key) || typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

async function rows(sql: string, userId: number): Promise<Row[]> {
  const res = await client.execute({ sql, args: [userId] });
  return res.rows.map((r) => ({ ...r }) as Row);
}

// ─── Export ──────────────────────────────────────────────────────────────────

export async function exportUserData(userId: number) {
  const [user] = await rows("SELECT * FROM users WHERE id = ?", userId);
  if (!user) return null;

  const [accounts, posts, analytics, autoResponses, accountStats, campaigns, todos, clips, autoPilots, clipStyles, jobs, sessions] =
    await Promise.all([
      rows("SELECT * FROM accounts WHERE user_id = ?", userId),
      rows(`SELECT * FROM posts WHERE account_id IN (${ACCOUNT_IDS}) ORDER BY scheduled_at`, userId),
      rows(`SELECT * FROM analytics WHERE post_id IN (${POST_IDS})`, userId),
      rows(`SELECT * FROM auto_responses WHERE account_id IN (${ACCOUNT_IDS})`, userId),
      rows(`SELECT * FROM account_stats WHERE account_id IN (${ACCOUNT_IDS})`, userId),
      rows("SELECT * FROM campaigns WHERE user_id = ?", userId),
      rows("SELECT * FROM todos WHERE user_id = ?", userId),
      rows("SELECT * FROM clips WHERE user_id = ? ORDER BY created_at", userId),
      rows("SELECT * FROM auto_pilots WHERE user_id = ?", userId),
      rows("SELECT * FROM clip_styles WHERE user_id = ?", userId),
      rows("SELECT id, type, status, error, created_at, updated_at FROM jobs WHERE user_id = ?", userId),
      rows("SELECT device_id, created_at, expires_at, revoked_at FROM refresh_tokens WHERE user_id = ?", userId),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    format: "vybe-export/1",
    note:
      "Everything Vybe stores about your account. Social-platform access tokens and your password hash are omitted for security. " +
      "Media files are listed by URL under `clips` and `posts` — download any you want to keep before deleting your account.",
    account: scrub([user])[0],
    connectedAccounts: scrub(accounts),
    posts: scrub(posts),
    postAnalytics: scrub(analytics),
    autoResponses: scrub(autoResponses),
    accountStats: scrub(accountStats),
    campaigns: scrub(campaigns),
    todos: scrub(todos),
    clips: scrub(clips),
    autoPilots: scrub(autoPilots),
    editingStyles: scrub(clipStyles),
    jobs: scrub(jobs),
    devices: scrub(sessions),
  };
}

// ─── Deletion ────────────────────────────────────────────────────────────────

/** Only our own storage — never try to delete someone else's URL. */
function isOwnStorage(url: string): boolean {
  return url.startsWith("/uploads/") || /\.blob\.vercel-storage\.com\//.test(url);
}

/**
 * Stop billing before the account disappears: an active card subscription is
 * cancelled immediately at the provider. Throws if that fails, so we never
 * delete a user who would keep getting charged. Crypto plans are prepaid
 * time-blocks with nothing to cancel.
 */
async function cancelBilling(user: Row): Promise<void> {
  const status = String(user.subscription_status ?? "");
  if (!["active", "trialing", "past_due"].includes(status)) return;
  if (user.billing_provider === "paddle" && user.paddle_subscription_id) {
    if (!paddleEnabled()) throw new Error("Card billing is unavailable right now");
    await cancelPaddleSubscription(String(user.paddle_subscription_id));
  } else if (user.billing_provider === "polar" && user.polar_subscription_id) {
    if (!polarEnabled()) throw new Error("Card billing is unavailable right now");
    await revokePolarSubscription(String(user.polar_subscription_id));
  }
}

export async function deleteUserAccount(userId: number): Promise<{ filesDeleted: number }> {
  const [user] = await rows("SELECT * FROM users WHERE id = ?", userId);
  if (!user) return { filesDeleted: 0 };

  await cancelBilling(user);

  // Collect stored media before the rows that point at it are gone.
  const urls = new Set<string>();
  for (const r of await rows("SELECT url FROM clips WHERE user_id = ?", userId)) {
    if (typeof r.url === "string") urls.add(r.url);
  }
  for (const r of await rows(`SELECT media_urls FROM posts WHERE account_id IN (${ACCOUNT_IDS})`, userId)) {
    const parsed = parseJsonish("media_urls", r.media_urls);
    if (Array.isArray(parsed)) for (const u of parsed) if (typeof u === "string") urls.add(u);
  }

  // One atomic write: either the whole account goes, or nothing does.
  const args = [userId];
  await client.batch([
    { sql: `DELETE FROM analytics WHERE post_id IN (${POST_IDS})`, args },
    { sql: `DELETE FROM posts WHERE account_id IN (${ACCOUNT_IDS})`, args },
    { sql: `DELETE FROM auto_responses WHERE account_id IN (${ACCOUNT_IDS})`, args },
    { sql: `DELETE FROM account_stats WHERE account_id IN (${ACCOUNT_IDS})`, args },
    { sql: "DELETE FROM auto_pilots WHERE user_id = ?", args },
    { sql: "DELETE FROM accounts WHERE user_id = ?", args },
    { sql: "DELETE FROM campaigns WHERE user_id = ?", args },
    { sql: "DELETE FROM todos WHERE user_id = ?", args },
    { sql: "DELETE FROM clips WHERE user_id = ?", args },
    { sql: "DELETE FROM clip_styles WHERE user_id = ?", args },
    { sql: "DELETE FROM refresh_tokens WHERE user_id = ?", args },
    { sql: "DELETE FROM jobs WHERE user_id = ?", args },
    { sql: "DELETE FROM users WHERE id = ?", args },
  ], "write");

  // Files last, best-effort (deleteStored never throws). A few at a time so a
  // big library doesn't fire hundreds of parallel requests.
  const own = [...urls].filter(isOwnStorage);
  for (let i = 0; i < own.length; i += 8) {
    await Promise.all(own.slice(i, i + 8).map((u) => deleteStored(u)));
  }
  return { filesDeleted: own.length };
}
