import axios from "axios";
import crypto from "crypto";

const BASE = "https://api.twitter.com/2";
const UPLOAD_BASE = "https://upload.twitter.com/1.1";

export function getAuthUrl(state: string, codeVerifier: string) {
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.TWITTER_CLIENT_ID!,
    redirect_uri: process.env.TWITTER_REDIRECT_URI!,
    scope: "tweet.read tweet.write users.read offline.access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://twitter.com/i/oauth2/authorize?${params}`;
}

export async function exchangeCode(code: string, codeVerifier: string) {
  const credentials = Buffer.from(
    `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
  ).toString("base64");

  const res = await axios.post(
    "https://api.twitter.com/2/oauth2/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.TWITTER_REDIRECT_URI!,
      code_verifier: codeVerifier,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return res.data;
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const credentials = Buffer.from(
    `${process.env.TWITTER_CLIENT_ID}:${process.env.TWITTER_CLIENT_SECRET}`
  ).toString("base64");

  try {
    const res = await axios.post(
      "https://api.twitter.com/2/oauth2/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return res.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const detail = JSON.stringify(err.response.data);
      throw new Error(`Twitter token refresh failed (${err.response.status}): ${detail}`);
    }
    throw err;
  }
}

export async function getProfile(accessToken: string) {
  const res = await axios.get(`${BASE}/users/me`, {
    params: { "user.fields": "id,name,username,profile_image_url" },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data.data;
}

export async function getUserStats(accessToken: string) {
  const res = await axios.get(`${BASE}/users/me`, {
    params: { "user.fields": "public_metrics" },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const m = res.data.data?.public_metrics ?? {};
  return {
    followers: m.followers_count ?? 0,
    following: m.following_count ?? 0,
    posts: m.tweet_count ?? 0,
    views: 0,
  };
}

export async function publishTweet(accessToken: string, text: string, mediaId?: string) {
  const body: Record<string, unknown> = { text };
  if (mediaId) body.media = { media_ids: [mediaId] };

  try {
    const res = await axios.post(`${BASE}/tweets`, body, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    return res.data.data.id as string;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const detail = JSON.stringify(err.response.data);
      throw new Error(`Twitter API ${err.response.status}: ${detail}`);
    }
    throw err;
  }
}

export async function uploadMedia(accessToken: string, mediaBuffer: Buffer, mimeType: string) {
  // Twitter uses OAuth 1.0a for media upload — simplified here using user token
  const res = await axios.post(
    `${UPLOAD_BASE}/media/upload.json`,
    { media_data: mediaBuffer.toString("base64") },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.media_id_string;
}

export async function getTweetMetrics(accessToken: string, tweetId: string) {
  const res = await axios.get(`${BASE}/tweets/${tweetId}`, {
    params: { "tweet.fields": "public_metrics" },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const m = res.data.data.public_metrics;
  return {
    likes: m.like_count,
    comments: m.reply_count,
    shares: m.retweet_count,
    impressions: m.impression_count ?? 0,
    reach: m.impression_count ?? 0,
  };
}
