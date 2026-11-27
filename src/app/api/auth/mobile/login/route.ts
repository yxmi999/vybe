import { NextRequest, NextResponse } from "next/server";
import { signAccessToken, verifyCredentials, generateRefreshToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { refreshTokens } from "@/lib/schema";
import { withCors, corsPreflight } from "@/lib/cors";

const REFRESH_TTL_DAYS = 45;

export async function OPTIONS() {
  return corsPreflight();
}

// Mirrors /api/auth/login but returns a token pair instead of setting a
// cookie — the RN app can't rely on cookies the way a same-origin browser can.
export async function POST(req: NextRequest) {
  const { email, password, deviceId } = await req.json();

  if (!email || !password) {
    return withCors(NextResponse.json({ error: "Email and password are required" }, { status: 400 }));
  }

  const user = await verifyCredentials(email, password);
  if (!user) {
    return withCors(NextResponse.json({ error: "Invalid email or password" }, { status: 401 }));
  }

  const accessToken = await signAccessToken({ userId: user.id, email: user.email, name: user.name ?? "" });
  const { token: refreshToken, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hash,
    deviceId: typeof deviceId === "string" ? deviceId : null,
    expiresAt,
  });

  return withCors(NextResponse.json({
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
  }));
}
