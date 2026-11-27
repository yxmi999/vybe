// VOD section extraction — cut a single moment straight out of a multi-hour
// stream recording without downloading the whole thing. Extracted from the
// clips/fetch route so the Auto-Pilot engine can reuse the exact same cutter.
//
// Instead of pulling the full VOD, ffmpeg seeks into the HLS playlist and only
// fetches the segments covering the requested [start, start+dur] window.
import path from "path";
import os from "os";
import { storeTempFile } from "./storage";
import { withRenderSlot } from "./render-gate";
import { KICK_UA, kickGet } from "./kick";
import { getVideoInfo as getYoutubeInfo } from "./youtube";
import { getRumbleVideoInfo, getRumbleMediaUrls } from "./rumble";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

// yt-dlp-exec rewrites __dirname under Next's bundler, so build the binary path
// from cwd and use the `create` factory (same approach as the clips/fetch route).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create: createYtDlp } = require("yt-dlp-exec") as {
  create: (binPath: string) => (url: string, flags: Record<string, unknown>) => Promise<unknown>;
};
const ytDlp = createYtDlp(
  path.join(process.cwd(), "node_modules", "yt-dlp-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
);

// YouTube serves H.264 (avc1) and AV1; the bundled ffmpeg can't decode AV1, so
// pin avc1 video + AAC audio (with generic fallbacks for the rare avc1-less video).
const YT_FORMAT =
  "bestvideo[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/" +
  "bestvideo[vcodec^=avc1][height<=720]+bestaudio/" +
  "best[vcodec^=avc1][height<=720]/best[ext=mp4][height<=720]/best[height<=720]/best";

// Read a video file's pixel dimensions from ffmpeg's stderr (no ffprobe needed).
// renderClip needs real src dims to compute the crop window; yt-dlp/progressive
// cuts don't carry a chosen rendition the way HLS variants do.
async function probeDims(file: string): Promise<{ width: number; height: number }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  try {
    await promisify(execFile)(ffmpegPath, ["-hide_banner", "-i", file], { timeout: 30_000 });
  } catch (err) {
    const m = String((err as { stderr?: string }).stderr ?? "").match(/Video:.*?[, ](\d{2,5})x(\d{2,5})/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return { width: 1280, height: 720 };
}

// The last meaningful stderr lines from a failed ffmpeg run — execFile's raw
// error message leads with the full command line, which tells the user nothing.
function ffmpegErrorDetail(err: unknown): string {
  const e = err as { stderr?: string; message?: string; killed?: boolean };
  if (e.killed) return "timed out";
  const lines = String(e.stderr ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame=|size=|\[hls|\[https)/.test(l));
  const tail = lines.slice(-2).join(" | ");
  return tail || String(e.message ?? err).split("\n")[0].slice(0, 200);
}

export function hms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export type HlsVariant = { uri: string; width: number; height: number };

/**
 * Fetch an HLS master playlist's text. A bare network blip here (DNS hiccup,
 * reset connection) throws a raw, unhelpful "fetch failed" with no retry —
 * one retry after a short pause absorbs the transient case; a real outage
 * still surfaces a clear message instead of the raw fetch error.
 */
async function fetchPlaylistText(masterUrl: string): Promise<string> {
  let masterRes: Response;
  try {
    masterRes = await fetch(masterUrl, { headers: { "User-Agent": KICK_UA }, cache: "no-store" });
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      masterRes = await fetch(masterUrl, { headers: { "User-Agent": KICK_UA }, cache: "no-store" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach the VOD playlist — network error (${detail}). Try again in a moment.`);
    }
  }
  if (!masterRes.ok) throw new Error(`Could not load the VOD playlist (${masterRes.status})`);
  return masterRes.text();
}

function parseHlsVariants(text: string, masterUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:.*RESOLUTION=(\d+)x(\d+)/);
    if (m && lines[i + 1] && !lines[i + 1].startsWith("#")) {
      variants.push({ width: Number(m[1]), height: Number(m[2]), uri: new URL(lines[i + 1], masterUrl).toString() });
    }
  }
  return variants;
}

/** Best rendition ≤720p from an HLS master playlist, to keep files small. */
export async function pickHlsVariant(masterUrl: string): Promise<HlsVariant> {
  const variants = parseHlsVariants(await fetchPlaylistText(masterUrl), masterUrl);
  const pick =
    variants.filter((v) => v.height <= 720).sort((a, b) => b.height - a.height)[0] ??
    variants.sort((a, b) => a.height - b.height)[0];
  if (!pick) throw new Error("No video renditions found in the VOD playlist");
  return pick;
}

export type AudioVariant = { uri: string; audioOnly: boolean };

/**
 * The cheapest audio source in an HLS master playlist — a dedicated
 * audio-only rendition when the playlist exposes one (far less bandwidth on
 * a multi-hour VOD than any muxed rendition), else the lowest-height muxed
 * variant. Callers must decode with `-vn` either way so video is never
 * decoded, but a true audio-only track also avoids downloading video bytes.
 */
export async function pickAudioVariant(masterUrl: string): Promise<AudioVariant> {
  const text = await fetchPlaylistText(masterUrl);
  const media = text.match(/^#EXT-X-MEDIA:TYPE=AUDIO.*URI="([^"]+)"/m);
  if (media) return { uri: new URL(media[1], masterUrl).toString(), audioOnly: true };
  const variants = parseHlsVariants(text, masterUrl).sort((a, b) => a.height - b.height);
  if (!variants[0]) throw new Error("No renditions found in the VOD playlist");
  return { uri: variants[0].uri, audioOnly: false };
}

export type FrozenInput = {
  input: string;          // what to pass to ffmpeg -i
  seek: number;           // -ss to apply to that input
  inputArgs: string[];    // extra args that must precede -i
  cleanup: () => Promise<void>;
};

/**
 * Make an HLS window fast and seekable — including on a still-recording VOD.
 *
 * A live/recording Twitch VOD's media playlist has no #EXT-X-ENDLIST, so
 * ffmpeg treats it as a live broadcast: it ignores -ss, sits at the live edge
 * waiting for new segments, and the cut times out. And on a finished
 * multi-hour VOD a remote -ss crawls. So we write a small local VOD playlist
 * holding only the segments that cover [startSec, startSec+durSec] (absolute
 * URIs, ENDLIST appended) — ffmpeg reads ~1 minute of segments and exits.
 */
export async function freezeHlsWindow(variantUri: string, startSec: number, durSec: number): Promise<FrozenInput> {
  const passthrough: FrozenInput = { input: variantUri, seek: Math.max(0, startSec), inputArgs: [], cleanup: async () => {} };
  let text: string;
  try {
    text = await fetchPlaylistText(variantUri);
  } catch {
    return passthrough; // let ffmpeg try (and report) on its own
  }
  // Not a media playlist we can parse — let ffmpeg handle it directly.
  if (!/#EXTINF/.test(text)) return passthrough;
  // Finished VODs go through the window too: a remote -ss deep into a
  // multi-hour playlist makes ffmpeg crawl (minutes, or a timeout on the
  // re-encode fallback); a ~1-minute local window cuts in seconds.

  const lines = text.split(/\r?\n/);
  const header: string[] = [];
  const segs: { start: number; dur: number; pre: string[]; uri: string }[] = [];
  let t = 0, pending: string[] = [], dur = 0, target = 10;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const td = line.match(/^#EXT-X-TARGETDURATION:(\d+)/);
    if (td) { target = Number(td[1]); continue; }
    const map = line.match(/^#EXT-X-MAP:URI="([^"]+)"(.*)$/);
    if (map) { header.push(`#EXT-X-MAP:URI="${new URL(map[1], variantUri).toString()}"${map[2]}`); continue; }
    const inf = line.match(/^#EXTINF:([\d.]+)/);
    if (inf) { dur = Number(inf[1]); pending.push(line); continue; }
    if (line === "#EXT-X-DISCONTINUITY") { pending.push(line); continue; }
    if (line.startsWith("#")) continue; // other tags don't matter for a fixed window
    segs.push({ start: t, dur, pre: pending, uri: new URL(line, variantUri).toString() });
    t += dur; pending = []; dur = 0;
  }
  const end = startSec + durSec;
  const picked = segs.filter((s) => s.start + s.dur > startSec && s.start < end);
  if (picked.length === 0) throw new Error("That part of the stream isn't available yet — try again in a few minutes.");

  const body = [
    "#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD",
    ...header,
    ...picked.flatMap((s) => [...s.pre.filter((p) => p !== "#EXT-X-DISCONTINUITY" || s !== picked[0]), s.uri]),
    "#EXT-X-ENDLIST", "",
  ].join("\n");
  const { writeFile, unlink } = await import("fs/promises");
  const local = path.join(os.tmpdir(), `vybe-hls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m3u8`);
  await writeFile(local, body, "utf8");
  return {
    input: local,
    seek: Math.max(0, startSec - picked[0].start),
    // A local playlist pointing at https segments needs these protocols allowed.
    inputArgs: ["-protocol_whitelist", "file,http,https,tcp,tls,crypto"],
    cleanup: () => unlink(local).catch(() => {}),
  };
}

/** ffmpeg-cut [startSec, startSec+durSec] out of an HLS variant into a local file. */
async function cutHlsToFile(variantUri: string, startSec: number, durSec: number, tmpPath: string): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const src = await freezeHlsWindow(variantUri, startSec, durSec);
  try {
    await cutFrozen(src, durSec, tmpPath, run);
  } finally {
    await src.cleanup();
  }
}

async function cutFrozen(
  src: FrozenInput, durSec: number, tmpPath: string,
  run: (file: string, args: string[], opts: object) => Promise<unknown>,
): Promise<void> {
  const cut = (codecArgs: string[]) =>
    run(
      ffmpegPath,
      [
        ...src.inputArgs,
        "-ss", String(src.seek),
        "-i", src.input,
        "-t", String(durSec),
        ...codecArgs,
        "-movflags", "+faststart",
        "-y", tmpPath,
      ],
      { timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
    );
  const reencode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac"];
  try {
    // Stream-copy is near-instant; cut points snap to keyframes, which is fine
    // since the highlight window is already padded.
    await cut(["-c", "copy"]);
  } catch {
    // Some VODs don't survive a remux — re-encode as fallback. Segment fetches
    // from the CDN also fail transiently, so give the re-encode a second try
    // after a pause before declaring the section uncuttable. Re-encodes are
    // CPU-heavy, so each attempt takes a render slot (the copy path above is
    // near-instant and doesn't need one).
    try {
      await withRenderSlot(() => cut(reencode));
    } catch {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        await withRenderSlot(() => cut(reencode));
      } catch (err) {
        throw new Error(`Could not cut this VOD section (ffmpeg: ${ffmpegErrorDetail(err)})`);
      }
    }
  }

  const { existsSync, statSync } = await import("fs");
  if (!existsSync(tmpPath) || statSync(tmpPath).size === 0) {
    throw new Error("ffmpeg produced no output for this VOD section");
  }
}

/** ffmpeg-cut a section out of an HLS variant, store it, return the URL. */
export async function cutHlsSection(variantUri: string, startSec: number, durSec: number, base: string): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `${base}.mp4`);
  await cutHlsToFile(variantUri, startSec, durSec, tmpPath);
  const storedUrl = await storeTempFile(tmpPath, `${base}.mp4`, "video/mp4");
  const { unlink } = await import("fs/promises");
  await unlink(tmpPath).catch(() => {});
  return storedUrl;
}

export type VodPlatform = "twitch" | "kick" | "youtube" | "rumble";

export type VodSection = {
  platform: VodPlatform;
  title: string;
  duration: number;
  thumbnailUrl: string;
  videoUrl: string;
  streamer: string;
  clipPageUrl: string;
  alreadySaved: true;
  width: number;   // picked rendition dimensions — the engine has no client to detect them
  height: number;
  // When silence-snapping is requested, the section-relative in/out points that
  // trim leading/trailing dead air. Absent → render the whole section.
  trimStart?: number;
  trimEnd?: number;
};

export type ExtractOpts = {
  // Section-relative seconds of the detected peak. When provided, the section is
  // analysed for silence and trimStart/trimEnd are snapped to clean boundaries.
  peakOffset?: number;
};

/**
 * Snap to silence while a freshly-cut section is still on local disk (one
 * extra free ffmpeg analysis pass) so the produced clip opens and closes on
 * a pause instead of dead air or a half-cut word. Shared by all four
 * platform extractors. No-op (returns {}) when no peak was given, or when
 * the section doesn't actually open/close in silence.
 */
async function snapSilenceTrim(tmpPath: string, durSec: number, opts: ExtractOpts): Promise<{ trimStart?: number; trimEnd?: number }> {
  if (opts.peakOffset == null) return {};
  const { detectSilence, snapToSilence } = await import("./silence");
  const silences = await detectSilence(tmpPath);
  const snap = snapToSilence(durSec, opts.peakOffset, silences);
  return snap.start > 0 || snap.end < durSec ? { trimStart: snap.start, trimEnd: snap.end } : {};
}

export async function extractTwitchVodSection(
  videoId: string,
  startSec: number,
  durSec: number,
  opts: ExtractOpts = {},
): Promise<VodSection> {
  const { getVodPlaylistUrl, getVodMeta } = await import("./twitch-gql");
  const [masterUrl, meta] = await Promise.all([getVodPlaylistUrl(videoId), getVodMeta(videoId)]);

  const variant = await pickHlsVariant(masterUrl);
  const base = `vybe-${Date.now()}-vod-tw${videoId}`;
  const tmpPath = path.join(os.tmpdir(), `${base}.mp4`);
  await cutHlsToFile(variant.uri, startSec, durSec, tmpPath);

  const { trimStart, trimEnd } = await snapSilenceTrim(tmpPath, durSec, opts);

  const storedUrl = await storeTempFile(tmpPath, `${base}.mp4`, "video/mp4");
  const { unlink } = await import("fs/promises");
  await unlink(tmpPath).catch(() => {});

  return {
    platform: "twitch",
    title: `${meta?.title ?? "Stream highlight"} — ${hms(startSec)}`,
    duration: durSec,
    thumbnailUrl: meta?.previewThumbnailURL ?? "",
    videoUrl: storedUrl,
    streamer: meta?.owner?.displayName ?? meta?.owner?.login ?? "Unknown",
    clipPageUrl: `https://www.twitch.tv/videos/${videoId}`,
    alreadySaved: true,
    width: variant.width,
    height: variant.height,
    trimStart,
    trimEnd,
  };
}

// ─── Kick ─────────────────────────────────────────────────────────────────────

type KickVodInfo = {
  source?: string;
  livestream?: {
    session_title?: string;
    channel?: { slug?: string; user?: { username?: string } };
    thumbnail?: string | { src?: string } | null;
  };
};

async function fetchKickVod(uuid: string): Promise<KickVodInfo> {
  const vidRes = await kickGet(`v1/video/${encodeURIComponent(uuid)}`);
  if (vidRes.status === 404) throw new Error("VOD not found on Kick — it may have been deleted.");
  if (!vidRes.ok) throw new Error(`Kick returned ${vidRes.status} for the VOD lookup`);
  const vod = vidRes.data as KickVodInfo;
  if (!vod.source) throw new Error("This VOD has no playable source (it may be pruned or subscriber-only).");
  return vod;
}

/** Kick VOD's HLS master URL — for callers (e.g. the audio-energy scanner) that don't need the rest of the VOD metadata. */
export async function getKickVodSource(uuid: string): Promise<string> {
  return (await fetchKickVod(uuid)).source!;
}

export async function extractKickVodSection(uuid: string, startSec: number, durSec: number, opts: ExtractOpts = {}): Promise<VodSection> {
  const vod = await fetchKickVod(uuid);
  const variant = await pickHlsVariant(vod.source!);
  const base = `vybe-${Date.now()}-vod-${uuid.slice(0, 8)}`;
  const tmpPath = path.join(os.tmpdir(), `${base}.mp4`);
  await cutHlsToFile(variant.uri, startSec, durSec, tmpPath);

  const { trimStart, trimEnd } = await snapSilenceTrim(tmpPath, durSec, opts);

  const storedUrl = await storeTempFile(tmpPath, `${base}.mp4`, "video/mp4");
  const { unlink } = await import("fs/promises");
  await unlink(tmpPath).catch(() => {});

  const ls = vod.livestream;
  const thumb = typeof ls?.thumbnail === "string" ? ls.thumbnail : ls?.thumbnail?.src ?? "";
  return {
    platform: "kick",
    title: `${ls?.session_title ?? "Stream highlight"} — ${hms(startSec)}`,
    duration: durSec,
    thumbnailUrl: thumb,
    videoUrl: storedUrl,
    streamer: ls?.channel?.user?.username ?? ls?.channel?.slug ?? "Unknown",
    clipPageUrl: `https://kick.com/video/${uuid}`,
    alreadySaved: true,
    width: variant.width,
    height: variant.height,
    trimStart,
    trimEnd,
  };
}

// ─── YouTube ──────────────────────────────────────────────────────────────────
// yt-dlp's --download-sections seeks into the stream and pulls only the window,
// so we never download a multi-hour video to clip 60s out of it.

export async function extractYoutubeVodSection(videoId: string, startSec: number, durSec: number, opts: ExtractOpts = {}): Promise<VodSection> {
  const meta = await getYoutubeInfo(videoId);
  const base = `vybe-${Date.now()}-yt-${videoId}`;
  const tmpPath = path.join(os.tmpdir(), `${base}.mp4`);

  // Each yt-dlp invocation re-extracts fresh, short-lived signed URLs pointing
  // at a specific Google CDN edge (a "rrN---sn-....googlevideo.com" hostname).
  // That edge occasionally fails to resolve/connect (a transient DNS or
  // routing blip, not the video itself) — a bare retry re-extracts and
  // typically lands on a different, working edge, so give it one before
  // surfacing an error.
  const download = () => ytDlp(`https://www.youtube.com/watch?v=${videoId}`, {
    output: tmpPath,
    format: YT_FORMAT,
    downloadSections: `*${Math.max(0, startSec)}-${Math.max(0, startSec) + durSec}`,
    mergeOutputFormat: "mp4",
    ffmpegLocation: ffmpegPath,
    noCheckCertificates: true,
    noWarnings: true,
  });
  try {
    await download();
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await download();
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const d = (e.stderr || e.message || String(err)).split("\n").filter(Boolean).slice(0, 3).join(" | ");
      throw new Error(`Could not cut this YouTube section: ${d}`);
    }
  }

  const { existsSync, readdirSync, statSync } = await import("fs");
  let usedPath = tmpPath;
  if (!existsSync(tmpPath)) {
    const dir = path.dirname(tmpPath);
    const match = readdirSync(dir).find((f) => f.startsWith(base));
    if (!match) throw new Error("yt-dlp produced no output for this YouTube section");
    usedPath = path.join(dir, match);
  }
  if (statSync(usedPath).size === 0) throw new Error("yt-dlp produced an empty file for this YouTube section");

  const [dims, { trimStart, trimEnd }] = await Promise.all([
    probeDims(usedPath),
    snapSilenceTrim(usedPath, durSec, opts),
  ]);
  const storedUrl = await storeTempFile(usedPath, `${base}.mp4`, "video/mp4");
  const { unlink } = await import("fs/promises");
  await unlink(usedPath).catch(() => {});

  return {
    platform: "youtube",
    title: `${meta.title} — ${hms(startSec)}`,
    duration: durSec,
    thumbnailUrl: meta.thumbnail,
    videoUrl: storedUrl,
    streamer: meta.channel.displayName,
    clipPageUrl: `https://www.youtube.com/watch?v=${videoId}`,
    alreadySaved: true,
    width: dims.width,
    height: dims.height,
    trimStart,
    trimEnd,
  };
}

// ─── Rumble ───────────────────────────────────────────────────────────────────
// Rumble serves video and audio as separate progressive streams; seek into each
// over HTTP (range requests fetch only the window) and merge. Copy first, then
// re-encode only if the copy won't remux cleanly.

export async function extractRumbleVodSection(url: string, startSec: number, durSec: number, opts: ExtractOpts = {}): Promise<VodSection> {
  const [meta, media] = await Promise.all([getRumbleVideoInfo(url), getRumbleMediaUrls(url)]);
  const base = `vybe-${Date.now()}-rumble`;
  const tmpPath = path.join(os.tmpdir(), `${base}.mp4`);
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);

  const ss = String(Math.max(0, startSec));
  const separate = media.audioUrl !== media.videoUrl;
  const inputs = separate
    ? ["-ss", ss, "-i", media.videoUrl, "-ss", ss, "-i", media.audioUrl, "-t", String(durSec), "-map", "0:v:0", "-map", "1:a:0"]
    : ["-ss", ss, "-i", media.videoUrl, "-t", String(durSec)];

  const cut = (codecArgs: string[]) =>
    run(ffmpegPath, ["-hide_banner", ...inputs, ...codecArgs, "-movflags", "+faststart", "-y", tmpPath], {
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  try {
    await cut(["-c", "copy"]);
  } catch {
    try {
      // Re-encode fallback is CPU-heavy — take a render slot for it.
      await withRenderSlot(() => cut(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac"]));
    } catch (err) {
      throw new Error(`Could not cut this Rumble section (ffmpeg: ${ffmpegErrorDetail(err)})`);
    }
  }

  const { existsSync, statSync } = await import("fs");
  if (!existsSync(tmpPath) || statSync(tmpPath).size === 0) {
    throw new Error("ffmpeg produced no output for this Rumble section");
  }

  const [dims, { trimStart, trimEnd }] = await Promise.all([
    probeDims(tmpPath),
    snapSilenceTrim(tmpPath, durSec, opts),
  ]);
  const storedUrl = await storeTempFile(tmpPath, `${base}.mp4`, "video/mp4");
  const { unlink } = await import("fs/promises");
  await unlink(tmpPath).catch(() => {});

  return {
    platform: "rumble",
    title: `${meta.title} — ${hms(startSec)}`,
    duration: durSec,
    thumbnailUrl: meta.thumbnail,
    videoUrl: storedUrl,
    streamer: meta.channel.displayName,
    clipPageUrl: url,
    alreadySaved: true,
    width: dims.width,
    height: dims.height,
    trimStart,
    trimEnd,
  };
}

// ─── Unified dispatcher ─────────────────────────────────────────────────────--
// One entry the batch clipper and the fetch route share. `ref` is the platform's
// VOD identifier: Twitch/YouTube video id, Kick uuid, or a full Rumble URL.
export async function extractVodSection(
  platform: VodPlatform,
  ref: string,
  startSec: number,
  durSec: number,
  opts: ExtractOpts = {},
): Promise<VodSection> {
  switch (platform) {
    case "twitch":  return extractTwitchVodSection(ref, startSec, durSec, opts);
    case "kick":    return extractKickVodSection(ref, startSec, durSec, opts);
    case "youtube": return extractYoutubeVodSection(ref, startSec, durSec, opts);
    case "rumble":  return extractRumbleVodSection(ref, startSec, durSec, opts);
  }
}
