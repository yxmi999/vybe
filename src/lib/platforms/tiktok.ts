import axios from "axios";

const BASE = "https://open.tiktokapis.com/v2";

export function getAuthUrl(state: string, codeVerifier: string) {
  const csrfState = state;
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY!,
    redirect_uri: process.env.TIKTOK_REDIRECT_URI!,
    response_type: "code",
    // Every scope here must be enabled for the app (sandbox or production) in the
    // TikTok developer portal, or TikTok rejects the login with a "scope" error.
    // Override with TIKTOK_SCOPES to match what the portal has approved.
    scope: process.env.TIKTOK_SCOPES || "user.info.basic,video.publish,video.upload",
    state: csrfState,
    code_challenge: codeVerifier,
    code_challenge_method: "S256",
  });
  return `https://www.tiktok.com/v2/auth/authorize?${params}`;
}

export async function exchangeCode(code: string, codeVerifier: string) {
  const res = await axios.post(
    "https://open.tiktokapis.com/v2/oauth/token/",
    new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY!,
      client_secret: process.env.TIKTOK_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: process.env.TIKTOK_REDIRECT_URI!,
      code_verifier: codeVerifier,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data;
}

export async function getProfile(accessToken: string) {
  const res = await axios.get(`${BASE}/user/info/`, {
    params: { fields: "open_id,union_id,avatar_url,display_name" },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data.data.user;
}

export async function getUserStats(accessToken: string) {
  const res = await axios.get(`${BASE}/user/info/`, {
    params: { fields: "follower_count,following_count,likes_count,video_count" },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = res.data.data?.user ?? {};
  return {
    followers: user.follower_count ?? 0,
    following: user.following_count ?? 0,
    posts: user.video_count ?? 0,
    views: user.likes_count ?? 0, // total likes received on all videos
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const res = await axios.post(
    "https://open.tiktokapis.com/v2/oauth/token/",
    new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY!,
      client_secret: process.env.TIKTOK_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  if (res.data.error) throw new Error(res.data.error_description || res.data.error);
  return res.data as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** Revoke Vybe's access to the TikTok account (used on disconnect). */
export async function revokeAccess(accessToken: string) {
  await axios.post(
    "https://open.tiktokapis.com/v2/oauth/revoke/",
    new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY!,
      client_secret: process.env.TIKTOK_CLIENT_SECRET!,
      token: accessToken,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
}

// ─── Content Posting API ─────────────────────────────────────────────────────

export type PrivacyLevel = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

export type CreatorInfo = {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: PrivacyLevel[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
};

/** Thrown when TikTok answers with an error code (e.g. the creator hit their posting cap). */
export class TikTokApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function json(accessToken: string) {
  return { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" } };
}

function unwrap<T>(body: { data?: T; error?: { code?: string; message?: string } }): T {
  const code = body.error?.code;
  if (code && code !== "ok") throw new TikTokApiError(code, body.error?.message || code);
  return body.data as T;
}

async function call<T>(fn: () => Promise<{ data: { data?: T; error?: { code?: string; message?: string } } }>): Promise<T> {
  try {
    return unwrap((await fn()).data);
  } catch (err) {
    if (err instanceof TikTokApiError) throw err;
    const body = (err as { response?: { data?: { error?: { code?: string; message?: string } } } })?.response?.data;
    if (body?.error?.code) throw new TikTokApiError(body.error.code, body.error.message || body.error.code);
    throw err;
  }
}

/** Must be called right before showing the posting screen (TikTok UX requirement). */
export function queryCreatorInfo(accessToken: string) {
  return call<CreatorInfo>(() => axios.post(`${BASE}/post/publish/creator_info/query/`, {}, json(accessToken)));
}

// TikTok chunk rules: a video under 64 MB goes up in one chunk; otherwise
// chunks are 5–64 MB, count = floor(size / chunk), and the last chunk absorbs
// the remainder (up to 128 MB).
function chunkPlan(size: number) {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 32 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

export type DirectPostInfo = {
  title: string;
  privacyLevel: PrivacyLevel;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContent: boolean;  // "Branded content" — paid partnership
  brandOrganic: boolean;  // "Your brand" — promotional content
};

/**
 * Upload a video and either publish it (mode "direct", needs video.publish)
 * or send it to the creator's TikTok inbox as a draft (mode "inbox", needs
 * video.upload). Returns the publish_id for status polling.
 */
export async function postVideo(
  accessToken: string,
  video: Buffer,
  mode: "direct" | "inbox",
  info?: DirectPostInfo
): Promise<string> {
  const { chunkSize, count } = chunkPlan(video.length);
  const source_info = { source: "FILE_UPLOAD", video_size: video.length, chunk_size: chunkSize, total_chunk_count: count };

  const init = mode === "direct"
    ? await call<{ publish_id: string; upload_url: string }>(() => axios.post(`${BASE}/post/publish/video/init/`, {
        post_info: {
          title: info!.title,
          privacy_level: info!.privacyLevel,
          disable_comment: info!.disableComment,
          disable_duet: info!.disableDuet,
          disable_stitch: info!.disableStitch,
          brand_content_toggle: info!.brandContent,
          brand_organic_toggle: info!.brandOrganic,
        },
        source_info,
      }, json(accessToken)))
    : await call<{ publish_id: string; upload_url: string }>(() =>
        axios.post(`${BASE}/post/publish/inbox/video/init/`, { source_info }, json(accessToken)));

  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? video.length : start + chunkSize;
    await axios.put(init.upload_url, video.subarray(start, end), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start),
        "Content-Range": `bytes ${start}-${end - 1}/${video.length}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000,
    });
  }
  return init.publish_id;
}

export type PublishStatus = {
  status: "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED";
  fail_reason?: string;
  publicaly_available_post_id?: (string | number)[];
};

export function fetchPublishStatus(accessToken: string, publishId: string) {
  return call<PublishStatus>(() =>
    axios.post(`${BASE}/post/publish/status/fetch/`, { publish_id: publishId }, json(accessToken)));
}

export async function getVideoMetrics(accessToken: string, videoIds: string[]) {
  const res = await axios.post(
    `${BASE}/video/list/`,
    { filters: { video_ids: videoIds } },
    {
      params: { fields: "id,like_count,comment_count,share_count,view_count" },
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    }
  );
  const video = res.data.data.videos?.[0];
  if (!video) return { likes: 0, comments: 0, shares: 0, reach: 0, impressions: 0 };
  return {
    likes: video.like_count ?? 0,
    comments: video.comment_count ?? 0,
    shares: video.share_count ?? 0,
    reach: video.view_count ?? 0,
    impressions: video.view_count ?? 0,
  };
}
