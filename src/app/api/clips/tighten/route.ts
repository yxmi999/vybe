import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { recordAsset } from "@/lib/plan";
import { unlink } from "fs/promises";
import path from "path";
import os from "os";
import { resolveToTempFile, storeTempFile } from "@/lib/storage";
import { withRenderSlot } from "@/lib/render-gate";

// Auto-tighten: remove dead air (silence) and optional filler-word ranges from a
// clip, then re-render the kept ranges concatenated into one mp4. This is a
// PRE-PASS — interior cuts shift the timeline, so the editor adopts the result as
// a fresh source and re-does time-based edits (subtitles, keyframes) on top.
//
// Silences come from ffmpeg's `silencedetect`; filler ranges (um/uh/…) are passed
// in by the client from the existing transcript word timings when available.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

type Range = { start: number; end: number };

// Merge overlapping/adjacent ranges (sorted by start).
function mergeRanges(ranges: Range[], joinGap = 0.05): Range[] {
  const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + joinGap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// Complement of `removable` within [lo, hi] → the ranges to KEEP.
function keptRanges(lo: number, hi: number, removable: Range[], minKeep = 0.12): Range[] {
  const kept: Range[] = [];
  let cursor = lo;
  for (const r of removable) {
    const s = Math.max(lo, r.start), e = Math.min(hi, r.end);
    if (e <= cursor) continue;
    if (s - cursor >= minKeep) kept.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  if (hi - cursor >= minKeep) kept.push({ start: cursor, end: hi });
  return kept;
}

// Both passes (silencedetect scan, kept-range concat re-encode) decode or
// encode the whole clip, so each takes a render slot.
async function run(args: string[], opts: { capture?: boolean } = {}): Promise<string> {
  const { execFile } = await import("child_process");
  return withRenderSlot(() => new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1 << 26, timeout: 300_000 }, (err, _stdout, stderr) => {
      // ffmpeg writes everything to stderr; silencedetect output lives there too.
      if (err && !opts.capture) reject(new Error(stderr?.slice(-500) || err.message));
      else resolve(stderr || "");
    });
  }));
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const videoUrl = String(body.videoUrl ?? "");
  if (!videoUrl) return NextResponse.json({ error: "videoUrl is required" }, { status: 400 });

  const trimStart = Math.max(0, Number(body.trimStart) || 0);
  const trimEnd = Number(body.trimEnd) > trimStart ? Number(body.trimEnd) : trimStart;
  const fillers: Range[] = Array.isArray(body.fillerWords)
    ? body.fillerWords
        .filter((r: { start?: unknown; end?: unknown }) => typeof r.start === "number" && typeof r.end === "number")
        .map((r: { start: number; end: number }) => ({ start: r.start, end: r.end }))
    : [];
  // Aggressiveness: how quiet (dB) and how long (s) before it counts as silence.
  const noiseDb = Math.min(-20, Math.max(-50, Number(body.noiseDb) || -30));
  const minSilence = Math.min(2, Math.max(0.2, Number(body.minSilence) || 0.45));
  // Leave a little breath around each cut so word onsets aren't clipped.
  const pad = 0.12;

  const id = Date.now();
  const inputPath = path.join(os.tmpdir(), `vybe-tighten-in-${id}.mp4`);
  const outPath = path.join(os.tmpdir(), `vybe-tighten-out-${id}.mp4`);

  try {
    await resolveToTempFile(videoUrl, inputPath);
    const span = trimEnd > trimStart ? trimEnd - trimStart : 0;
    if (span <= 0.5) return NextResponse.json({ error: "Clip is too short to tighten." }, { status: 400 });

    // ── Detect silences (stderr) ──
    const log = await run(
      ["-hide_banner", "-ss", trimStart.toFixed(3), "-t", span.toFixed(3), "-i", inputPath,
        "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence.toFixed(3)}`, "-f", "null", "-"],
      { capture: true },
    );

    // silencedetect emits times RELATIVE to the -ss cut (i.e. 0..span). Shift to
    // absolute source time. Pair starts with ends; an unmatched final start runs
    // to the end of the window.
    const silences: Range[] = [];
    let openStart: number | null = null;
    for (const m of log.matchAll(/silence_(start|end):\s*(-?[0-9.]+)/g)) {
      const kind = m[1], t = trimStart + parseFloat(m[2]);
      if (kind === "start") openStart = t;
      else if (openStart != null) { silences.push({ start: openStart, end: t }); openStart = null; }
    }
    if (openStart != null) silences.push({ start: openStart, end: trimEnd });

    // Shrink each silence by `pad` on both sides (keeps a breath), drop ones too
    // short to bother with after padding.
    const removable = mergeRanges(
      [
        ...silences
          .map((s) => ({ start: s.start + pad, end: s.end - pad }))
          .filter((s) => s.end - s.start >= 0.18),
        // Filler words: pad outward a touch so the whole utterance goes.
        ...fillers.map((f) => ({ start: f.start - 0.04, end: f.end + 0.04 })),
      ].map((r) => ({ start: Math.max(trimStart, r.start), end: Math.min(trimEnd, r.end) })),
    );

    const kept = keptRanges(trimStart, trimEnd, removable);
    const keptDur = kept.reduce((a, r) => a + (r.end - r.start), 0);
    const removed = Math.max(0, span - keptDur);

    // Not worth a full re-render for a sliver, or nothing detected.
    if (kept.length === 0 || removed < 0.3) {
      return NextResponse.json({ removed: 0, segments: kept.length, duration: span });
    }
    // Guard against an unwieldy graph on very choppy audio.
    if (kept.length > 80) {
      return NextResponse.json({ error: "Too many cuts to tighten cleanly — try a less aggressive setting." }, { status: 400 });
    }

    // ── Concat the kept ranges (video + audio) into one clip ──
    const parts: string[] = [];
    const labels: string[] = [];
    kept.forEach((r, i) => {
      parts.push(`[0:v]trim=${r.start.toFixed(3)}:${r.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      parts.push(`[0:a]atrim=${r.start.toFixed(3)}:${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    });
    parts.push(`${labels.join("")}concat=n=${kept.length}:v=1:a=1[v][a]`);

    await run([
      "-hide_banner", "-y", "-i", inputPath,
      "-filter_complex", parts.join(";"),
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
      outPath,
    ]);

    const url = await storeTempFile(outPath, `vybe-tightened-${id}.mp4`, "video/mp4");
    await recordAsset(session.userId, url);
    return NextResponse.json({
      url,
      duration: Number(keptDur.toFixed(2)),
      removed: Number(removed.toFixed(2)),
      segments: kept.length,
      silences: silences.length,
      fillers: fillers.length,
    });
  } catch (err) {
    console.error("[clips/tighten]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Tighten failed" }, { status: 500 });
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

export const maxDuration = 300;
