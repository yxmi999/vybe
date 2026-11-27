import { NextRequest, NextResponse } from "next/server";
import * as instagram from "@/lib/platforms/instagram";
import { db } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { getServerSession } from "@/lib/auth";
import { encodeState, decodeState, stateOwnerMismatch, accountsRedirect, type OAuthClient } from "@/lib/oauth-state";
import { withCors, corsPreflight } from "@/lib/cors";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const rawState = searchParams.get("state");
  const oauthError = searchParams.get("error");
  const parsedForError = rawState ? decodeState(rawState, "instagram") : null;

  if (!code) {
    const client: OAuthClient = searchParams.get("client") === "mobile" ? "mobile" : "web";
    const session = await getServerSession();
    if (!session) {
      return client === "mobile"
        ? withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
        : NextResponse.redirect(`${APP_URL}/login`);
    }

    if (!process.env.INSTAGRAM_CLIENT_ID || !process.env.INSTAGRAM_CLIENT_SECRET || !process.env.INSTAGRAM_REDIRECT_URI) {
      const detail = "Instagram isn't configured on this server (INSTAGRAM_CLIENT_ID / INSTAGRAM_CLIENT_SECRET / INSTAGRAM_REDIRECT_URI).";
      return client === "mobile"
        ? withCors(NextResponse.json({ error: detail }, { status: 503 }))
        : NextResponse.redirect(accountsRedirect("web", APP_URL, `error=instagram&detail=${encodeURIComponent(detail)}`));
    }

    const state = crypto.randomUUID();
    const url = instagram.getAuthUrl(encodeState("instagram", state, session.userId, client));
    if (client === "mobile") return withCors(NextResponse.json({ url }));
    return NextResponse.redirect(url);
  }

  if (oauthError) {
    const desc = searchParams.get("error_description") ?? oauthError;
    const target = parsedForError
      ? accountsRedirect(parsedForError.client, APP_URL, `error=instagram&detail=${encodeURIComponent(desc)}`)
      : `${APP_URL}/accounts?error=instagram&detail=${encodeURIComponent(desc)}`;
    return NextResponse.redirect(target);
  }

  const parsed = rawState ? decodeState(rawState, "instagram") : null;
  if (!parsed) {
    return NextResponse.redirect(`${APP_URL}/accounts?error=instagram&detail=invalid_state`);
  }
  if (await stateOwnerMismatch(parsed.userId)) {
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=instagram&detail=${encodeURIComponent("This connect link was started from a different Vybe account. Sign in to the right account and click Connect again.")}`));
  }

  try {
    const tokens = await instagram.exchangeCode(code);
    const profiles = await instagram.getProfiles(tokens.accessToken);
    if (profiles.length === 0) {
      return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL,
        `error=instagram&detail=${encodeURIComponent("No Instagram professional account was shared with Vybe. Click Connect again and select your Instagram Business or Creator account in the Meta dialog.")}`));
    }
    if (profiles.every((p) => p.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(p.account_type))) {
      return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL,
        `error=instagram&detail=${encodeURIComponent("Only Instagram Business or Creator accounts can be connected. Switch to a professional account in the Instagram app (Settings → Account type and tools) and try again.")}`));
    }
    const tokenExpiry = Math.floor(Date.now() / 1000) + tokens.expiresIn;

    for (const profile of profiles) {
      if (profile.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(profile.account_type)) continue;
      // The professional account ID — what the publishing / insights endpoints take.
      const platformUserId = profile.user_id;

      const existing = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(
          eq(accounts.userId, parsed.userId),
          eq(accounts.platform, "instagram"),
          eq(accounts.platformUserId, platformUserId),
        ))
        .limit(1);

      if (existing.length > 0) {
        await db.update(accounts).set({
          accessToken: tokens.accessToken,
          tokenExpiry,
          isActive: true,
          username: profile.username,
          displayName: profile.name ?? profile.username,
          avatarUrl: profile.profile_picture_url ?? null,
        }).where(eq(accounts.id, existing[0].id));
      } else {
        await db.insert(accounts).values({
          userId: parsed.userId,
          platform: "instagram",
          username: profile.username,
          displayName: profile.name ?? profile.username,
          avatarUrl: profile.profile_picture_url ?? null,
          accessToken: tokens.accessToken,
          platformUserId,
          tokenExpiry,
        });
      }
    }

    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, "connected=instagram"));
  } catch (err: unknown) {
    const detail = (err as { response?: { data?: unknown } })?.response?.data;
    console.error("[instagram oauth] callback error:", detail ?? err);
    const msg = encodeURIComponent(detail ? JSON.stringify(detail) : String(err));
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=instagram&detail=${msg}`));
  }
}
