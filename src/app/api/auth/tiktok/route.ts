import { NextRequest, NextResponse } from "next/server";
import * as tiktokPlatform from "@/lib/platforms/tiktok";
import { db } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { cookies } from "next/headers";
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

  if (!code) {
    const client: OAuthClient = searchParams.get("client") === "mobile" ? "mobile" : "web";
    const session = await getServerSession();
    if (!session) {
      return client === "mobile"
        ? withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
        : NextResponse.redirect(`${APP_URL}/login`);
    }

    const state = crypto.randomUUID();
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const url = tiktokPlatform.getAuthUrl(encodeState("tiktok", state, session.userId, client, codeVerifier), codeVerifier);

    const cookieStore = await cookies();
    cookieStore.set("tiktok_verifier", codeVerifier, { httpOnly: true, maxAge: 600, path: "/" });

    if (client === "mobile") return withCors(NextResponse.json({ url }));
    return NextResponse.redirect(url);
  }

  const parsed = rawState ? decodeState(rawState, "tiktok") : null;

  if (oauthError) {
    const desc = searchParams.get("error_description") ?? oauthError;
    const target = parsed ? accountsRedirect(parsed.client, APP_URL, `error=tiktok&detail=${encodeURIComponent(desc)}`) : `${APP_URL}/accounts?error=tiktok&detail=${encodeURIComponent(desc)}`;
    return NextResponse.redirect(target);
  }

  if (!parsed) {
    return NextResponse.redirect(`${APP_URL}/accounts?error=tiktok&detail=invalid_state`);
  }
  if (await stateOwnerMismatch(parsed.userId)) {
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=tiktok&detail=${encodeURIComponent("This connect link was started from a different Vybe account. Sign in to the right account and click Connect again.")}`));
  }

  try {
    const cookieStore = await cookies();
    const codeVerifier = parsed.verifier ?? cookieStore.get("tiktok_verifier")?.value ?? "";
    const tokens = await tiktokPlatform.exchangeCode(code, codeVerifier);
    const profile = await tiktokPlatform.getProfile(tokens.access_token);
    const tokenExpiry = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 86400);

    const existing = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(
        eq(accounts.userId, parsed.userId),
        eq(accounts.platform, "tiktok"),
        eq(accounts.platformUserId, profile.open_id),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(accounts).set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiry,
        isActive: true,
        username: profile.display_name,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
      }).where(eq(accounts.id, existing[0].id));
    } else {
      await db.insert(accounts).values({
        userId: parsed.userId,
        platform: "tiktok",
        username: profile.display_name,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        platformUserId: profile.open_id,
        tokenExpiry,
      });
    }

    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, "connected=tiktok"));
  } catch (err: unknown) {
    const detail = (err as { response?: { data?: unknown } })?.response?.data;
    console.error("[tiktok oauth] callback error:", detail ?? err);
    const msg = encodeURIComponent(detail ? JSON.stringify(detail) : String(err));
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=tiktok&detail=${msg}`));
  }
}
