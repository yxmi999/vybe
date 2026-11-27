import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accountStats, accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import * as youtube from "@/lib/platforms/youtube";
import * as instagram from "@/lib/platforms/instagram";
import { getFreshInstagramToken } from "@/lib/instagram-account";
import * as twitter from "@/lib/platforms/twitter";
import * as tiktok from "@/lib/platforms/tiktok";

async function getFreshYoutubeToken(account: typeof accounts.$inferSelect): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if ((account.tokenExpiry ?? 0) - now > 300) return account.accessToken;
  if (!account.refreshToken) throw new Error("YouTube token expired — please reconnect.");
  const tokens = await youtube.refreshAccessToken(account.refreshToken);
  await db.update(accounts).set({
    accessToken: tokens.access_token,
    tokenExpiry: now + (tokens.expires_in ?? 3600),
  }).where(eq(accounts.id, account.id));
  return tokens.access_token;
}

async function upsertStat(
  accountId: number,
  stats: { followers: number; following: number; posts: number; views: number }
) {
  const fetchedAt = new Date().toISOString();
  const existing = await db
    .select({ id: accountStats.id })
    .from(accountStats)
    .where(eq(accountStats.accountId, accountId))
    .limit(1);

  if (existing.length > 0) {
    await db.update(accountStats)
      .set({ ...stats, fetchedAt })
      .where(eq(accountStats.accountId, accountId));
  } else {
    await db.insert(accountStats).values({ accountId, ...stats, fetchedAt });
  }
  return { accountId, ...stats, fetchedAt };
}

// GET — return cached stats for every account belonging to this user
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({ stat: accountStats, account: accounts })
    .from(accountStats)
    .innerJoin(
      accounts,
      and(eq(accountStats.accountId, accounts.id), eq(accounts.userId, session.userId))
    );

  return NextResponse.json(
    rows.map(({ stat, account }) => ({
      ...stat,
      platform: account.platform,
      username: account.username,
    }))
  );
}

// POST — refresh stats from every platform API, store, return results
export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userAccounts = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, session.userId), eq(accounts.isActive, true)));

  const results: ReturnType<typeof upsertStat> extends Promise<infer T> ? T[] : never[] = [];
  const errors: { accountId: number; platform: string; error: string }[] = [];

  for (const account of userAccounts) {
    try {
      let stats = { followers: 0, following: 0, posts: 0, views: 0 };

      if (account.platform === "youtube") {
        const token = await getFreshYoutubeToken(account);
        stats = await youtube.getChannelStats(token);
      } else if (account.platform === "instagram") {
        if (!account.platformUserId) throw new Error("Missing Instagram user ID — try reconnecting.");
        stats = await instagram.getAccountStats(await getFreshInstagramToken(account), account.platformUserId);
      } else if (account.platform === "twitter") {
        stats = await twitter.getUserStats(account.accessToken);
      } else if (account.platform === "tiktok") {
        stats = await tiktok.getUserStats(account.accessToken);
      } else {
        continue; // unsupported platform — skip silently
      }

      results.push(await upsertStat(account.id, stats));
    } catch (err) {
      console.error(`[account-stats] ${account.platform} @${account.username}:`, err);
      errors.push({
        accountId: account.id,
        platform: account.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ results, errors });
}
