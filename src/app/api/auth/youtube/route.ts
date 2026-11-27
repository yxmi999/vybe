import { NextRequest, NextResponse } from "next/server";
import * as youtube from "@/lib/platforms/youtube";
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
  const oauthError = searchParams.get("error");
  const rawState = searchParams.get("state");
  const parsedForError = rawState ? decodeState(rawState, "youtube") : null;

  if (oauthError) {
    const target = parsedForError
      ? accountsRedirect(parsedForError.client, APP_URL, `error=youtube&detail=${encodeURIComponent(oauthError)}`)
      : `${APP_URL}/accounts?error=youtube&detail=${encodeURIComponent(oauthError)}`;
    return NextResponse.redirect(target);
  }

  if (!code) {
    const client: OAuthClient = searchParams.get("client") === "mobile" ? "mobile" : "web";
    const session = await getServerSession();
    if (!session) {
      return client === "mobile"
        ? withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
        : NextResponse.redirect(`${APP_URL}/login`);
    }

    const state = crypto.randomUUID();
    const url = youtube.getAuthUrl(encodeState("youtube", state, session.userId, client));
    if (client === "mobile") return withCors(NextResponse.json({ url }));
    return NextResponse.redirect(url);
  }

  const parsed = rawState ? decodeState(rawState, "youtube") : null;
  if (!parsed) {
    return NextResponse.redirect(`${APP_URL}/accounts?error=youtube&detail=invalid_state`);
  }
  if (await stateOwnerMismatch(parsed.userId)) {
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=youtube&detail=${encodeURIComponent("This connect link was started from a different Vybe account. Sign in to the right account and click Connect again.")}`));
  }

  try {
    const tokens = await youtube.exchangeCode(code);
    const channel = await youtube.getChannel(tokens.access_token);

    if (!channel) throw new Error("Could not fetch YouTube channel info");

    const tokenExpiry = Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600);

    const existing = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(
        eq(accounts.userId, parsed.userId),
        eq(accounts.platform, "youtube"),
        eq(accounts.platformUserId, channel.id),
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(accounts).set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenExpiry,
        isActive: true,
        username: channel.snippet.customUrl ?? channel.snippet.title,
        displayName: channel.snippet.title,
        avatarUrl: channel.snippet.thumbnails?.default?.url ?? null,
      }).where(eq(accounts.id, existing[0].id));
    } else {
      await db.insert(accounts).values({
        userId: parsed.userId,
        platform: "youtube",
        username: channel.snippet.customUrl ?? channel.snippet.title,
        displayName: channel.snippet.title,
        avatarUrl: channel.snippet.thumbnails?.default?.url ?? null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        platformUserId: channel.id,
        tokenExpiry,
      });
    }

    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, "connected=youtube"));
  } catch (err: unknown) {
    const detail = (err as { response?: { data?: unknown } })?.response?.data;
    console.error("[youtube oauth] callback error:", detail ?? err);
    const msg = encodeURIComponent(detail ? JSON.stringify(detail) : String(err));
    return NextResponse.redirect(accountsRedirect(parsed.client, APP_URL, `error=youtube&detail=${msg}`));
  }
}
