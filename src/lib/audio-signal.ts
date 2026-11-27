// Cheap, whole-VOD audio-energy signal — a single ffmpeg pass that measures
// loudness across the entire timeline without decoding video. Originally
// built for Rumble (which has no chat), generalized here so Twitch/Kick's
// chat-spike detection can be corroborated (or, on a dead-chat VOD, replaced)
// by an independent signal: real crowd/streamer reactions are audibly loud
// even when chat doesn't spike proportionally.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

// startSec: source time of levels[0] (0 for a whole-file scan).
export type LoudnessScan = { levels: number[]; windowSec: number; startSec?: number };

/**
 * Decode the audio (downmixed to mono 8 kHz — plenty for a loudness envelope,
 * and far faster than full quality) and read per-frame RMS via ffmpeg's astats,
 * then keep the loudest level in each fixed window. On a process timeout we
 * still parse the portion ffmpeg printed, so a very long video degrades to
 * start-only coverage instead of failing.
 */
export async function scanLoudness(
  audioUrl: string,
  durationSec: number,
  windowSec = 3,
  timeoutMs = 260_000,
  startSec = 0,         // scan only [startSec, startSec + durationSec] (live windows)
  inputArgs: string[] = [],   // args that must precede -i (e.g. a protocol whitelist)
  seekOverride?: number,      // -ss into a frozen window playlist (source time stays startSec)
): Promise<LoudnessScan | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);

  let stdout = "";
  try {
    const r = await run(
      ffmpegPath,
      [
        "-hide_banner", "-nostats",
        // Input-seek + duration limit so a live pass decodes only its window.
        ...inputArgs,
        ...((seekOverride ?? startSec) > 0 ? ["-ss", String(seekOverride ?? startSec)] : []),
        "-i", audioUrl,
        ...(startSec > 0 ? ["-t", String(durationSec)] : []),
        "-vn", "-ac", "1", "-ar", "8000",
        "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
        "-f", "null", "-",
      ],
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (err) {
    // Timeout (or non-zero exit) — keep whatever was printed before the stop.
    stdout = (err as { stdout?: string }).stdout ?? "";
    if (!stdout) return null;
  }

  const nWindows = durationSec > 0 ? Math.ceil(durationSec / windowSec) : 0;
  const levels: number[] = nWindows ? new Array<number>(nWindows).fill(-Infinity) : [];
  let curT: number | null = null;
  let maxW = -1;

  for (const line of stdout.split("\n")) {
    const tm = line.match(/pts_time:([\d.]+)/);
    if (tm) { curT = parseFloat(tm[1]); continue; }
    const rm = line.match(/RMS_level=(-?[\d.]+)/);
    if (rm && curT != null) {
      const v = parseFloat(rm[1]);
      if (!Number.isFinite(v)) continue;       // silence prints "-inf"
      const w = Math.floor(curT / windowSec);
      if (w < 0 || (nWindows && w >= nWindows)) continue;
      while (levels.length <= w) levels.push(-Infinity);
      if (v > levels[w]) levels[w] = v;
      if (w > maxW) maxW = w;
    }
  }

  if (maxW < 0) return null;

  // Fill silent windows with the quietest observed level so the series is
  // continuous for smoothing/peak-picking.
  const trimmed = (nWindows ? levels : levels.slice(0, maxW + 1));
  const finite = trimmed.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const floorDb = Math.min(...finite);
  return { levels: trimmed.map((v) => (Number.isFinite(v) ? v : floorDb)), windowSec, startSec };
}

const AUDIO_WINDOW_SEC = 5;
const AUDIO_SCAN_TIMEOUT_MS = 180_000;

/**
 * Resolve the cheapest audio source for a Twitch/Kick VOD and scan its
 * loudness across the whole timeline. Best-effort: any failure (playlist
 * fetch, ffmpeg timeout with nothing usable, flat/no-dynamic-range audio)
 * resolves to null so callers degrade to chat-only scoring exactly like they
 * did before this signal existed.
 */
export async function scanVodAudioEnergy(
  platform: "twitch" | "kick",
  ref: string,
  durationSec: number,
  opts: { windowSec?: number; timeoutMs?: number; startSec?: number } = {},
): Promise<LoudnessScan | null> {
  try {
    const { pickAudioVariant, getKickVodSource } = await import("./vod-extract");
    let masterUrl: string;
    if (platform === "twitch") {
      const { getVodPlaylistUrl } = await import("./twitch-gql");
      masterUrl = await getVodPlaylistUrl(ref);
    } else {
      masterUrl = await getKickVodSource(ref);
    }
    const variant = await pickAudioVariant(masterUrl);
    // A windowed scan of a still-recording VOD needs a frozen playlist (see
    // vod-extract freezeHlsWindow) or ffmpeg waits at the live edge.
    const { freezeHlsWindow } = await import("./vod-extract");
    const frozen = opts.startSec != null
      ? await freezeHlsWindow(variant.uri, opts.startSec, durationSec)
      : null;
    const scan = await scanLoudness(
      frozen?.input ?? variant.uri,
      durationSec,
      opts.windowSec ?? AUDIO_WINDOW_SEC,
      opts.timeoutMs ?? AUDIO_SCAN_TIMEOUT_MS,
      opts.startSec ?? 0,
      frozen?.inputArgs ?? [],
      frozen ? frozen.seek : undefined,
    ).finally(() => frozen?.cleanup());
    if (!scan || scan.levels.length < 3) return null;
    const min = Math.min(...scan.levels);
    const max = Math.max(...scan.levels);
    if (max - min < 1) return null; // flat audio — no standout moments to detect
    return scan;
  } catch {
    return null;
  }
}
