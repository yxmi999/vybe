import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { attachReferral, REF_COOKIE } from "@/lib/affiliate";
import { recordSignals } from "@/lib/affiliate-safety";
import { signToken, setSessionCookie } from "@/lib/auth";
import {
  isSocialProvider,
  getProvider,
  authorizeUrl,
  redirectUriFor,
  findOrCreateSocialUser,
  PROVIDER_LABELS,
} from "@/lib/social-login";

// GET /api/auth/oauth/{google|github|discord}
//   - no `code`: start the flow (set a CSRF state cookie, redirect to provider)
//   - with `code`: provider callback — verify state, sign the user in
const STATE_COOKIE = "vybe_oauth_state";

function backToLogin(req: NextRequest, message: string) {
  const res = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, req.url));
  res.cookies.delete(STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!isSocialProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  const label = PROVIDER_LABELS[provider];

  const cfg = getProvider(provider);
  if (!cfg) return backToLogin(req, `${label} sign-in isn't configured yet.`);

  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const providerError = searchParams.get("error");

  if (providerError) {
    // User hit "Cancel" on the consent screen, or the provider refused.
    return backToLogin(req, providerError === "access_denied" ? `${label} sign-in was cancelled.` : `${label} sign-in failed.`);
  }

  if (!code) {
    const state = crypto.randomBytes(16).toString("hex");
    const res = NextResponse.redirect(authorizeUrl(provider, state));
    res.cookies.set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax", // must survive the top-level redirect back from the provider
      maxAge: 60 * 10,
      path: "/",
    });
    return res;
  }

  const expected = req.cookies.get(STATE_COOKIE)?.value;
  if (!expected || expected !== searchParams.get("state")) {
    return backToLogin(req, "Sign-in session expired. Please try again.");
  }

  try {
    const accessToken = await cfg.exchange(code, redirectUriFor(provider));
    const profile = await cfg.profile(accessToken);
    const { user, created } = await findOrCreateSocialUser(profile);
    const refCode = req.cookies.get(REF_COOKIE)?.value;
    if (created && refCode) await attachReferral(user.id, refCode, { email: user.email, req });
    await recordSignals(user.id, req, created ? "signup" : "login");

    const token = await signToken({ userId: user.id, email: user.email, name: user.name ?? "" });
    // New users land on /accounts to connect platforms, same as email sign-up.
    const res = NextResponse.redirect(new URL(created ? "/accounts" : "/dashboard", req.url));
    setSessionCookie(res, token);
    res.cookies.delete(STATE_COOKIE);
    if (created && refCode) res.cookies.delete(REF_COOKIE);
    return res;
  } catch (err) {
    console.error(`[oauth:${provider}]`, err);
    return backToLogin(req, err instanceof Error ? err.message : `${label} sign-in failed.`);
  }
}
