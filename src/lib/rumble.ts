// Rumble auto-clipper support, built on yt-dlp (no API key needed).
//
// Rumble gives us none of the engagement signals the other platforms do — no
// clips API, no "most replayed" heatmap, no usable live-chat replay. What every
// video does have is audio, so highlights come from loudness: the loudest
// moments (laughs, big plays, crowd/host reactions) are what a clipper chases.
// Channel listing is unreliable in yt-dlp, so Rumble takes a direct video URL.

import path from "path";

// yt-dlp-exec uses __dirname internally, which Next.js's bundler rewrites and
// breaks. Use the `create` factory with an explicit cwd-based path instead.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create: createYtDlp } = require("yt-dlp-exec") as {
  create: (binPath: string) => (
    url: string,
    flags: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
};
const ytDlpBin = path.join(
  process.cwd(),
  "node_modules",
  "yt-dlp-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
);
const ytDlp = createYtDlp(ytDlpBin);

const BASE_FLAGS = { noCheckCertificates: true, noWarnings: true } as const;

function detail(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).split("\n").filter(Boolean).slice(0, 3).join(" | ");
}

/** Normalize a Rumble video URL (strip query/fragment), or null if not one. */
export function parseRumbleUrl(input: string): string | null {
  const s = input.trim();
  const bare = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (!/^rumble\.com\/(v[\w.-]+\.html|embed\/[\w.-]+)/i.test(bare) && !/^v[\w.-]+\.html$/i.test(bare)) {
    return null;
  }
  const full = /^rumble\.com\//i.test(bare) ? `https://${bare}` : `https://rumble.com/${bare}`;
  return full.split(/[?#]/)[0];
}

export type RumbleVideoMeta = {
  videoUrl: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  channel: { login: string; displayName: string; avatar: string };
  views: number;
  startTime: string;
};

type RInfo = {
  id?: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  uploader?: string;
  channel?: string;
  uploader_id?: string;
  channel_id?: string;
  view_count?: number;
  timestamp?: number;
};

/** Full single-video metadata. */
export async function getRumbleVideoInfo(url: string): Promise<RumbleVideoMeta> {
  let info: RInfo;
  try {
    info = (await ytDlp(url, { ...BASE_FLAGS, dumpSingleJson: true, skipDownload: true })) as RInfo;
  } catch (err) {
    const d = detail(err);
    if (/private|members-only|sign in|login/i.test(d)) {
      throw new Error("This Rumble video is private or requires login.");
    }
    if (/unavailable|removed|not found|404/i.test(d)) {
      throw new Error("This Rumble video is unavailable — it may have been removed.");
    }
    throw new Error(`Could not load that Rumble video: ${d}`);
  }

  return {
    videoUrl: url,
    title: info.title || "Untitled video",
    durationSec: Math.round(info.duration ?? 0),
    thumbnail: info.thumbnail || "",
    channel: {
      login: info.uploader_id || info.channel_id || "",
      displayName: info.channel || info.uploader || "Unknown",
      avatar: "",
    },
    views: info.view_count ?? 0,
    startTime: info.timestamp ? new Date(info.timestamp * 1000).toISOString() : "",
  };
}

/**
 * Resolve the direct media URLs for cutting/analysis. Rumble serves video and
 * audio as separate progressive streams, so `-g` on a merge format returns two
 * lines (video, then audio). A single line means a muxed stream — reuse it for
 * both so callers can treat the result uniformly.
 */
export async function getRumbleMediaUrls(url: string): Promise<{ videoUrl: string; audioUrl: string }> {
  let out: string;
  try {
    out = String(
      await ytDlp(url, {
        ...BASE_FLAGS,
        format: "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        getUrl: true,
      }),
    );
  } catch (err) {
    throw new Error(`Could not resolve the Rumble media stream: ${detail(err)}`);
  }
  const urls = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error("Rumble returned no playable stream for this video.");
  return urls.length >= 2 ? { videoUrl: urls[0], audioUrl: urls[1] } : { videoUrl: urls[0], audioUrl: urls[0] };
}

// Moved to ./audio-signal so Twitch/Kick's VOD scanners can reuse the same
// whole-VOD loudness pass this file pioneered.
export { scanLoudness, type LoudnessScan } from "./audio-signal";
