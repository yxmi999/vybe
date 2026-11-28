// Pure auto-reply rule logic — shared by the server responder and the
// "try a comment" tester on the Auto-Respond page, so both always agree.

export const AUTO_REPLY_PLATFORMS = ["youtube", "instagram"] as const;
/** Anti-spam caps per account: platforms flag accounts that reply in bursts. */
export const MAX_REPLIES_PER_RUN = 10;
export const MAX_REPLIES_PER_DAY = 100;
/** Only look at recent posts: old videos rarely get comments and cost API quota. */
export const POST_WINDOW_DAYS = 30;
export const MAX_POSTS_PER_RUN = 25;
export const MAX_TEMPLATE_LENGTH = 500;
/** Separator between reply variations inside the stored template. */
export const VARIANT_SEPARATOR = "\n---\n";

export type RuleLike = {
  id: number;
  triggerKeyword: string | null;
  responseTemplate: string;
};

/** "price, link , collab" → ["price", "link", "collab"]. Empty = match every comment. */
export function parseKeywords(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word, case-insensitive match for any keyword ("link" matches "link?"
 * but not "unlinked"). Keywords that aren't word-like (emoji, "$$") fall back
 * to a plain substring match.
 */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const t = text.toLowerCase();
  return keywords.some((k) => {
    if (!/[\p{L}\p{N}]/u.test(k)) return t.includes(k);
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(k)}($|[^\\p{L}\\p{N}_])`, "u").test(t);
  });
}

export function splitVariants(template: string): string[] {
  return template.split(/\n-{3,}\n/).map((v) => v.trim()).filter(Boolean);
}

export function joinVariants(variants: string[]): string {
  return variants.map((v) => v.trim()).filter(Boolean).join(VARIANT_SEPARATOR);
}

/** Fill {name} with the commenter's name (handle without "@"). */
export function renderReply(variant: string, ctx: { name?: string | null }): string {
  const name = (ctx.name ?? "").replace(/^@/, "").trim();
  return variant
    .replace(/\{\s*(name|username)\s*\}/gi, name || "there")
    .replace(/[ \t]{2,}/g, " ")   // tidy doubled spaces, keep line breaks
    .trim();
}

/**
 * Pick a variation. Seeded by the comment id so a retried reply is the same
 * text, while different comments get different variations.
 */
export function pickVariant(template: string, seed: string): string {
  const variants = splitVariants(template);
  if (variants.length === 0) return "";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return variants[Math.abs(h) % variants.length];
}

/**
 * Which rule answers a comment: keyword rules first (more specific), then
 * catch-alls; ties go to the oldest rule. At most one reply per comment.
 */
export function pickRule<R extends RuleLike>(rules: R[], text: string): R | null {
  const ordered = [...rules].sort((a, b) => {
    const ak = parseKeywords(a.triggerKeyword).length > 0 ? 0 : 1;
    const bk = parseKeywords(b.triggerKeyword).length > 0 ? 0 : 1;
    return ak - bk || a.id - b.id;
  });
  return ordered.find((r) => matchesKeywords(text, parseKeywords(r.triggerKeyword))) ?? null;
}

/** SQLite datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC) or ISO → ms. */
export function parseDbTime(s: string | null | undefined): number {
  if (!s) return 0;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}
