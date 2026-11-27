import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { posts, accounts } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";

// The review queue = Auto-Pilot clips that landed as drafts awaiting approval.
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({ post: posts, account: accounts })
    .from(posts)
    .innerJoin(accounts, eq(posts.accountId, accounts.id))
    .where(and(eq(accounts.userId, session.userId), eq(posts.status, "draft")))
    .orderBy(desc(posts.createdAt));

  const items = rows
    .map(({ post, account }) => {
      let meta: Record<string, unknown> = {};
      try { meta = post.metadata ? JSON.parse(post.metadata) : {}; } catch { /* ignore */ }
      if (meta.source !== "autopilot") return null;
      let media: string[] = [];
      try { media = post.mediaUrls ? JSON.parse(post.mediaUrls) : []; } catch { /* ignore */ }
      return {
        id: post.id,
        content: post.content,
        url: media[0] ?? null,
        platform: post.platform,
        account: { username: account.username, platform: account.platform },
        confidence: typeof meta.confidence === "number" ? meta.confidence : null,
        viralityScore: typeof meta.viralityScore === "number" ? meta.viralityScore : null,
        viralityVerdict: typeof meta.viralityVerdict === "string" ? meta.viralityVerdict : null,
        clipRequested: meta.clipRequested === true,
        autoPilotId: meta.autoPilotId ?? null,
        videoTitle: meta.videoTitle ?? post.content,
        createdAt: post.createdAt,
      };
    })
    .filter(Boolean);

  return NextResponse.json({ items });
}
