// Email verification: a signed, 24-hour link token (no DB table). The token
// carries the address it was sent to, so a link for an old address can't
// verify a changed one. Verifying is idempotent, so a reused link is harmless.
import { SignJWT, jwtVerify } from "jose";
import { client } from "./db";
import { purposeSecret } from "./auth";
import { sendEmail } from "./email";

const PURPOSE = "verify-email";
const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export async function isEmailVerified(userId: number): Promise<boolean> {
  try {
    const res = await client.execute({ sql: "SELECT email_verified_at FROM users WHERE id = ?", args: [userId] });
    const row = res.rows[0] as { email_verified_at?: string | null } | undefined;
    if (!row) return false;
    return !!row.email_verified_at;
  } catch {
    return true; // column missing / DB error → fail open, like the clip quota
  }
}

export async function markEmailVerified(userId: number): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET email_verified_at = datetime('now') WHERE id = ? AND email_verified_at IS NULL",
    args: [userId],
  });
}

export async function sendVerificationEmail(userId: number, email: string): Promise<boolean> {
  const token = await new SignJWT({ uid: userId, email: email.toLowerCase(), p: PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("24h")
    .sign(purposeSecret(PURPOSE));
  const link = `${appUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;

  return sendEmail({
    to: email,
    subject: "Verify your email to unlock your free clips",
    text: `Welcome to Vybe!\n\nConfirm your email to unlock your 10 free clips a month:\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 12px">Welcome to Vybe!</h2>
  <p style="margin:0 0 20px;line-height:1.5">Confirm your email to unlock your <b>10 free clips a month</b>.</p>
  <p style="margin:0 0 24px"><a href="${link}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">Verify my email</a></p>
  <p style="margin:0;color:#666;font-size:13px;line-height:1.5">This link expires in 24 hours. If you didn't sign up, you can ignore this email.</p>
</div>`,
  });
}

/** Returns the verified user id, or null if the token is invalid/expired/stale. */
export async function consumeVerificationToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, purposeSecret(PURPOSE));
    if (payload.p !== PURPOSE || typeof payload.uid !== "number" || typeof payload.email !== "string") return null;
    const res = await client.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [payload.uid] });
    const email = (res.rows[0] as { email?: string } | undefined)?.email;
    if (!email || email.toLowerCase() !== payload.email) return null;
    await markEmailVerified(payload.uid);
    return payload.uid;
  } catch {
    return null;
  }
}
