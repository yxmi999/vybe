// YouTube auto-clipper support, built on yt-dlp (no API key needed).
//
// Two jobs: list a channel's recent videos (cheap flat-playlist extraction),
// and pull a single video's full metadata — which includes YouTube's
// "most replayed" heatmap. That heatmap is the YouTube equivalent of the chat
// spikes we use on Kick/Twitch: it marks the parts viewers rewound to most.

import path from "path";
import os from "os";
import { isHype, matchesKeywords, cleanMessage } from "./chat-highlights";

// yt-dlp-exec uses __dirname internally, which Next.js's bundler rewrites and
// breaks. Use the `create` factory with an explicit cwd-based path instead —
// the same pattern as the clips/fetch route.
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

const BASE_FLAGS = {
  noCheckCertificates: true,
  noWarnings: true,
} as const;

/** Pull the 11-char video id out of any YouTube URL form, or null. */
export function parseYoutubeVideoId(input: string): string | null {
  const s = input.trim();
  // Bare id pasted on its own.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|shorts\/|embed\/|v\/))([A-Za-z0-9_-]{11})/,
  );
  return m?.[1] ?? null;
}

/**
 * Turn a channel handle or URL into the URL of its videos tab, so a flat
 * extraction lists that channel's uploads. Accepts "@mkbhd", "mkbhd",
 * "youtube.com/@mkbhd", "youtube.com/channel/UC…", "/c/…", "/user/…".
 * Returns null if the input doesn't look like a channel reference.
 */
export function channelVideosUrl(input: string): string | null {
  let s = input.trim().replace(/\/+$/, "");

  // Already a channel URL — normalize and ensure it points at a video tab.
  const urlMatch = s.match(/youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/i);
  if (urlMatch) {
    const tabbed = /\/(videos|streams)$/i.test(s) ? s : `https://www.youtube.com/${urlMatch[1]}/videos`;
    return tabbed.startsWith("http") ? tabbed : `https://www.${tabbed.replace(/^https?:\/\//, "")}`;
  }

  // Bare handle, with or without the leading @.
  s = s.replace(/^@/, "");
  if (/^[\w.-]+$/.test(s)) return `https://www.youtube.com/@${s}/videos`;
  return null;
}

export type YoutubeVideo = {
  uuid: string;        // the 11-char video id (named uuid to match the VOD type)
  title: string;
  startTime: string;   // ISO upload date, or "" when flat extraction omits it
  durationSec: number;
  views: number;
  thumbnail: string;
};

export type YoutubeChannelInfo = {
  login: string;
  displayName: string;
  avatar: string;
};

type FlatEntry = {
  id?: string;
  title?: string;
  duration?: number;
  view_count?: number;
  timestamp?: number;     // epoch seconds, when present
  thumbnails?: { url?: string }[];
};

type FlatPlaylist = {
  id?: string;
  channel?: string;
  uploader?: string;
  uploader_id?: string;
  channel_id?: string;
  thumbnails?: { url?: string }[];
  entries?: (FlatEntry | null)[];
};

function detail(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).split("\n").filter(Boolean).slice(0, 3).join(" | ");
}

/** Flat-list up to `max` of a channel's most recent videos. */
export async function listChannelVideos(
  channelUrl: string,
  max: number,
): Promise<{ channel: YoutubeChannelInfo; videos: YoutubeVideo[] } | null> {
  let pl: FlatPlaylist;
  try {
    pl = (await ytDlp(channelUrl, {
      ...BASE_FLAGS,
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistEnd: max,
    })) as FlatPlaylist;
  } catch (err) {
    const d = detail(err);
    if (/does not exist|not found|404|unable to (recognize|download)/i.test(d)) return null;
    throw new Error(`Could not load that YouTube channel: ${d}`);
  }

  const entries = (pl.entries ?? []).filter((e): e is FlatEntry => !!e && !!e.id);
  const videos: YoutubeVideo[] = entries
    .filter((e) => (e.duration ?? 0) > 0)
    .map((e) => ({
      uuid: e.id!,
      title: e.title || "Untitled video",
      startTime: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : "",
      durationSec: Math.round(e.duration ?? 0),
      views: e.view_count ?? 0,
      thumbnail: e.thumbnails?.[e.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    }));

  return {
    channel: {
      login: pl.uploader_id || pl.channel_id || "",
      displayName: pl.channel || pl.uploader || channelUrl,
      avatar: pl.thumbnails?.[pl.thumbnails.length - 1]?.url || "",
    },
    videos,
  };
}

export type HeatmapPoint = { start_time: number; end_time: number; value: number };

type VideoInfo = {
  id?: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  channel?: string;
  uploader?: string;
  channel_id?: string;
  uploader_id?: string;
  view_count?: number;
  timestamp?: number;
  heatmap?: HeatmapPoint[] | null;
};

export type YoutubeVideoMeta = {
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  channel: YoutubeChannelInfo;
  views: number;
  startTime: string;
  heatmap: HeatmapPoint[];
};

/** Full single-video metadata, including the "most replayed" heatmap (may be empty). */
export async function getVideoInfo(videoId: string): Promise<YoutubeVideoMeta> {
  let info: VideoInfo;
  try {
    info = (await ytDlp(`https://www.youtube.com/watch?v=${videoId}`, {
      ...BASE_FLAGS,
      dumpSingleJson: true,
      skipDownload: true,
    })) as VideoInfo;
  } catch (err) {
    const d = detail(err);
    if (/private|members-only|sign in|login required/i.test(d)) {
      throw new Error("This video is private or members-only — only public videos can be scanned.");
    }
    if (/unavailable|removed|does not exist/i.test(d)) {
      throw new Error("This video is unavailable — it may have been removed.");
    }
    throw new Error(`Could not load that video: ${d}`);
  }

  return {
    videoId: info.id || videoId,
    title: info.title || "Untitled video",
    durationSec: Math.round(info.duration ?? 0),
    thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    channel: {
      login: info.uploader_id || info.channel_id || "",
      displayName: info.channel || info.uploader || "Unknown",
      avatar: "",
    },
    views: info.view_count ?? 0,
    startTime: info.timestamp ? new Date(info.timestamp * 1000).toISOString() : "",
    heatmap: Array.isArray(info.heatmap) ? info.heatmap : [],
  };
}

// ─── Live chat replay fallback ────────────────────────────────────────────────
// A stream that ended hours ago has no "most replayed" graph yet (YouTube takes
// a day or more to publish one). But its VOD keeps the live chat replay, which
// yt-dlp downloads as a JSON-lines file. Chat-rate spikes there mark the same
// moments a human clipper would — exactly how the Kick/Twitch scanners work.

export type ChatBuckets = {
  counts: number[];
  hype: number[];
  keyword: number[];   // messages mentioning a requested keyword, per window
  samples: string[][];
  windowSec: number;
  complete: boolean;   // false when the download was cut short (only the start was scanned)
};

// Minimal shape of a replay chat line; everything else in the JSON is ignored.
type ChatRun = { text?: string; emoji?: { shortcuts?: string[] } };
type ChatRenderer = { message?: { runs?: ChatRun[] } };
type ChatItem = { liveChatTextMessageRenderer?: ChatRenderer; liveChatPaidMessageRenderer?: ChatRenderer };
type ChatAction = { addChatItemAction?: { item?: ChatItem } };
type ReplayLine = { replayChatItemAction?: { videoOffsetTimeMsec?: string; actions?: ChatAction[] } };

function runText(runs: ChatRun[] | undefined): string {
  return (runs ?? []).map((r) => r.text ?? r.emoji?.shortcuts?.[0] ?? "").join("");
}

/**
 * Download the VOD's live chat replay and bucket it into fixed windows across
 * the timeline. Returns null when the video has no chat replay (not a stream,
 * chat disabled, or download produced nothing). On a timeout we still parse
 * whatever yt-dlp managed to write, so a slow giant chat degrades gracefully
 * instead of failing outright.
 */
export async function scanLiveChat(
  videoId: string,
  durationSec: number,
  windowSec = 10,
  keywords: string[] = [],
): Promise<ChatBuckets | null> {
  const base = `vybe-${Date.now()}-ytchat-${videoId}`;
  const outTpl = path.join(os.tmpdir(), base);

  try {
    await ytDlp(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        ...BASE_FLAGS,
        skipDownload: true,
        writeSubs: true,
        subLangs: "live_chat",
        output: `${outTpl}.%(ext)s`,
      },
      // execa option: cap the download so a giant chat can't run forever — we
      // still parse whatever was written to disk before the kill. Kept under
      // the route's 300s budget with room for metadata + parsing.
      { timeout: 230_000 },
    );
  } catch {
    // Timeout or "no subtitles" — fall through and parse any partial file.
  }

  // yt-dlp renames to .live_chat.json only on completion; a timeout leaves the
  // accumulated data in a .live_chat.json.part file (still valid JSON-lines).
  const { existsSync, readdirSync, createReadStream } = await import("fs");
  const { unlink } = await import("fs/promises");
  const dir = path.dirname(outTpl);
  const leftovers = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(base)) : [];
  const cleanup = () => Promise.all(leftovers.map((f) => unlink(path.join(dir, f)).catch(() => {})));

  const completeFile = leftovers.find((f) => f.endsWith(".live_chat.json"));
  const found = completeFile ?? leftovers.find((f) => f.endsWith(".live_chat.json.part"));
  if (!found) {
    await cleanup();
    return null;
  }
  const complete = !!completeFile;
  const filePath = path.join(dir, found);

  // Bucket by window index in a sparse map first — the chat offsets are the
  // source of truth, so this works even when the reported duration is 0 (a VOD
  // that's still processing). durationSec only caps the timeline as a safety net.
  type Bucket = { count: number; hype: number; keyword: number; samples: string[] };
  const buckets = new Map<number, Bucket>();
  let maxW = 0;
  const capW = durationSec > 0 ? Math.ceil(durationSec / windowSec) + 2 : Infinity;

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let obj: ReplayLine;
    try { obj = JSON.parse(line) as ReplayLine; } catch { continue; }
    const rca = obj.replayChatItemAction;
    if (!rca) continue;
    const offMs = Number(rca.videoOffsetTimeMsec);
    if (!Number.isFinite(offMs) || offMs < 0) continue;
    const w = Math.floor(offMs / 1000 / windowSec);
    if (w > capW) continue;
    for (const action of rca.actions ?? []) {
      const item = action.addChatItemAction?.item;
      const r = item?.liveChatTextMessageRenderer ?? item?.liveChatPaidMessageRenderer;
      if (!r) continue;
      let b = buckets.get(w);
      if (!b) { b = { count: 0, hype: 0, keyword: 0, samples: [] }; buckets.set(w, b); }
      const text = runText(r.message?.runs);
      b.count++;
      if (isHype(text)) b.hype++;
      if (matchesKeywords(text, keywords)) b.keyword++;
      if (b.samples.length < 3) {
        const c = cleanMessage(text);
        if (c) b.samples.push(c);
      }
      if (w > maxW) maxW = w;
    }
  }

  await cleanup();

  if (buckets.size === 0) return null;

  // Materialize dense arrays from 0..maxW so empty windows register as gaps,
  // which keeps the peak detection and smoothing honest.
  const n = maxW + 1;
  const counts = new Array<number>(n).fill(0);
  const hype = new Array<number>(n).fill(0);
  const keyword = new Array<number>(n).fill(0);
  const samples: string[][] = Array.from({ length: n }, () => []);
  for (const [w, b] of buckets) {
    counts[w] = b.count;
    hype[w] = b.hype;
    keyword[w] = b.keyword;
    samples[w] = b.samples;
  }

  return { counts, hype, keyword, samples, windowSec, complete };
}
