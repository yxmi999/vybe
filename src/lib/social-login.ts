import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./schema";

// "Sign in with Google / GitHub / Discord" — identity only (no API scopes beyond the
// user's verified email + name). This is separate from the YouTube/Twitter
// *account connection* flows in lib/platforms, which attach publishing
// accounts to an already-signed-in Vybe user.

export const SOCIAL_PROVIDERS = ["google", "github", "discord"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<SocialProvider, string> = {
  google: "Google",
  github: "GitHub",
  discord: "Discord",
};

// Google sign-in can reuse the YouTube OAuth client (same Google Cloud
// project) — just add the sign-in redirect URI to that client.
const googleId = () => process.env.GOOGLE_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;
const googleSecret = () => process.env.GOOGLE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;

export type SocialProfile = { email: string; name: string | null };

type ProviderConfig = {
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  authorizeUrl: string;
  scope: string;
  exchange: (code: string, redirectUri: string) => Promise<string>;
  profile: (accessToken: string) => Promise<SocialProfile>;
};

const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const redirectUriFor = (provider: SocialProvider) => `${appUrl()}/api/auth/oauth/${provider}`;

async function postForm(url: string, body: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `Token exchange failed (${res.status})`);
  }
  return data.access_token as string;
}

const PROVIDERS: Record<SocialProvider, ProviderConfig> = {
  google: {
    clientId: googleId,
    clientSecret: googleSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    exchange: (code, redirectUri) =>
      postForm("https://oauth2.googleapis.com/token", {
        code,
        client_id: googleId()!,
        client_secret: googleSecret()!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    profile: async (token) => {
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const u = await res.json();
      if (!res.ok || !u.email) throw new Error("Could not read your Google profile");
      if (!u.email_verified) throw new Error("Your Google email isn't verified");
      return { email: String(u.email), name: u.name ?? null };
    },
  },
  github: {
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    scope: "read:user user:email",
    exchange: (code, redirectUri) =>
      postForm("https://github.com/login/oauth/access_token", {
        code,
        client_id: process.env.GITHUB_CLIENT_ID!,
        client_secret: process.env.GITHUB_CLIENT_SECRET!,
        redirect_uri: redirectUri,
      }),
    profile: async (token) => {
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "vybe-app" };
      const [userRes, emailsRes] = await Promise.all([
        fetch("https://api.github.com/user", { headers }),
        fetch("https://api.github.com/user/emails", { headers }),
      ]);
      const u = await userRes.json();
      const emails = (await emailsRes.json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
      // The public profile email may be unset or unverified; only trust a
      // verified address from /user/emails, preferring the primary one.
      const verified = Array.isArray(emails) ? emails.filter((e) => e.verified) : [];
      const email = (verified.find((e) => e.primary) ?? verified[0])?.email;
      if (!email) throw new Error("Your GitHub account has no verified email");
      return { email, name: u.name ?? u.login ?? null };
    },
  },
  discord: {
    clientId: () => process.env.DISCORD_CLIENT_ID,
    clientSecret: () => process.env.DISCORD_CLIENT_SECRET,
    authorizeUrl: "https://discord.com/oauth2/authorize",
    scope: "identify email",
    exchange: (code, redirectUri) =>
      postForm("https://discord.com/api/oauth2/token", {
        code,
        client_id: process.env.DISCORD_CLIENT_ID!,
        client_secret: process.env.DISCORD_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    profile: async (token) => {
      const res = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const u = await res.json();
      if (!res.ok || !u.email) throw new Error("Your Discord account has no email address");
      if (!u.verified) throw new Error("Your Discord email isn't verified");
      return { email: String(u.email), name: u.global_name ?? u.username ?? null };
    },
  },
};

export function isSocialProvider(p: string): p is SocialProvider {
  return (SOCIAL_PROVIDERS as readonly string[]).includes(p);
}

export function getProvider(provider: SocialProvider) {
  const cfg = PROVIDERS[provider];
  return cfg.clientId() && cfg.clientSecret() ? cfg : null;
}

export function authorizeUrl(provider: SocialProvider, state: string) {
  const cfg = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: cfg.clientId()!,
    redirect_uri: redirectUriFor(provider),
    response_type: "code",
    scope: cfg.scope,
    state,
  });
  if (provider === "google") params.set("prompt", "select_account");
  if (provider === "discord") params.set("prompt", "none"); // skip re-consent for returning users
  return `${cfg.authorizeUrl}?${params}`;
}

// Find the Vybe user for this verified email, or create one. Social-only users
// get a random, never-disclosed password hash so the NOT NULL column holds and
// email/password login simply fails for them until they set one.
export async function findOrCreateSocialUser(profile: SocialProfile) {
  const email = profile.email.toLowerCase();
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // Every provider here only hands back a verified address (see each
  // fetchProfile), which proves ownership: it also verifies an existing
  // email/password account with the same address.
  const now = new Date().toISOString();
  if (existing) {
    if (!existing.emailVerifiedAt) {
      // An unverified password account may have been registered by someone
      // else squatting this address. The provider just proved who owns it, so
      // the unproven password is replaced and can't be used to get back in.
      const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
      await db.update(users).set({ emailVerifiedAt: now, passwordHash }).where(eq(users.id, existing.id));
    }
    return { user: existing, created: false };
  }

  const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
  const [user] = await db
    .insert(users)
    .values({ email, name: profile.name?.trim() || null, passwordHash, emailVerifiedAt: now })
    .returning();
  return { user, created: true };
}
