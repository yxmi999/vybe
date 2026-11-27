import { db } from "./db";
import { autoResponses, accounts, posts } from "./schema";
import { eq, and } from "drizzle-orm";
import * as youtube from "./platforms/youtube";
import * as instagram from "./platforms/instagram";
import { getFreshInstagramToken } from "./instagram-account";

async function getFreshYoutubeToken(account: typeof accounts.$inferSelect): Promise<string> {
  const expiresAt = account.tokenExpiry ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now > 300) return account.accessToken;

  if (!account.refreshToken) throw new Error("YouTube token expired and no refresh token. Please reconnect your YouTube account.");

  const tokens = await youtube.refreshAccessToken(account.refreshToken);
  await db.update(accounts).set({
    accessToken: tokens.access_token,
    tokenExpiry: now + (tokens.expires_in ?? 3600),
  }).where(eq(accounts.id, account.id));

  return tokens.access_token;
}

export async function runAutoResponder(): Promise<{ checked: number; replied: number }> {
  const rules = await db
    .select({ rule: autoResponses, account: accounts })
    .from(autoResponses)
    .innerJoin(accounts, eq(autoResponses.accountId, accounts.id))
    .where(and(eq(autoResponses.isActive, true), eq(autoResponses.respondToComments, true)));

  let checked = 0;
  let replied = 0;

  for (const { rule, account } of rules) {
    try {
      const accountPosts = await db
        .select()
        .from(posts)
        .where(and(eq(posts.accountId, account.id), eq(posts.status, "published")));

      const checkedAt = new Date().toISOString();

      for (const post of accountPosts) {
        if (!post.platformPostId) continue;

        if (account.platform === "youtube") {
          const accessToken = await getFreshYoutubeToken(account);
          const comments = await youtube.getVideoComments(accessToken, post.platformPostId);

          const since = rule.lastCheckedAt
            ? new Date(rule.lastCheckedAt).getTime()
            : post.publishedAt
            ? new Date(post.publishedAt).getTime()
            : 0;

          for (const comment of comments) {
            checked++;
            if (new Date(comment.publishedAt).getTime() <= since) continue;
            if (!comment.canReply) continue;

            const keyword = rule.triggerKeyword?.toLowerCase().trim();
            if (keyword && !comment.text.toLowerCase().includes(keyword)) continue;

            await youtube.replyToComment(accessToken, comment.threadId, rule.responseTemplate);
            replied++;
          }
        } else if (account.platform === "instagram") {
          const igToken = await getFreshInstagramToken(account);
          const comments = await instagram.getComments(igToken, post.platformPostId);

          // Use publishedAt as fallback (consistent with YouTube) to avoid replying to all old comments on first run
          const since = rule.lastCheckedAt
            ? new Date(rule.lastCheckedAt).getTime()
            : post.publishedAt
            ? new Date(post.publishedAt).getTime()
            : 0;

          for (const comment of comments) {
            checked++;
            const commentTime = new Date(comment.timestamp).getTime();
            if (commentTime <= since) continue;

            const keyword = rule.triggerKeyword?.toLowerCase().trim();
            if (keyword && !comment.text.toLowerCase().includes(keyword)) continue;

            await instagram.replyToComment(igToken, comment.id, rule.responseTemplate);
            replied++;
          }
        }
      }

      await db
        .update(autoResponses)
        .set({ lastCheckedAt: checkedAt })
        .where(eq(autoResponses.id, rule.id));
    } catch (err) {
      console.error(`[auto-responder] rule ${rule.id} (account ${account.platform} @${account.username}):`, err);
    }
  }

  return { checked, replied };
}
