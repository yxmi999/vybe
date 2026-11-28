// Temporary editor snapshots so "Back to editor" on the Compose page can
// reopen a project with every edit intact. Only small JSON lives here, in the
// browser — the source video, music and overlays are already in server
// storage — so it costs no extra space. A session is deleted once its video
// is scheduled/posted, and expires after SESSION_TTL_DAYS (the free-tier
// source TTL, after which the source video itself may be gone).

const PREFIX = "vybe:edit-session:";
const SESSION_TTL_DAYS = 7;
const MAX_SESSIONS = 5;

export type EditSession<T = unknown> = {
  v: 1;
  id: string;
  savedAt: number;
  exportUrl: string;
  title: string;
  data: T;
};

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function expired(s: EditSession): boolean {
  return Date.now() - s.savedAt > SESSION_TTL_DAYS * 86_400_000;
}

function allSessions(ls: Storage): EditSession[] {
  const out: EditSession[] = [];
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try { out.push(JSON.parse(ls.getItem(key) ?? "")); } catch { /* corrupt → pruned below */ }
  }
  return out;
}

/** Drop expired sessions and keep only the newest MAX_SESSIONS - 1 (room for one more). */
function prune(ls: Storage) {
  const keep = allSessions(ls)
    .filter((s) => s?.id && !expired(s))
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_SESSIONS - 1)
    .map((s) => PREFIX + s.id);
  const keys: string[] = [];
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k?.startsWith(PREFIX)) keys.push(k); }
  for (const k of keys) if (!keep.includes(k)) ls.removeItem(k);
}

/** Save a snapshot; returns its id, or null if the browser won't store it. */
export function saveEditSession<T>(data: T, exportUrl: string, title: string): string | null {
  const ls = storage();
  if (!ls) return null;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const session: EditSession<T> = { v: 1, id, savedAt: Date.now(), exportUrl, title, data };
  try {
    prune(ls);
    ls.setItem(PREFIX + id, JSON.stringify(session));
    return id;
  } catch {
    return null; // quota exceeded / storage blocked — Compose falls back to "Edit in editor"
  }
}

export function loadEditSession<T = unknown>(id: string | null | undefined): EditSession<T> | null {
  const ls = storage();
  if (!ls || !id) return null;
  try {
    const s = JSON.parse(ls.getItem(PREFIX + id) ?? "null") as EditSession<T> | null;
    if (!s || s.v !== 1) return null;
    if (expired(s)) { ls.removeItem(PREFIX + id); return null; }
    return s;
  } catch {
    return null;
  }
}

export function deleteEditSession(id: string | null | undefined) {
  const ls = storage();
  if (!ls || !id) return;
  try { ls.removeItem(PREFIX + id); } catch { /* ignore */ }
}
