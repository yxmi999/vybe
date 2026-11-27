import { db } from "./db";
import { posts, accounts, analytics } from "./schema";
import { eq, and, lte } from "drizzle-orm";
import axios from "axios";
import * as instagram from "./platforms/instagram";
import * as twitter from "./platforms/twitter";
import * as tiktok from "./platforms/tiktok";
import * as youtube from "./platforms/youtube";
import { getFreshInstagramToken, instagramErrorMessage } from "./instagram-account";

const TRANSIENT_CODES = new Set(["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"]);

function isTransient(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return TRANSIENT_CODES.has((err as { code: string }).code);
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === retries - 1) break;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function getFreshTwitterToken(account: typeof accounts.$inferSelect): Promise<string> {
  const expiresAt = account.tokenExpiry ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now > 300) return account.accessToken;

  if (!account.refreshToken) {
    throw new Error("Twitter token expired and no refresh token available. Please reconnect your Twitter account.");
  }

  const tokens = await twitter.refreshAccessToken(account.refreshToken);
  await db.update(accounts).set({
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    tokenExpiry: now + (tokens.expires_in ?? 7200),
  }).where(eq(accounts.id, account.id));

  return tokens.access_token;
}

async function getFreshYoutubeToken(account: typeof accounts.$inferSelect): Promise<string> {
  // Refresh if token expires within the next 5 minutes
  const expiresAt = account.tokenExpiry ?? 0;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt - now > 300) return account.accessToken;

  if (!account.refreshToken) throw new Error("YouTube token expired and no refresh token available. Please reconnect your YouTube account.");

  const tokens = await youtube.refreshAccessToken(account.refreshToken);
  await db.update(accounts).set({
    accessToken: tokens.access_token,
    tokenExpiry: now + (tokens.expires_in ?? 3600),
  }).where(eq(accounts.id, account.id));

  return tokens.access_token;
}

export async function runScheduler() {
  const now = new Date().toISOString();

  const due = await db
    .select({ post: posts, account: accounts })
    .from(posts)
    .innerJoin(accounts, eq(posts.accountId, accounts.id))
    .where(and(eq(posts.status, "scheduled"), lte(posts.scheduledAt, now)));

  for (const { post, account } of due) {
    try {
      const mediaUrls: string[] = post.mediaUrls ? JSON.parse(post.mediaUrls) : [];
      let platformPostId: string | null = null;

      if (account.platform === "twitter") {
        const twitterToken = await getFreshTwitterToken(account);
        try {
          platformPostId = await withRetry(() =>
            twitter.publishTweet(twitterToken, post.content)
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("invalid_grant") || msg.includes("Token has been expired")) {
            throw new Error("Twitter token expired and could not be refreshed. Please reconnect your Twitter account in Settings → Connected Accounts.");
          }
          if (msg.includes("402") || (err as { response?: { status?: number } })?.response?.status === 402) {
            throw new Error("Twitter API requires a paid plan (Basic at $100/month) to post tweets. Upgrade at developer.twitter.com/en/portal/products.");
          }
          throw err;
        }
      } else if (account.platform === "instagram") {
        if (!account.platformUserId) throw new Error("Missing Instagram account ID — reconnect Instagram on the Accounts page.");
        if (mediaUrls.length === 0) throw new Error("Instagram needs a video (Reel) or at least one image. Add media in the compose form.");
        // Videos always go out as Reels (Instagram retired plain feed videos). A Reel is a single video; otherwise publish the images (carousel if several).
        const video = mediaUrls.find(instagram.isVideoUrl);
        const media = video ? [video] : mediaUrls.filter((u) => !instagram.isVideoUrl(u)).slice(0, 10);
        const accessToken = await getFreshInstagramToken(account);
        // No withRetry: a network blip after media_publish succeeded would double-post.
        try {
          platformPostId = await instagram.publishMedia(accessToken, account.platformUserId, {
            caption: post.content,
            mediaUrls: media,
          });
        } catch (err) {
          throw new Error(instagramErrorMessage(err));
        }
      } else if (account.platform === "tiktok") {
        throw new Error("TikTok video upload requires direct file upload — not yet supported in the scheduler.");
      } else if (account.platform === "youtube") {
        const videoPath = mediaUrls[0];
        if (!videoPath) throw new Error("YouTube requires a video file. Upload a video in the compose form.");
        const meta = post.metadata ? JSON.parse(post.metadata) : {};
        const title = meta.videoTitle || post.content.slice(0, 100);
        const accessToken = await getFreshYoutubeToken(account);
        platformPostId = await withRetry(() =>
          youtube.uploadVideo(
            accessToken,
            videoPath,
            title,
            post.content,
            meta.isShort ?? false,
            meta.tags ?? [],
            meta.category ?? "22",
            meta.privacy ?? "public"
          )
        );
      }

      await db
        .update(posts)
        .set({ status: "published", platformPostId, publishedAt: new Date().toISOString() })
        .where(eq(posts.id, post.id));

      if (platformPostId) {
        await db.insert(analytics).values({ postId: post.id });
      }
    } catch (err: unknown) {
      let message = err instanceof Error ? err.message : String(err);
      if (axios.isAxiosError(err) && err.response && !message.includes("Twitter API")) {
        message = `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`;
      } else if (isTransient({ code: (err as { code?: string })?.code })) {
        message = `Network error (${(err as { code?: string })?.code ?? "ENOTFOUND"}): Could not reach the platform API. The post will retry on the next scheduler run.`;
      }
      console.error(`[scheduler] Post ${post.id} failed:`, message);
      await db
        .update(posts)
        .set({ status: "failed", errorMessage: message })
        .where(eq(posts.id, post.id));
    }
  }
}
