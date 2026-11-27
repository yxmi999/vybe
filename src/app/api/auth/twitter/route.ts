import { NextRequest, NextResponse } from "next/server";
import * as twitterPlatform from "@/lib/platforms/twitter";
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
    const compositeState = encodeState("twitter", state, session.userId, client, codeVerifier);
    const url = twitterPlatform.getAuthUrl(compositeState, codeVerifier);

    const cookieStore = await cookies();
    cookieStore.set("twitter_state", state, { httpOnly: true, maxAge: 600, path: "/" });
    cookieStore.set("twitter_verifier", codeVerifier, { httpOnly: true, maxAge: 600, path: "/" });

    if (client === "mobile") return withCors(NextResponse.json({ url }));
    return NextResponse.redirect(url);
  }

  // Callback — read userId (and client, PKCE verifier) from state, no session cookie needed
  const parsed = rawState ? decodeState(rawState, "twitter") : null;
  if (!parsed) {
    return NextResponse.redirect(`${APP_URL}/accounts?error=twitter&detail=invalid_state`);
  }
  if (await stateOwnerMismatch(parsed.userId)) {
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=twitter&detail=${encodeURIComponent("This connect link was started from a different Vybe account. Sign in to the right account and click Connect again.")}`));
  }

  try {
    const cookieStore = await cookies();
    const savedState = cookieStore.get("twitter_state")?.value;
    if (savedState && savedState !== parsed.state) {
      return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, "error=twitter&detail=state_mismatch"));
    }

    // State-embedded verifier is authoritative — the cookie fallback only
    // covers older links, since mobile's callback browser session never has it.
    const codeVerifier = parsed.verifier ?? cookieStore.get("twitter_verifier")?.value ?? "";

    let tokens: Awaited<ReturnType<typeof twitterPlatform.exchangeCode>>;
    try {
      tokens = await twitterPlatform.exchangeCode(code, codeVerifier);
    } catch (tokenErr: unknown) {
      const detail = (tokenErr as { response?: { data?: unknown } })?.response?.data;
      console.error("[twitter oauth] token exchange failed:", detail ?? tokenErr);
      const msg = encodeURIComponent(detail ? JSON.stringify(detail) : String(tokenErr));
      return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=twitter&detail=${msg}`));
    }

    const profile = await twitterPlatform.getProfile(tokens.access_token);
    const tokenExpiry = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 7200);

    const existing = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(
        eq(accounts.userId, parsed.userId),
        eq(accounts.platform, "twitter"),
        eq(accounts.platformUserId, profile.id),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(accounts).set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenExpiry,
        isActive: true,
        username: profile.username,
        displayName: profile.name,
        avatarUrl: profile.profile_image_url ?? null,
      }).where(eq(accounts.id, existing[0].id));
    } else {
      await db.insert(accounts).values({
        userId: parsed.userId,
        platform: "twitter",
        username: profile.username,
        displayName: profile.name,
        avatarUrl: profile.profile_image_url,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        platformUserId: profile.id,
        tokenExpiry,
      });
    }

    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, "connected=twitter"));
  } catch (err) {
    console.error("[twitter oauth] callback error:", err);
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, "error=twitter"));
  }
}
