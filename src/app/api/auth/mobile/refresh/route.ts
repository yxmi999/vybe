import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { refreshTokens, users } from "@/lib/schema";
import { eq, and, isNull } from "drizzle-orm";
import { signAccessToken, hashRefreshToken, generateRefreshToken } from "@/lib/auth";
import { withCors, corsPreflight } from "@/lib/cors";

const REFRESH_TTL_DAYS = 45;

export async function OPTIONS() {
  return corsPreflight();
}

// Exchanges a still-valid refresh token for a new access token, rotating the
// refresh token in the same call — limits replay if one is ever intercepted.
export async function POST(req: NextRequest) {
  const { refreshToken } = await req.json().catch(() => ({}));
  if (!refreshToken) {
    return withCors(NextResponse.json({ error: "refreshToken is required" }, { status: 400 }));
  }

  const hash = hashRefreshToken(refreshToken);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)))
    .limit(1);

  if (!row || new Date(row.expiresAt) < new Date()) {
    return withCors(NextResponse.json({ error: "Invalid or expired refresh token" }, { status: 401 }));
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) {
    return withCors(NextResponse.json({ error: "Invalid or expired refresh token" }, { status: 401 }));
  }

  const { token: nextRefreshToken, hash: nextHash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db.update(refreshTokens).set({ revokedAt: new Date().toISOString() }).where(eq(refreshTokens.id, row.id));
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: nextHash,
    deviceId: row.deviceId,
    expiresAt,
  });

  const accessToken = await signAccessToken({ userId: user.id, email: user.email, name: user.name ?? "" });

  return withCors(NextResponse.json({ accessToken, refreshToken: nextRefreshToken }));
}
