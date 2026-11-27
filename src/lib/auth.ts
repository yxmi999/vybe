import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./schema";

export type SessionPayload = {
  userId: number;
  email: string;
  name: string;
};

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set in production");
    }
    return new TextEncoder().encode("vybe-dev-secret-change-in-production");
  }
  return new TextEncoder().encode(value);
}

// A key derived for one purpose (e.g. emailed links), so those tokens can
// never be replayed as a session cookie, which is signed with secret() itself.
export function purposeSecret(purpose: string): Uint8Array {
  const base = new TextDecoder().decode(secret());
  return new TextEncoder().encode(`${base}:${purpose}`);
}

export async function signToken(payload: SessionPayload) {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(secret());
}

// Short-lived token for the mobile app's Authorization header — paired with a
// separate refresh token (see below) rather than the web's 7-day cookie, so a
// stolen access token has a small blast-radius window.
export async function signAccessToken(payload: SessionPayload) {
  return new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30m")
    .sign(secret());
}

// The web session cookie — shared by email login/register and Google/GitHub sign-in.
export function setSessionCookie(res: { cookies: { set: (name: string, value: string, opts: object) => unknown } }, token: string) {
  res.cookies.set("vybe_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  });
}

export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

// Opaque (non-JWT) refresh token: only the sha256 hash is stored, so it can be
// revoked (logout-this-device / logout-all-devices) unlike a bare signed JWT.
export function generateRefreshToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Shared by the cookie-session login route and the mobile login route so the
// password check only lives in one place.
export async function verifyCredentials(email: string, password: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  return user;
}

// Checked first so the mobile app can authenticate without cookies; falls
// back to the web's httpOnly cookie so no existing route needs to change.
export async function getServerSession(): Promise<SessionPayload | null> {
  const hdrs = await headers();
  const authHeader = hdrs.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const payload = await verifyToken(authHeader.slice(7));
    if (payload) return payload;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get("vybe_token")?.value;
  if (!token) return null;
  return verifyToken(token);
}
