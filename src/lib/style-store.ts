import { and, desc, eq } from "drizzle-orm";
import { db, client } from "./db";
import { clipStyles } from "./schema";
import { BUILTIN_STYLES, clipStyleSchema, sanitizeStyle, type ClipStyle } from "./clip-style";

// The table also lives in migrate(), but batch/cron callers can run before the
// app ever hit /api/init — make sure it exists (once per process).
let ensured: Promise<void> | null = null;
export function ensureStylesTable(): Promise<void> {
  ensured ??= client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS clip_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      style TEXT NOT NULL,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_clip_styles_user ON clip_styles(user_id);
  `).then(() => undefined).catch((err) => { ensured = null; throw err; });
  return ensured;
}

// A style reference as stored in templates / sent by the client:
//   "builtin:hype"  → a preset from BUILTIN_STYLES
//   "user:12" or 12 → a saved row in clip_styles (owned by the user)
export type StyleRef = string | number;

export type StoredStyle = { ref: string; id: number | null; name: string; style: ClipStyle; source: string | null; builtin: boolean };

export function builtinStyles(): StoredStyle[] {
  return Object.entries(BUILTIN_STYLES).map(([key, style]) => ({
    ref: `builtin:${key}`, id: null, name: style.name, style, source: null, builtin: true,
  }));
}

function parseRow(row: typeof clipStyles.$inferSelect): StoredStyle | null {
  try {
    const parsed = clipStyleSchema.safeParse(JSON.parse(row.style));
    if (!parsed.success) return null;
    return { ref: `user:${row.id}`, id: row.id, name: row.name, style: sanitizeStyle(parsed.data), source: row.source, builtin: false };
  } catch {
    return null;
  }
}

export async function listUserStyles(userId: number): Promise<StoredStyle[]> {
  await ensureStylesTable();
  const rows = await db.select().from(clipStyles).where(eq(clipStyles.userId, userId)).orderBy(desc(clipStyles.id));
  return rows.map(parseRow).filter((s): s is StoredStyle => !!s);
}

export async function resolveStyle(userId: number, ref: StyleRef | null | undefined): Promise<ClipStyle | null> {
  if (ref == null || ref === "") return null;
  const s = String(ref);
  if (s.startsWith("builtin:")) return BUILTIN_STYLES[s.slice(8)] ?? null;
  const id = Number(s.startsWith("user:") ? s.slice(5) : s);
  if (!Number.isInteger(id)) return null;
  await ensureStylesTable();
  const [row] = await db.select().from(clipStyles)
    .where(and(eq(clipStyles.id, id), eq(clipStyles.userId, userId))).limit(1);
  return row ? parseRow(row)?.style ?? null : null;
}

// Accepts an inline style object from the client (validated) — lets the editor
// use a freshly analyzed style before it's saved.
export function parseInlineStyle(v: unknown): ClipStyle | null {
  const parsed = clipStyleSchema.safeParse(v);
  return parsed.success ? sanitizeStyle(parsed.data) : null;
}
