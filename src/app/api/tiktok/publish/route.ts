import { NextRequest, NextResponse } from "next/server";
import os from "os";
import path from "path";
import { readFile, unlink } from "fs/promises";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { posts } from "@/lib/schema";
import { resolveToTempFile } from "@/lib/storage";
import { getTiktokAccount, tiktokErrorMessage } from "@/lib/tiktok-account";
import * as tiktok from "@/lib/platforms/tiktok";

export const maxDuration = 300;

const PRIVACY: tiktok.PrivacyLevel[] = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];

// Only post files from our own storage: local /uploads/ in dev, Vercel Blob in
// production. Never fetch arbitrary URLs server-side.
function isOwnMedia(url: string) {
  if (url.startsWith("/uploads/")) return !url.includes("..");
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { accountId, videoUrl, mode } = body as { accountId: number; videoUrl: string; mode: "direct" | "inbox" };

  if (!accountId || typeof videoUrl !== "string" || !isOwnMedia(videoUrl)) {
    return NextResponse.json({ error: "Invalid video" }, { status: 400 });
  }
  if (mode !== "direct" && mode !== "inbox") {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  let info: tiktok.DirectPostInfo | undefined;
  if (mode === "direct") {
    const title = String(body.title ?? "");
    const privacyLevel = body.privacyLevel as tiktok.PrivacyLevel;
    const brandContent = !!body.brandContent;
    if (!PRIVACY.includes(privacyLevel)) return NextResponse.json({ error: "Choose who can view this post." }, { status: 400 });
    if (title.length > 2200) return NextResponse.json({ error: "Caption is too long (max 2200 characters)." }, { status: 400 });
    if (brandContent && privacyLevel === "SELF_ONLY") {
      return NextResponse.json({ error: "Branded content can't be private." }, { status: 400 });
    }
    info = {
      title,
      privacyLevel,
      disableComment: !body.allowComment,
      disableDuet: !body.allowDuet,
      disableStitch: !body.allowStitch,
      brandContent,
      brandOrganic: !!body.brandOrganic,
    };
  }

  const tmp = path.join(os.tmpdir(), `vybe-tiktok-${Date.now()}.mp4`);
  try {
    const acct = await getTiktokAccount(session.userId, accountId);
    if (!acct) return NextResponse.json({ error: "TikTok account not found" }, { status: 404 });

    // Re-check the creator's current settings server-side, so a stale screen can't
    // post with an option TikTok no longer allows.
    const creator = await tiktok.queryCreatorInfo(acct.accessToken);
    if (info) {
      if (!creator.privacy_level_options.includes(info.privacyLevel)) {
        return NextResponse.json({ error: "That privacy option isn't available for this account." }, { status: 400 });
      }
      if (creator.comment_disabled) info.disableComment = true;
      if (creator.duet_disabled) info.disableDuet = true;
      if (creator.stitch_disabled) info.disableStitch = true;
    }

    await resolveToTempFile(videoUrl, tmp);
    const video = await readFile(tmp);
    const publishId = await tiktok.postVideo(acct.accessToken, video, mode, info);

    const now = new Date().toISOString();
    const [row] = await db.insert(posts).values({
      accountId,
      platform: "tiktok",
      content: info?.title ?? "",
      mediaUrls: JSON.stringify([videoUrl]),
      metadata: JSON.stringify({ mode, publishId, privacy: info?.privacyLevel }),
      scheduledAt: now,
      publishedAt: now,
      status: "published",
    }).returning({ id: posts.id });

    return NextResponse.json({ publishId, postId: row.id });
  } catch (err) {
    console.error("[tiktok publish]", err);
    return NextResponse.json({ error: tiktokErrorMessage(err) }, { status: 400 });
  } finally {
    unlink(tmp).catch(() => {});
  }
}
