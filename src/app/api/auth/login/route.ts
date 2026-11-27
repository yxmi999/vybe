import { NextRequest, NextResponse } from "next/server";
import { signToken, verifyCredentials, setSessionCookie } from "@/lib/auth";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { recordSignals } from "@/lib/affiliate-safety";

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}));

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  // Brute-force guard: per IP (spraying many accounts) and per account
  // (many IPs hammering one account). 15-minute windows.
  const ip = await rateLimit(`login:ip:${clientIp(req)}`, 20, 900);
  if (!ip.allowed) return tooManyRequests(ip.retryAfterSec);
  const acct = await rateLimit(`login:email:${email.toLowerCase().trim()}`, 10, 900);
  if (!acct.allowed) return tooManyRequests(acct.retryAfterSec);

  const user = await verifyCredentials(email.trim(), password);
  if (!user) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await recordSignals(user.id, req, "login");

  const token = await signToken({ userId: user.id, email: user.email, name: user.name ?? "" });

  const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  setSessionCookie(res, token);
  return res;
}
