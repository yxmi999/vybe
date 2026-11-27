import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { client } from "@/lib/db";
import { isEmailVerified, sendVerificationEmail } from "@/lib/email-verification";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

// Re-send the verification email for the signed-in user.
export async function POST() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (await isEmailVerified(session.userId)) return NextResponse.json({ ok: true, alreadyVerified: true });

  const limit = await rateLimit(`verify-send:${session.userId}`, 3, 900);
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSec, "We just sent you an email. Please check your inbox (and spam) before trying again.");

  const res = await client.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [session.userId] });
  const email = (res.rows[0] as { email?: string } | undefined)?.email;
  if (!email) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const sent = await sendVerificationEmail(session.userId, email);
  if (!sent) return NextResponse.json({ error: "We couldn't send the email right now. Please try again in a few minutes." }, { status: 502 });
  return NextResponse.json({ ok: true });
}
