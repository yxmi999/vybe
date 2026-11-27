import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { analytics, posts, accounts, publicAccountColumns } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import { fetchPostMetrics, upsertPostMetrics } from "@/lib/post-metrics";

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

export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const published = await db
    .select({ post: posts, account: accounts })
    .from(posts)
    .innerJoin(accounts, and(eq(posts.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .where(eq(posts.status, "published"));

  const errors: string[] = [];

  for (const { post, account } of published) {
    if (!post.platformPostId) continue;

    try {
      const metrics = await fetchPostMetrics(account, post.platformPostId);
      if (!metrics) continue;
      await upsertPostMetrics(post.id, metrics);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Post ${post.id} (${account.platform}): ${msg}`);
      console.error("[analytics refresh]", `post=${post.id}`, `platform=${account.platform}`, msg);
    }
  }

  return NextResponse.json({ ok: true, errors: errors.length ? errors : undefined });
}
