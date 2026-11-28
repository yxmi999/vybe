// Auto-replies to new comments on published posts (YouTube + Instagram).
// Called by the cron (/api/scheduler, every 5 min) for everyone, and by
// "Run now" on the Auto-Respond page for one user.
//
// Safety rules, in order of importance:
//  1. Never reply twice to the same comment. Each comment is claimed in
//     auto_response_log (UNIQUE account+comment) *before* the reply is sent,
//     so overlapping runs or a crash mid-run can't double-post.
//  2. Never reply to the account's own comments, or to threads the owner
//     already answered by hand.
//  3. One reply per comment even when several rules match (keyword rules win).
//  4. Cap replies per run and per day, per account — bursts get accounts flagged.
import { db } from "./db";
import { autoResponses, autoResponseLog, accounts, posts } from "./schema";
import { eq, and, gte, isNotNull, desc, inArray, sql } from "drizzle-orm";
import * as youtube from "./platforms/youtube";
import * as instagram from "./platforms/instagram";
import { getFreshInstagramToken } from "./instagram-account";
import { getFreshYoutubeToken } from "./post-metrics";
import {
  AUTO_REPLY_PLATFORMS, MAX_REPLIES_PER_RUN, MAX_REPLIES_PER_DAY, POST_WINDOW_DAYS, MAX_POSTS_PER_RUN,
  MAX_TEMPLATE_LENGTH, parseKeywords, matchesKeywords, pickVariant, renderReply, parseDbTime,
} from "./auto-reply";

type Rule = typeof autoResponses.$inferSelect;
type Account = typeof accounts.$inferSelect;

/** A comment normalised across platforms. */
type Comment = {
  id: string;            // what we reply to (YouTube thread id / IG comment id)
  text: string;
  author: string;
  at: number;            // ms
  isOwn: boolean;
  ownerReplied: boolean;
  canReply: boolean;
};

export type AutoResponderResult = { checked: number; replied: number; failed: number; skipped: number; errors: string[] };

function errMsg(err: unknown): string {
  const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
  return e?.response?.data?.error?.message ?? e?.message ?? String(err);
}

async function loadComments(account: Account, token: string, platformPostId: string): Promise<Comment[]> {
  if (account.platform === "youtube") {
    const list = await youtube.getVideoComments(token, platformPostId);
    return list.map((c: Awaited<ReturnType<typeof youtube.getVideoComments>>[number]) => ({
      id: c.threadId,
      text: c.text,
      author: c.author,
      at: new Date(c.publishedAt).getTime(),
      isOwn: !!c.authorChannelId && c.authorChannelId === account.platformUserId,
      ownerReplied: !!account.platformUserId && c.replyAuthorIds.includes(account.platformUserId),
      canReply: c.canReply,
    }));
  }
  const me = account.username.replace(/^@/, "").toLowerCase();
  const list = await instagram.getComments(token, platformPostId);
  return list.map((c) => ({
    id: c.id,
    text: c.text ?? "",
    author: c.username,
    at: new Date(c.timestamp).getTime(),
    isOwn: c.username?.toLowerCase() === me,
    ownerReplied: c.replyUsernames.some((u) => u.toLowerCase() === me),
    canReply: true,
  }));
}

async function sendReply(account: Account, token: string, commentId: string, text: string) {
  if (account.platform === "youtube") await youtube.replyToComment(token, commentId, text);
  else await instagram.replyToComment(token, commentId, text);
}

async function tokenFor(account: Account): Promise<string> {
  return account.platform === "youtube" ? getFreshYoutubeToken(account) : getFreshInstagramToken(account);
}

async function repliesToday(accountId: number): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(autoResponseLog)
    .where(and(eq(autoResponseLog.accountId, accountId), eq(autoResponseLog.status, "sent"), gte(autoResponseLog.createdAt, since)));
  return Number(row?.n ?? 0);
}

async function runForAccount(account: Account, rules: Rule[], result: AutoResponderResult) {
  const runStartedAt = new Date().toISOString();
  const ruleIds = rules.map((r) => r.id);
  // Each rule only answers comments newer than when it was created / last checked.
  const cutoff = new Map(rules.map((r) => [r.id, Math.max(parseDbTime(r.createdAt), parseDbTime(r.lastCheckedAt))]));
  const ruleErrors = new Map<number, string>();
  let fetchFailed = false;
  let heldBack = 0;

  let token: string;
  try {
    token = await tokenFor(account);
  } catch (err) {
    const msg = `Couldn't sign in to @${account.username}: ${errMsg(err)}. Reconnect the account on the Accounts page.`;
    result.errors.push(msg);
    await db.update(autoResponses).set({ lastError: msg }).where(inArray(autoResponses.id, ruleIds));
    return;
  }

  let budget = Math.min(MAX_REPLIES_PER_RUN, MAX_REPLIES_PER_DAY - (await repliesToday(account.id)));
  const windowStart = new Date(Date.now() - POST_WINDOW_DAYS * 86_400_000).toISOString();
  const recentPosts = await db.select({ id: posts.id, platformPostId: posts.platformPostId, publishedAt: posts.publishedAt })
    .from(posts)
    .where(and(eq(posts.accountId, account.id), eq(posts.status, "published"), isNotNull(posts.platformPostId), gte(posts.publishedAt, windowStart)))
    .orderBy(desc(posts.publishedAt))
    .limit(MAX_POSTS_PER_RUN);

  // Keyword rules first, oldest first — see pickRule in lib/auto-reply.
  const ordered = [...rules].sort((a, b) =>
    (parseKeywords(a.triggerKeyword).length ? 0 : 1) - (parseKeywords(b.triggerKeyword).length ? 0 : 1) || a.id - b.id);

  for (const post of recentPosts) {
    if (budget <= 0) break;
    let comments: Comment[];
    try {
      comments = await loadComments(account, token, post.platformPostId!);
    } catch (err) {
      fetchFailed = true;
      const msg = `Couldn't read comments: ${errMsg(err)}`;
      for (const id of ruleIds) ruleErrors.set(id, msg);
      console.error(`[auto-responder] @${account.username} post ${post.id}:`, errMsg(err));
      continue;
    }

    // Oldest first, so the earliest commenters are answered when the budget runs out.
    for (const c of comments.sort((a, b) => a.at - b.at)) {
      result.checked++;
      if (c.isOwn || c.ownerReplied || !c.canReply || !c.text.trim()) continue;
      const rule = ordered.find((r) => c.at > (cutoff.get(r.id) ?? 0) && matchesKeywords(c.text, parseKeywords(r.triggerKeyword)));
      if (!rule) continue;
      if (budget <= 0) { result.skipped++; heldBack++; continue; }

      const reply = renderReply(pickVariant(rule.responseTemplate, c.id), { name: c.author }).slice(0, MAX_TEMPLATE_LENGTH);
      if (!reply) continue;

      // Claim the comment. If the row already exists, this comment was handled.
      const claimed = await db.insert(autoResponseLog).values({
        ruleId: rule.id, accountId: account.id, postId: post.id, commentId: c.id,
        commentAuthor: c.author, commentText: c.text.slice(0, 1000), replyText: reply, status: "pending",
      }).onConflictDoNothing().returning({ id: autoResponseLog.id });
      if (claimed.length === 0) continue;

      try {
        await sendReply(account, token, c.id, reply);
        await db.update(autoResponseLog).set({ status: "sent" }).where(eq(autoResponseLog.id, claimed[0].id));
        await db.update(autoResponses).set({
          repliesSent: sql`COALESCE(${autoResponses.repliesSent}, 0) + 1`,
          lastReplyAt: new Date().toISOString(),
        }).where(eq(autoResponses.id, rule.id));
        result.replied++;
        budget--;
      } catch (err) {
        const msg = errMsg(err);
        await db.update(autoResponseLog).set({ status: "failed", error: msg.slice(0, 500) }).where(eq(autoResponseLog.id, claimed[0].id));
        ruleErrors.set(rule.id, `Reply failed: ${msg}`);
        result.failed++;
      }
    }
  }

  if (heldBack > 0 || budget <= 0) {
    result.errors.push(`@${account.username}: reply limit reached (${MAX_REPLIES_PER_RUN}/run, ${MAX_REPLIES_PER_DAY}/day) — the rest will be answered on the next runs.`);
  }

  // Advance the cursor only when every post was read and nothing was held back
  // by the budget; otherwise the next run looks again (the log stops repeats).
  const advance = !fetchFailed && heldBack === 0 && budget > 0;
  for (const r of rules) {
    await db.update(autoResponses).set({
      ...(advance ? { lastCheckedAt: runStartedAt } : {}),
      lastError: ruleErrors.get(r.id) ?? null,
    }).where(eq(autoResponses.id, r.id));
  }
  for (const msg of new Set(ruleErrors.values())) result.errors.push(`@${account.username}: ${msg}`);
}

/** Run every active rule, or only one user's rules when `userId` is given. */
export async function runAutoResponder(opts: { userId?: number } = {}): Promise<AutoResponderResult> {
  const conds = [
    eq(autoResponses.isActive, true),
    eq(autoResponses.respondToComments, true),
    eq(accounts.isActive, true),
    inArray(accounts.platform, [...AUTO_REPLY_PLATFORMS]),
  ];
  if (opts.userId != null) conds.push(eq(accounts.userId, opts.userId));

  const rows = await db.select({ rule: autoResponses, account: accounts })
    .from(autoResponses)
    .innerJoin(accounts, eq(autoResponses.accountId, accounts.id))
    .where(and(...conds));

  const byAccount = new Map<number, { account: Account; rules: Rule[] }>();
  for (const { rule, account } of rows) {
    const entry = byAccount.get(account.id) ?? { account, rules: [] };
    entry.rules.push(rule);
    byAccount.set(account.id, entry);
  }

  const result: AutoResponderResult = { checked: 0, replied: 0, failed: 0, skipped: 0, errors: [] };
  for (const { account, rules } of byAccount.values()) {
    try {
      await runForAccount(account, rules, result);
    } catch (err) {
      console.error(`[auto-responder] account ${account.platform} @${account.username}:`, err);
      result.errors.push(`@${account.username}: ${errMsg(err)}`);
    }
  }
  return result;
}
