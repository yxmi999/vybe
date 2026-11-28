// Instagram publishing for business / creator accounts. Two login flows:
//
//  • Unified Login (INSTAGRAM_CONFIG_ID set) — what new Meta apps get; "API
//    setup with Instagram login" isn't offered to them. Facebook Login for
//    Business dialog with a configuration ID, client_id = the Meta app ID.
//    Tokens start with "EAA" and only work on graph.facebook.com.
//  • Instagram Login (legacy apps) — client_id = the separate Instagram app
//    ID. Tokens start with "IG" and only work on graph.instagram.com.
//
// The media / insights / comment endpoints are identical on both hosts, so
// every call picks the host from the token it's given — accounts connected
// through either flow keep working.
import axios from "axios";
import crypto from "crypto";

const API_VERSION = process.env.INSTAGRAM_API_VERSION || "v23.0";
const IG_BASE = `https://graph.instagram.com/${API_VERSION}`;
const FB_BASE = `https://graph.facebook.com/${API_VERSION}`;

const configId = () => process.env.INSTAGRAM_CONFIG_ID?.trim() || "";
export const usesUnifiedLogin = () => !!configId();

/** Instagram-Login tokens are prefixed "IG"; Facebook-Login tokens aren't. */
const baseFor = (token?: string) => (token?.startsWith("IG") ? IG_BASE : FB_BASE);

// The pre-2025 names (instagram_basic, instagram_content_publish, …) belong to
// the Facebook Login flow and are rejected here.
const DEFAULT_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
].join(",");

export class InstagramApiError extends Error {
  constructor(message: string, public code?: number, public subcode?: number) {
    super(message);
    this.name = "InstagramApiError";
  }
}

/** Turn a Graph API error response into a readable InstagramApiError. */
function wrap(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const e = err.response?.data?.error;
    if (e) {
      const msg = e.error_user_msg || e.message || "Instagram API error";
      throw new InstagramApiError(msg, e.code, e.error_subcode);
    }
    const flat = err.response?.data;
    if (flat?.error_message) throw new InstagramApiError(flat.error_message, flat.code);
  }
  throw err;
}

async function get<T = Record<string, unknown>>(path: string, params: Record<string, string>, base = baseFor(params.access_token)): Promise<T> {
  try {
    return (await axios.get(`${base}${path}`, { params })).data;
  } catch (err) { wrap(err); }
}

async function post<T = Record<string, unknown>>(path: string, params: Record<string, string>): Promise<T> {
  try {
    return (await axios.post(`${baseFor(params.access_token)}${path}`, new URLSearchParams(params))).data;
  } catch (err) { wrap(err); }
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export function getAuthUrl(state: string) {
  if (usesUnifiedLogin()) {
    // Permissions live in the Login for Business configuration, not in a scope param.
    const params = new URLSearchParams({
      client_id: process.env.INSTAGRAM_CLIENT_ID!,
      redirect_uri: process.env.INSTAGRAM_REDIRECT_URI!,
      config_id: configId(),
      response_type: "code",
      override_default_response_type: "true",
      // Shows the "Continue with Instagram / Facebook" choice instead of
      // dropping straight into a Facebook session + asset picker.
      prompt: "login",
      state,
    });
    return `https://www.facebook.com/${API_VERSION}/dialog/oauth?${params}`;
  }
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_CLIENT_ID!,
    redirect_uri: process.env.INSTAGRAM_REDIRECT_URI!,
    scope: process.env.INSTAGRAM_SCOPES || DEFAULT_SCOPES,
    response_type: "code",
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

/** Code → short-lived token → long-lived (60 day) token. */
export async function exchangeCode(code: string) {
  if (usesUnifiedLogin()) return exchangeCodeUnified(code);
  let shortLived: string;
  try {
    const res = await axios.post(
      "https://api.instagram.com/oauth/access_token",
      new URLSearchParams({
        client_id: process.env.INSTAGRAM_CLIENT_ID!,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET!,
        grant_type: "authorization_code",
        redirect_uri: process.env.INSTAGRAM_REDIRECT_URI!,
        // Instagram appends "#_" to the redirect; strip it if it leaked into the code.
        code: code.replace(/#_$/, ""),
      }),
    );
    // Documented shape is { data: [{ access_token, … }] }; the live API returns it flat.
    const body = Array.isArray(res.data?.data) ? res.data.data[0] : res.data;
    shortLived = body.access_token;
  } catch (err) { wrap(err); }

  const long = await get<{ access_token: string; expires_in: number }>("/access_token", {
    grant_type: "ig_exchange_token",
    client_secret: process.env.INSTAGRAM_CLIENT_SECRET!,
    access_token: shortLived,
  }, IG_BASE);
  return { accessToken: long.access_token, expiresIn: long.expires_in };
}

async function exchangeCodeUnified(code: string) {
  const short = await get<{ access_token: string; expires_in?: number }>("/oauth/access_token", {
    client_id: process.env.INSTAGRAM_CLIENT_ID!,
    client_secret: process.env.INSTAGRAM_CLIENT_SECRET!,
    redirect_uri: process.env.INSTAGRAM_REDIRECT_URI!,
    code: code.replace(/#_$/, ""),
  });
  return exchangeFacebookToken(short.access_token);
}

/** Short- (or long-) lived Facebook user token → fresh 60-day token. */
async function exchangeFacebookToken(token: string) {
  const res = await get<{ access_token: string; expires_in?: number }>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: process.env.INSTAGRAM_CLIENT_ID!,
    client_secret: process.env.INSTAGRAM_CLIENT_SECRET!,
    fb_exchange_token: token,
  });
  // Business-integration tokens can come back without an expiry (they don't expire).
  return { accessToken: res.access_token, expiresIn: res.expires_in ?? 60 * 24 * 3600 };
}

/**
 * Extend a long-lived token for another 60 days. Instagram only allows this
 * once the token is at least 24h old and not yet expired.
 */
export async function refreshAccessToken(accessToken: string) {
  if (!accessToken.startsWith("IG")) return exchangeFacebookToken(accessToken);
  const res = await get<{ access_token: string; expires_in: number }>("/refresh_access_token", {
    grant_type: "ig_refresh_token",
    access_token: accessToken,
  }, IG_BASE);
  return { accessToken: res.access_token, expiresIn: res.expires_in };
}

export type InstagramProfile = {
  /** Instagram professional account ID — the one the publishing endpoints take. */
  user_id: string;
  /** App-scoped ID (what deauthorize / data-deletion callbacks send). */
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: "BUSINESS" | "MEDIA_CREATOR" | string;
};

/**
 * Every Instagram professional account the token can publish to. Instagram
 * Login yields exactly one; Unified Login can yield several (one per account
 * the user picked in the dialog).
 */
export async function getProfiles(accessToken: string): Promise<InstagramProfile[]> {
  if (!usesUnifiedLogin()) return [await getProfile(accessToken)];

  type IgNode = { id: string; username?: string; name?: string; profile_picture_url?: string };
  const fields = "id,username,name,profile_picture_url";
  const found = new Map<string, IgNode>();

  // Accounts granted directly through Login for Business (no Page needed)…
  try {
    let r = await get<{ data?: IgNode[]; paging?: { next?: string } }>("/me/assigned_instagram_accounts", {
      fields, limit: "100", access_token: accessToken,
    });
    for (let page = 0; page < 10; page++) {
      for (const a of r.data ?? []) found.set(String(a.id), a);
      if (!r.paging?.next) break;
      r = (await axios.get(r.paging.next)).data;
    }
  } catch { /* not available for every token type — fall through */ }

  // …and accounts linked to a Facebook Page the user granted.
  try {
    const r = await get<{ data?: { instagram_business_account?: IgNode }[] }>("/me/accounts", {
      fields: `instagram_business_account{${fields}}`, limit: "100", access_token: accessToken,
    });
    for (const p of r.data ?? []) {
      const a = p.instagram_business_account;
      if (a) found.set(String(a.id), a);
    }
  } catch { /* no Page permissions in the configuration */ }

  return [...found.values()].map((a) => ({
    user_id: String(a.id),
    id: String(a.id),
    username: a.username ?? String(a.id),
    name: a.name,
    profile_picture_url: a.profile_picture_url,
  }));
}

export async function getProfile(accessToken: string): Promise<InstagramProfile> {
  const p = await get<InstagramProfile>("/me", {
    fields: "user_id,id,username,name,profile_picture_url,account_type",
    access_token: accessToken,
  }, IG_BASE);
  return { ...p, user_id: String(p.user_id), id: String(p.id) };
}

/**
 * Verify and decode the `signed_request` Meta posts to the deauthorize and
 * data-deletion callbacks. Returns null if the signature doesn't match.
 */
export function parseSignedRequest(signedRequest: string): { user_id: string; [k: string]: unknown } | null {
  const [sig, payload] = signedRequest.split(".", 2);
  if (!sig || !payload) return null;
  const expected = crypto
    .createHmac("sha256", process.env.INSTAGRAM_CLIENT_SECRET!)
    .update(payload)
    .digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data?.user_id ? { ...data, user_id: String(data.user_id) } : null;
  } catch {
    return null;
  }
}

// ─── Account ─────────────────────────────────────────────────────────────────

export async function getAccountStats(accessToken: string, userId: string) {
  const res = await get<{ followers_count?: number; follows_count?: number; media_count?: number }>(`/${userId}`, {
    fields: "followers_count,follows_count,media_count",
    access_token: accessToken,
  });
  return {
    followers: res.followers_count ?? 0,
    following: res.follows_count ?? 0,
    posts: res.media_count ?? 0,
    views: 0,
  };
}

// ─── Publishing ──────────────────────────────────────────────────────────────

const VIDEO_RE = /\.(mp4|mov|m4v|webm)(\?|$)/i;
export const isVideoUrl = (url: string) => VIDEO_RE.test(url);

/**
 * Instagram downloads the media itself, so it needs a public https URL.
 * Local-dev uploads (/uploads/…) are resolved against NEXT_PUBLIC_APP_URL,
 * which only works if that's a public tunnel, not localhost.
 */
function publicMediaUrl(url: string): string {
  const abs = /^https?:\/\//i.test(url) ? url : new URL(url, process.env.NEXT_PUBLIC_APP_URL).toString();
  const host = new URL(abs).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    throw new Error(
      "Instagram needs to download the media from a public URL. Set BLOB_READ_WRITE_TOKEN (Vercel Blob) or point NEXT_PUBLIC_APP_URL at a public tunnel.",
    );
  }
  return abs;
}

/** Poll a media container until Instagram has finished processing it. */
async function waitForContainer(accessToken: string, containerId: string, timeoutMs = 240_000) {
  const started = Date.now();
  let delay = 3000;
  while (Date.now() - started < timeoutMs) {
    const c = await get<{ status_code?: string; status?: string }>(`/${containerId}`, {
      fields: "status_code,status",
      access_token: accessToken,
    });
    if (c.status_code === "FINISHED" || c.status_code === "PUBLISHED") return;
    if (c.status_code === "ERROR" || c.status_code === "EXPIRED") {
      throw new InstagramApiError(`Instagram couldn't process the media: ${c.status ?? c.status_code}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 10_000);
  }
  throw new InstagramApiError("Instagram is still processing the video — timed out waiting. Try again in a few minutes.");
}

async function createContainer(accessToken: string, userId: string, params: Record<string, string>) {
  const res = await post<{ id: string }>(`/${userId}/media`, { ...params, access_token: accessToken });
  return res.id;
}

export type PublishOptions = {
  caption: string;
  mediaUrls: string[];
  shareToFeed?: boolean;
  coverUrl?: string;
};

/**
 * Publish a Reel (one video), a single image, or a carousel (2–10 items).
 * Images must be JPEG. Returns the published media ID.
 */
export async function publishMedia(accessToken: string, userId: string, opts: PublishOptions): Promise<string> {
  const urls = opts.mediaUrls.map(publicMediaUrl);
  if (urls.length === 0) throw new Error("Instagram posts need a video or at least one image.");
  const caption = opts.caption.slice(0, 2200);

  let containerId: string;
  if (urls.length === 1 && isVideoUrl(urls[0])) {
    containerId = await createContainer(accessToken, userId, {
      media_type: "REELS",
      video_url: urls[0],
      caption,
      share_to_feed: String(opts.shareToFeed ?? true),
      ...(opts.coverUrl ? { cover_url: publicMediaUrl(opts.coverUrl) } : {}),
    });
  } else if (urls.length === 1) {
    containerId = await createContainer(accessToken, userId, { image_url: urls[0], caption });
  } else {
    if (urls.length > 10) throw new Error("Instagram carousels can have at most 10 items.");
    const children: string[] = [];
    for (const u of urls) {
      children.push(await createContainer(accessToken, userId, {
        is_carousel_item: "true",
        ...(isVideoUrl(u) ? { media_type: "VIDEO", video_url: u } : { image_url: u }),
      }));
    }
    for (const id of children) await waitForContainer(accessToken, id);
    containerId = await createContainer(accessToken, userId, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption,
    });
  }

  await waitForContainer(accessToken, containerId);
  const published = await post<{ id: string }>(`/${userId}/media_publish`, {
    creation_id: containerId,
    access_token: accessToken,
  });
  return published.id;
}

/** Back-compat wrapper for single-image posts. */
export async function publishPost(accessToken: string, userId: string, content: string, imageUrl?: string) {
  if (!imageUrl) throw new Error("Instagram requires an image or video");
  return publishMedia(accessToken, userId, { caption: content, mediaUrls: [imageUrl] });
}

export async function getPermalink(accessToken: string, mediaId: string): Promise<string | null> {
  const res = await get<{ permalink?: string }>(`/${mediaId}`, { fields: "permalink", access_token: accessToken });
  return res.permalink ?? null;
}

// ─── Insights & comments ─────────────────────────────────────────────────────

export async function getPostInsights(accessToken: string, mediaId: string) {
  // `impressions` was retired in 2025; `views` replaces it.
  const res = await get<{ data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
    `/${mediaId}/insights`,
    { metric: "views,reach,likes,comments,shares,saved", access_token: accessToken },
  );
  const m: Record<string, number> = {};
  for (const item of res.data ?? []) {
    m[item.name] = item.values?.[0]?.value ?? item.total_value?.value ?? 0;
  }
  return {
    impressions: m.views ?? 0,
    reach: m.reach ?? 0,
    likes: m.likes ?? 0,
    comments: m.comments ?? 0,
    shares: m.shares ?? 0,
  };
}

type IGComment = { id: string; text: string; username: string; timestamp: string; replies?: { data: { username?: string }[] } };

export async function getComments(accessToken: string, mediaId: string) {
  let res: { data: IGComment[] };
  try {
    // replies{username} lets the auto-responder skip comments the owner already answered.
    res = await get<{ data: IGComment[] }>(`/${mediaId}/comments`, { fields: "id,text,username,timestamp,replies{username}", access_token: accessToken });
  } catch {
    res = await get<{ data: IGComment[] }>(`/${mediaId}/comments`, { fields: "id,text,username,timestamp", access_token: accessToken });
  }
  return (res.data ?? []).map((c) => ({
    id: c.id, text: c.text, username: c.username, timestamp: c.timestamp,
    replyUsernames: (c.replies?.data ?? []).map((r) => r.username).filter(Boolean) as string[],
  }));
}

export async function replyToComment(accessToken: string, commentId: string, message: string) {
  await post(`/${commentId}/replies`, { message, access_token: accessToken });
}
