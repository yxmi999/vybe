import path from "path";
import os from "os";
import { readFile, unlink } from "fs/promises";
import { resolveToTempFile } from "./storage";
import { detectSilence, type SilenceSpan } from "./silence";
import { scanLoudness } from "./audio-signal";

// Cheap, deterministic measurements over a local clip — what the AI editor's
// "perception" tools and the style analyzer use instead of letting a model
// guess. Every function is best-effort: a failure returns an empty result so
// the caller degrades instead of crashing.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

async function ff(args: string[], timeout = 90_000): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  try {
    return await run(ffmpegPath, ["-hide_banner", "-nostats", ...args], { timeout, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // ffmpeg exits non-zero for `-f null` probes on some inputs; keep what it printed.
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const tmp = (ext: string) => path.join(os.tmpdir(), `vybe-probe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);

/** Only stored paths and http(s) URLs — never blob:, file:, or traversal. */
export function isServerFetchable(u: unknown): u is string {
  if (typeof u !== "string" || !u) return false;
  if (u.startsWith("/")) return !u.includes("..");
  return /^https?:\/\//i.test(u);
}

/** Download/copy a media URL to a temp file once; `cleanup()` deletes it. */
export function lazyLocalMedia(url: string | undefined) {
  let pending: Promise<string | null> | null = null;
  let file: string | null = null;
  return {
    available: isServerFetchable(url),
    get(): Promise<string | null> {
      if (!isServerFetchable(url)) return Promise.resolve(null);
      pending ??= (async () => {
        const p = tmp("mp4");
        try { await resolveToTempFile(url, p); file = p; return p; }
        catch { await unlink(p).catch(() => {}); return null; }
      })();
      return pending;
    },
    async cleanup() { if (file) await unlink(file).catch(() => {}); },
  };
}

export async function probeDuration(file: string): Promise<number> {
  const { stderr } = await ff(["-i", file], 20_000);
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** Hard cuts (scene changes) in [start, start+dur], as source seconds. */
export async function sceneCuts(file: string, start = 0, dur = 600, threshold = 0.32): Promise<number[]> {
  const { stderr } = await ff([
    ...(start > 0 ? ["-ss", start.toFixed(2)] : []), "-t", String(dur), "-i", file,
    "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-",
  ]);
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number((start + Number(m[1])).toFixed(2)));
}

/** Silent spans (source seconds). */
export async function silences(file: string, minSec = 0.45, noiseDb = -32): Promise<SilenceSpan[]> {
  return (await detectSilence(file, noiseDb, minSec)).map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2) }));
}

export type LoudPeak = { time: number; db: number; aboveMedianDb: number };

/** The N loudest moments, at least `minGapSec` apart (source seconds). */
export async function loudPeaks(file: string, duration: number, count = 6, minGapSec = 3, windowSec = 0.5): Promise<LoudPeak[]> {
  if (!(duration > 0)) return [];
  const scan = await scanLoudness(file, duration, windowSec, 90_000);
  if (!scan || scan.levels.length === 0) return [];
  const lv = scan.levels;
  const median = [...lv].sort((a, b) => a - b)[Math.floor(lv.length / 2)];
  const order = lv.map((db, i) => ({ db, i })).sort((a, b) => b.db - a.db);
  const picked: LoudPeak[] = [];
  for (const { db, i } of order) {
    const time = +(i * windowSec + windowSec / 2).toFixed(2);
    if (picked.some((p) => Math.abs(p.time - time) < minGapSec)) continue;
    picked.push({ time, db: +db.toFixed(1), aboveMedianDb: +(db - median).toFixed(1) });
    if (picked.length >= count) break;
  }
  return picked.sort((a, b) => a.time - b.time);
}

/** JPEG stills at exact source times (max width 512). */
export async function framesAt(file: string, times: number[], width = 512): Promise<{ time: number; jpeg: Buffer }[]> {
  const out: { time: number; jpeg: Buffer }[] = [];
  for (const t of times) {
    const p = tmp("jpg");
    await ff(["-ss", Math.max(0, t).toFixed(2), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "5", "-y", p], 30_000);
    try { out.push({ time: t, jpeg: await readFile(p) }); } catch { /* frame past the end */ }
    await unlink(p).catch(() => {});
  }
  return out;
}

export type GradeStats = { brightness: number; saturation: number; contrast: number };

/**
 * Average luma / saturation / luma spread over the clip via signalstats —
 * ground truth for "what grade does this video have" (0-255 scale for
 * brightness and contrast spread, 0-~180 for saturation).
 */
export async function gradeStats(file: string, start = 0, dur = 60): Promise<GradeStats | null> {
  const { stdout } = await ff([
    ...(start > 0 ? ["-ss", start.toFixed(2)] : []), "-t", String(dur), "-i", file,
    "-vf", "fps=2,scale=320:-2,signalstats,metadata=print:file=-", "-an", "-f", "null", "-",
  ]);
  const grab = (key: string) => [...stdout.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const yavg = grab("YAVG"), sat = grab("SATAVG"), ylow = grab("YLOW"), yhigh = grab("YHIGH");
  if (yavg.length === 0) return null;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return {
    brightness: +mean(yavg).toFixed(1),
    saturation: +mean(sat).toFixed(1),
    contrast: +(mean(yhigh) - mean(ylow)).toFixed(1),
  };
}
