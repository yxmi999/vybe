import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import path from "path";
import os from "os";
import { storeTempFile } from "@/lib/storage";
import { parseRumbleUrl } from "@/lib/rumble";
import { getServerSession } from "@/lib/auth";
import { checkClipQuota, quotaMessage, recordClip } from "@/lib/plan";
import {
  extractTwitchVodSection, extractKickVodSection, extractYoutubeVodSection, extractRumbleVodSection,
  type ExtractOpts,
} from "@/lib/vod-extract";

export const maxDuration = 300;

// yt-dlp-exec uses __dirname internally which Next.js's bundler rewrites.
// Use the `create` factory with an explicit path based on process.cwd() instead.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create: createYtDlp } = require("yt-dlp-exec") as {
  create: (binPath: string) => (url: string, flags: Record<string, unknown>) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

const ytDlpBin = path.join(
  process.cwd(),
  "node_modules",
  "yt-dlp-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);
const ytDlp = createYtDlp(ytDlpBin);

// YouTube serves mp4-container video in both H.264 (avc1) and AV1 (av01); the
// bundled ffmpeg can't decode AV1. Select H.264 video + AAC audio by codec, not
// just container, so what we download always decodes and always carries audio.
// The final generic fallbacks only kick in for the rare video with no avc1.
const YT_FORMAT =
  "bestvideo[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/" +
  "bestvideo[vcodec^=avc1][height<=720]+bestaudio/" +
  "best[vcodec^=avc1][height<=720]/best[ext=mp4][height<=720]/best[height<=720]/best";

// ─── Twitch ──────────────────────────────────────────────────────────────────

function parseTwitchSlug(url: string): string | null {
  const m = url.match(/(?:twitch\.tv\/clips\/|clips\.twitch\.tv\/|twitch\.tv\/[^/]+\/clip\/)([A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

const GQL_QUERY = (slug: string) => ({
  query: `{
    clip(slug: "${slug}") {
      title
      durationSeconds
      thumbnailURL
      videoQualities { quality sourceURL }
      broadcaster { displayName login }
    }
  }`,
});

// Keyless clip lookup via the public GQL endpoint. Returns null when the clip
// has no playable qualities (deleted / restricted) so Promise.any can move on.
async function tryGql(slug: string, clientId: string) {
  const res = await axios.post("https://gql.twitch.tv/gql", GQL_QUERY(slug), {
    headers: { "Client-ID": clientId },
    timeout: 4000,
  });
  const clip = res.data?.data?.clip;
  if (!clip?.videoQualities?.length) return null;
  const qualities: { quality: string; sourceURL: string }[] = clip.videoQualities;
  const best = qualities.find((q) => q.quality === "720") ?? qualities.find((q) => q.quality === "480") ?? qualities[0];
  return {
    platform: "twitch" as const,
    title: clip.title as string,
    duration: clip.durationSeconds as number,
    thumbnailUrl: clip.thumbnailURL as string,
    videoUrl: best.sourceURL,
    streamer: (clip.broadcaster?.displayName ?? clip.broadcaster?.login ?? "Unknown") as string,
    clipPageUrl: `https://clips.twitch.tv/${slug}`,
  };
}

async function fetchTwitchClip(slug: string) {
  const clipUrl = `https://clips.twitch.tv/${slug}`;
  // Keyless by design — public client-IDs (one usually responds) raced against
  // yt-dlp, which handles Twitch's token signing. No TWITCH_CLIENT_ID needed.
  const publicClientIds = [
    "kimne78kx3ncx6brgo4mv6wki8h31s1",
    "kd1unb4b3q4t58fwlpcbzcbnm76a8fp",
    "ue6znezmtq1l2iqlm5eiwtui2g6a78v",
  ];

  const strategies: Promise<Awaited<ReturnType<typeof tryGql>>>[] = [
    ...publicClientIds.map((id) =>
      tryGql(slug, id).then((r) => { if (!r) throw new Error("no qualities"); return r; }),
    ),
    fetchMetaWithYtDlp(clipUrl, "twitch"),
  ];

  try {
    const result = await Promise.any(strategies);
    if (result) return result;
  } catch { /* all failed, throw descriptive error below */ }

  throw new Error(
    "Could not fetch this Twitch clip — it may be deleted, subscriber-only, or temporarily unavailable. " +
    "Try again in a moment, or paste a different clip URL.",
  );
}

// ─── yt-dlp: metadata only (used for Twitch fallback strategy) ────────────────

interface YtDlpInfo {
  title?: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  channel?: string;
  creator?: string;
  url?: string;
}

async function fetchMetaWithYtDlp<P extends "youtube" | "tiktok" | "instagram" | "kick" | "twitch">(url: string, platform: P) {
  let info: YtDlpInfo;
  try {
    info = (await ytDlp(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      ffmpegLocation: ffmpegPath,
      format: platform === "youtube"
        ? YT_FORMAT
        : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
    })) as YtDlpInfo;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).split("\n").filter(Boolean).slice(0, 3).join(" | ");
    if (/login required|sign in|private/i.test(detail)) {
      throw new Error("This video is private or requires login. Only public content can be downloaded.");
    }
    throw new Error(`Could not fetch video info: ${detail}`);
  }

  return {
    platform,
    title: info.title ?? "Clip",
    duration: info.duration ?? 0,
    thumbnailUrl: info.thumbnail ?? "",
    videoUrl: info.url ?? "",
    streamer: info.uploader ?? info.channel ?? info.creator ?? "Unknown",
    clipPageUrl: url,
    alreadySaved: false,
  };
}

// ─── yt-dlp: metadata + download in one step (Kick, TikTok, YouTube, Instagram) ─

async function fetchAndDownloadWithYtDlp(url: string, platform: "youtube" | "tiktok" | "instagram" | "kick" | "rumble") {
  // Step 1: metadata
  let info: YtDlpInfo;
  const format = platform === "youtube"
    ? YT_FORMAT
    : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best";
  try {
    info = (await ytDlp(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      ffmpegLocation: ffmpegPath,
      format,
    })) as YtDlpInfo;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).split("\n").filter(Boolean).slice(0, 3).join(" | ");
    if (/login required|sign in|private/i.test(detail)) {
      throw new Error("This video is private or requires login. Only public content can be downloaded.");
    }
    throw new Error(`Could not fetch video info: ${detail}`);
  }

  // Step 2: download
  const safe = (info.title ?? "clip").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
  const base = `vybe-${Date.now()}-${safe}`;
  const tmpPath = path.join(os.tmpdir(), `${base}.mp4`);

  const dlOpts: Record<string, unknown> = {
    output: tmpPath,
    format,
    mergeOutputFormat: "mp4",
    recodeVideo: "mp4",
    ffmpegLocation: ffmpegPath,
    noCheckCertificates: true,
    noWarnings: true,
  };
  if (platform === "tiktok") {
    dlOpts.addHeader = "Referer:https://www.tiktok.com/";
  }

  try {
    await ytDlp(url, dlOpts);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).split("\n").filter(Boolean).slice(0, 3).join(" | ");
    throw new Error(`Could not download video: ${detail}`);
  }

  // Step 3: find file (yt-dlp may add/change extension)
  const { existsSync, readdirSync } = await import("fs");
  let usedPath = tmpPath;
  if (!existsSync(tmpPath)) {
    const dir = path.dirname(tmpPath);
    const match = readdirSync(dir).find((f) => f.startsWith(base));
    if (!match) throw new Error("Download completed but file not found");
    usedPath = path.join(dir, match);
  }

  // Step 4: store and clean up
  const storedUrl = await storeTempFile(usedPath, `${base}.mp4`, "video/mp4");
  const { unlink } = await import("fs/promises");
  await unlink(usedPath).catch(() => {});

  return {
    platform,
    title: info.title ?? "Clip",
    duration: info.duration ?? 0,
    thumbnailUrl: info.thumbnail ?? "",
    videoUrl: storedUrl,
    streamer: info.uploader ?? info.channel ?? info.creator ?? "Unknown",
    clipPageUrl: url,
    alreadySaved: true,
  };
}

// ─── VOD sections ─────────────────────────────────────────────────────────────
// The auto-clipper's VOD mode hands us <vodUrl>?t=<sec>&d=<sec>. The per-platform
// section cutters (Twitch, Kick, YouTube, Rumble) now live in @/lib/vod-extract
// so the Auto-Pilot engine and the batch clipper can reuse the exact same cut.

// An optional &peak=<secondsIntoWindow> lets "Auto" length requests silence-snap
// the cut to the nearest natural pause around the real peak, instead of just
// handing back the raw fixed window.
function peakOpts(u: URL): ExtractOpts {
  const peak = Number(u.searchParams.get("peak"));
  return Number.isFinite(peak) && u.searchParams.get("peak") != null ? { peakOffset: peak } : {};
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function extractAxiosMessage(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { message?: string; error?: string } }; message?: string };
  if (e.response?.data?.message) return e.response.data.message;
  if (e.response?.data?.error) return e.response.data.error;
  if (e.response?.status === 401) return "The source rejected the request (401). The clip may be private or require login — only public content can be fetched.";
  if (e.response?.status === 403) return "Platform API returned 403 Forbidden. The clip may be private or the API has restricted access.";
  if (err instanceof Error) return err.message;
  return "Failed to fetch clip";
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { url } = await req.json();
  if (!url) return NextResponse.json({ error: "URL is required" }, { status: 400 });

  // Loading a clip into the editor (manual or from the auto-clipper) is the main
  // way new clips enter, so it counts toward the monthly cap.
  const quota = await checkClipQuota(session.userId);
  if (!quota.allowed) return NextResponse.json({ error: quotaMessage(quota) }, { status: 403 });

  const res = await handleFetch(url);
  try {
    if (res.status === 200) {
      const body = (await res.clone().json()) as { videoUrl?: string };
      if (body?.videoUrl) await recordClip({ userId: session.userId, url: body.videoUrl, kind: "import", countsQuota: true });
    }
  } catch { /* recording is best-effort */ }
  return res;
}

async function handleFetch(url: string): Promise<NextResponse> {
  try {
    // Twitch VOD moment with a time window (from the auto-clipper's VOD mode)
    const twVod = url.match(/twitch\.tv\/videos\/(\d+)/i);
    if (twVod) {
      const u = new URL(url.startsWith("http") ? url : `https://${url}`);
      const t = Number(u.searchParams.get("t"));
      const d = Number(u.searchParams.get("d"));
      if (Number.isFinite(t) && d > 0) {
        return NextResponse.json(await extractTwitchVodSection(twVod[1], t, Math.min(d, 300), peakOpts(u)));
      }
      return NextResponse.json(
        { error: "That's a full VOD. Use the auto-clipper's \"From VOD\" mode to cut moments out of it." },
        { status: 400 },
      );
    }

    if (url.includes("twitch.tv") || url.includes("clips.twitch.tv")) {
      const slug = parseTwitchSlug(url);
      if (!slug) return NextResponse.json({ error: "Could not parse Twitch clip URL." }, { status: 400 });
      return NextResponse.json(await fetchTwitchClip(slug));
    }

    // VOD moment with a time window (from the auto-clipper's VOD mode)
    if (/kick\.com\/video\//i.test(url)) {
      const u = new URL(url);
      const uuid = u.pathname.match(/\/video\/([0-9a-f-]+)/i)?.[1];
      const t = Number(u.searchParams.get("t"));
      const d = Number(u.searchParams.get("d"));
      if (uuid && Number.isFinite(t) && d > 0) {
        return NextResponse.json(await extractKickVodSection(uuid, t, Math.min(d, 300), peakOpts(u)));
      }
      // no window specified — fall through to yt-dlp (downloads the whole VOD)
    }

    if (url.includes("kick.com")) {
      return NextResponse.json(await fetchAndDownloadWithYtDlp(url, "kick"));
    }

    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      // A YouTube moment with a time window (from the auto-clipper's VOD mode).
      const u = new URL(url.startsWith("http") ? url : `https://${url}`);
      const ytId =
        u.searchParams.get("v") ??
        url.match(/(?:youtu\.be\/|youtube\.com\/(?:live\/|shorts\/|embed\/|v\/))([A-Za-z0-9_-]{11})/)?.[1] ??
        null;
      const t = Number(u.searchParams.get("t"));
      const d = Number(u.searchParams.get("d"));
      if (ytId && Number.isFinite(t) && d > 0) {
        return NextResponse.json(await extractYoutubeVodSection(ytId, t, Math.min(d, 300), peakOpts(u)));
      }
      return NextResponse.json(await fetchAndDownloadWithYtDlp(url, "youtube"));
    }

    if (url.includes("rumble.com")) {
      const rumbleUrl = parseRumbleUrl(url);
      if (rumbleUrl) {
        const u = new URL(url.startsWith("http") ? url : `https://${url}`);
        const t = Number(u.searchParams.get("t"));
        const d = Number(u.searchParams.get("d"));
        if (Number.isFinite(t) && d > 0) {
          return NextResponse.json(await extractRumbleVodSection(rumbleUrl, t, Math.min(d, 300), peakOpts(u)));
        }
        return NextResponse.json(await fetchAndDownloadWithYtDlp(rumbleUrl, "rumble"));
      }
      return NextResponse.json({ error: "Could not parse that Rumble URL." }, { status: 400 });
    }

    if (url.includes("tiktok.com")) {
      return NextResponse.json(await fetchAndDownloadWithYtDlp(url, "tiktok"));
    }

    if (url.includes("instagram.com")) {
      return NextResponse.json(await fetchAndDownloadWithYtDlp(url, "instagram"));
    }

    return NextResponse.json(
      { error: "Unsupported URL. Paste a link from Twitch, Kick, YouTube, TikTok, or Instagram." },
      { status: 400 }
    );
  } catch (err: unknown) {
    return NextResponse.json({ error: extractAxiosMessage(err) }, { status: 500 });
  }
}
