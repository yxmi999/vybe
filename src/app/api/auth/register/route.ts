import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { signToken, setSessionCookie } from "@/lib/auth";
import { attachReferral, REF_COOKIE } from "@/lib/affiliate";
import { recordSignals } from "@/lib/affiliate-safety";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { verifyTurnstile } from "@/lib/turnstile";
import { sendVerificationEmail } from "@/lib/email-verification";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { name, password, ref } = body;
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!email || typeof password !== "string" || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }
  if (password.length > 128) {
    return NextResponse.json({ error: "Password must be at most 128 characters" }, { status: 400 });
  }

  // Mass sign-up guard: each account gets free clips, so cap new accounts per IP.
  const ip = clientIp(req);
  const limit = await rateLimit(`register:ip:${ip}`, 5, 3600);
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSec, "Too many sign-ups from this network. Please try again later.");

  // Bot check (Cloudflare Turnstile) before any account work.
  const human = await verifyTurnstile(body["cf-turnstile-response"], "signup", ip);
  if (!human.ok) {
    console.warn(`[register] turnstile rejected: ${human.reason}`);
    return NextResponse.json(
      { error: "We couldn't verify you're human. Please complete the check and try again." },
      { status: 403 },
    );
  }

  const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db
    .insert(users)
    .values({ email: email.toLowerCase(), name: (typeof name === "string" ? name.trim().slice(0, 100) : "") || null, passwordHash })
    .returning();

  // Affiliate attribution: the ?ref= cookie set by the proxy, or a code sent
  // explicitly by the register form.
  const refCode = req.cookies.get(REF_COOKIE)?.value ?? ref;
  // Self-referrals (same device / email alias) are refused inside attachReferral.
  if (refCode) await attachReferral(user.id, refCode, { email: user.email, req });
  await recordSignals(user.id, req, "signup");

  // Free clips unlock once the address is confirmed. A failed send isn't fatal:
  // the dashboard banner lets the user resend.
  await sendVerificationEmail(user.id, user.email).catch(() => false);

  const token = await signToken({ userId: user.id, email: user.email, name: user.name ?? "" });

  const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
  setSessionCookie(res, token);
  if (refCode) res.cookies.delete(REF_COOKIE);
  return res;
}
