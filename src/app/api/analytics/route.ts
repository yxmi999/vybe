import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { analytics, posts, accounts, publicAccountColumns } from "@/lib/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import { fetchPostMetrics, upsertPostMetrics } from "@/lib/post-metrics";
import { parseDbTime } from "@/lib/auto-reply";

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({ analytics, post: posts, account: publicAccountColumns })
    .from(analytics)
    .innerJoin(posts, eq(analytics.postId, posts.id))
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .orderBy(desc(analytics.fetchedAt));

  // Keep only the most recent analytics row per post
  const seen = new Set<number>();
  const deduped = rows.filter(({ post }) => {
    if (!post?.id || seen.has(post.id)) return false;
    seen.add(post.id);
    return true;
  });

  return NextResponse.json(deduped);
}

// ?maxAgeMinutes=N skips posts whose metrics were fetched within the last N
// minutes — used by the automatic refresh on page entry to spare API quota.
// Without it (the "Refresh Metrics" button) every published post is re-read.
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const maxAgeMinutes = Number(req.nextUrl.searchParams.get("maxAgeMinutes"));

  const published = await db
    .select({ post: posts, account: accounts })
    .from(posts)
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .where(eq(posts.status, "published"));

  const lastFetched = new Map<number, number>();
  if (maxAgeMinutes > 0) {
    const ids = published.map(({ post }) => post.id);
    if (ids.length) {
      const fetched = await db
        .select({ postId: analytics.postId, fetchedAt: analytics.fetchedAt })
        .from(analytics)
        .where(inArray(analytics.postId, ids));
      for (const { postId, fetchedAt } of fetched) {
        if (postId == null) continue;
        lastFetched.set(postId, Math.max(lastFetched.get(postId) ?? 0, parseDbTime(fetchedAt)));
      }
    }
  }
  const cutoff = Date.now() - maxAgeMinutes * 60_000;

  const errors: string[] = [];
  let refreshed = 0;

  for (const { post, account } of published) {
    if (!post.platformPostId) continue;
    if (maxAgeMinutes > 0 && (lastFetched.get(post.id) ?? 0) > cutoff) continue;

    try {
      const metrics = await fetchPostMetrics(account, post.platformPostId);
      if (!metrics) continue;
      await upsertPostMetrics(post.id, metrics);
      refreshed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Post ${post.id} (${account.platform}): ${msg}`);
      console.error("[analytics refresh]", `post=${post.id}`, `platform=${account.platform}`, msg);
    }
  }

  return NextResponse.json({ ok: true, refreshed, errors: errors.length ? errors : undefined });
}
