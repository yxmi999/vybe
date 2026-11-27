import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { refreshTokens } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { hashRefreshToken } from "@/lib/auth";
import { withCors, corsPreflight } from "@/lib/cors";

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: NextRequest) {
  const { refreshToken } = await req.json().catch(() => ({}));
  if (refreshToken) {
    const hash = hashRefreshToken(refreshToken);
    await db.update(refreshTokens).set({ revokedAt: new Date().toISOString() }).where(eq(refreshTokens.tokenHash, hash));
  }
  return withCors(NextResponse.json({ ok: true }));
}
