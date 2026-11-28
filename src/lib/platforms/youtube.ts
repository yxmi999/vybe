import axios from "axios";
import { readFile } from "fs/promises";
import { localMediaPath } from "../desktop";

const OAUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const YT_BASE = "https://www.googleapis.com/youtube/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";

export function getAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID!,
    redirect_uri: process.env.YOUTUBE_REDIRECT_URI!,
    response_type: "code",
    // Keep this list minimal — every scope must be justified in Google's OAuth
    // verification review. force-ssl already covers reading channel/video data
    // and managing comments, so youtube.readonly is redundant.
    scope: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ].join(" "),
    include_granted_scopes: "true",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${OAUTH_BASE}?${params}`;
}

export async function exchangeCode(code: string) {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID!,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: process.env.YOUTUBE_REDIRECT_URI!,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data;
}

export async function refreshAccessToken(refreshToken: string) {
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID!,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data;
}

export async function getChannel(accessToken: string) {
  const res = await axios.get(`${YT_BASE}/channels`, {
    params: { part: "snippet", mine: true },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data.items?.[0];
}

export async function getChannelStats(accessToken: string) {
  const res = await axios.get(`${YT_BASE}/channels`, {
    params: { part: "statistics", mine: true },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const stats = res.data.items?.[0]?.statistics ?? {};
  return {
    followers: parseInt(stats.subscriberCount ?? "0"),
    following: 0,
    posts: parseInt(stats.videoCount ?? "0"),
    views: parseInt(stats.viewCount ?? "0"),
  };
}

// YouTube rejects ("invalid or empty video title") a title that is empty,
// over 100 characters, or contains < or >. Descriptions: no < >, ≤ 5000 bytes.
const TITLE_MAX = 100;
const DESC_MAX_BYTES = 5000;

function clipChars(s: string, max: number): string {
  const chars = Array.from(s); // count emoji / non-Latin as one character, never split them
  return chars.length <= max ? s : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

function clipBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/** A title YouTube will accept: cleaned, never empty, ≤ 100 chars incl. " #Shorts". */
export function youtubeTitle(title: string, description: string, isShort: boolean): string {
  const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  let base = clean(title);
  if (!base) base = clean(description.split("\n").find((l) => clean(l)) ?? "");
  if (!base) base = "New video";
  const tag = " #Shorts";
  if (isShort && !base.includes("#Shorts")) {
    return clipChars(base, TITLE_MAX - tag.length) + tag;
  }
  return clipChars(base, TITLE_MAX);
}

export async function uploadVideo(
  accessToken: string,
  localPath: string,
  title: string,
  description: string,
  isShort: boolean,
  tags: string[] = [],
  category: string = "22",
  privacy: "public" | "private" | "unlisted" = "public"
) {
  // Hosted clips live on Vercel Blob (https URL); local dev uses /uploads/ paths.
  const fileBuffer = /^https?:\/\//i.test(localPath)
    ? Buffer.from(
        (
          await axios.get<ArrayBuffer>(localPath, {
            responseType: "arraybuffer",
            timeout: 300_000,
            maxContentLength: Infinity,
          })
        ).data
      )
    : await readFile(localMediaPath(localPath));
  const fileSize = fileBuffer.length;

  // YouTube detects Shorts by aspect ratio + length; #Shorts tag helps discovery
  const finalTitle = youtubeTitle(title, description, isShort);
  const cleanDesc = description.replace(/[<>]/g, "");
  const finalDesc = clipBytes(isShort && !cleanDesc.includes("#Shorts") ? `${cleanDesc}\n#Shorts` : cleanDesc, DESC_MAX_BYTES);

  // Step 1: Initiate resumable upload session
  const initRes = await axios.post(
    `${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`,
    {
      snippet: {
        title: finalTitle,
        description: finalDesc,
        categoryId: category,
        tags: tags.length > 0 ? tags : undefined,
      },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/*",
        "X-Upload-Content-Length": String(fileSize),
      },
    }
  );

  const uploadUrl = initRes.headers["location"] as string;
  if (!uploadUrl) throw new Error("YouTube did not return an upload URL");

  // Step 2: Upload the video bytes
  const uploadRes = await axios.put(uploadUrl, fileBuffer, {
    headers: {
      "Content-Type": "video/*",
      "Content-Length": String(fileSize),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // API projects that haven't passed the YouTube API Services audit have every
  // upload force-locked to private, regardless of the privacyStatus requested.
  const actualPrivacy = uploadRes.data?.status?.privacyStatus;
  if (privacy !== "private" && actualPrivacy === "private") {
    console.warn(
      `[youtube] Video ${uploadRes.data.id} was locked to private (requested "${privacy}"). ` +
      "The Google Cloud project likely needs the YouTube API Services audit: " +
      "https://support.google.com/youtube/contact/yt_api_form"
    );
  }

  return uploadRes.data.id as string;
}

export async function getVideoComments(accessToken: string, videoId: string) {
  const res = await axios.get(`${YT_BASE}/commentThreads`, {
    params: { part: "snippet,replies", videoId, maxResults: "100", order: "time", textFormat: "plainText" },
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  type YTSnippet = {
    textDisplay: string; textOriginal?: string; authorDisplayName: string; publishedAt: string;
    authorChannelId?: { value: string };
  };
  type YTCommentThread = {
    snippet: {
      topLevelComment: { id: string; snippet: YTSnippet };
      canReply: boolean;
      totalReplyCount?: number;
    };
    replies?: { comments: { snippet: YTSnippet }[] };
  };

  return (res.data.items ?? []).map((item: YTCommentThread) => {
    const top = item.snippet.topLevelComment.snippet;
    return {
      threadId: item.snippet.topLevelComment.id,
      text: top.textOriginal ?? top.textDisplay,
      author: top.authorDisplayName,
      authorChannelId: top.authorChannelId?.value ?? null,
      publishedAt: top.publishedAt,
      canReply: item.snippet.canReply,
      /** Channel ids that already replied in this thread (first few replies only). */
      replyAuthorIds: (item.replies?.comments ?? []).map((c) => c.snippet.authorChannelId?.value).filter(Boolean) as string[],
    };
  });
}

export async function replyToComment(accessToken: string, parentId: string, text: string) {
  const res = await axios.post(
    `${YT_BASE}/comments`,
    { snippet: { parentId, textOriginal: text } },
    {
      params: { part: "snippet" },
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    }
  );
  return res.data.id as string;
}

export async function getVideoMetrics(accessToken: string, videoId: string) {
  const res = await axios.get(`${YT_BASE}/videos`, {
    params: { part: "statistics", id: videoId },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const stats = res.data.items?.[0]?.statistics ?? {};
  return {
    likes: parseInt(stats.likeCount ?? "0"),
    comments: parseInt(stats.commentCount ?? "0"),
    shares: 0,
    reach: parseInt(stats.viewCount ?? "0"),
    impressions: parseInt(stats.viewCount ?? "0"),
  };
}
