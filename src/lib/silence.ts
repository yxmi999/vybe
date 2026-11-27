// Silence-aware clip boundaries. A highlight peak tells us *when* the moment is,
// but a fixed pad/length window often opens on dead air or clips a word in half —
// which reads as sloppy on the FYP. ffmpeg's `silencedetect` is free (it runs on
// the section we already cut), so we use it to trim leading/trailing dead air and
// guarantee the clip starts and ends on a natural pause.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

export type SilenceSpan = { start: number; end: number };

/**
 * Detect silent spans in a local media file. `silencedetect` writes its findings
 * to stderr as `silence_start: X` / `silence_end: Y` lines; `-f null -` means no
 * output file is produced. Best-effort: any failure returns [] so the caller
 * simply keeps its original window.
 */
export async function detectSilence(
  filePath: string,
  noiseDb = -30,
  minDurSec = 0.35,
): Promise<SilenceSpan[]> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(execFile);
    const { stderr } = await run(
      ffmpegPath,
      ["-hide_banner", "-i", filePath, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDurSec}`, "-f", "null", "-"],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );

    const spans: SilenceSpan[] = [];
    let open: number | null = null;
    for (const line of stderr.split(/\r?\n/)) {
      const s = line.match(/silence_start:\s*(-?[\d.]+)/);
      if (s) { open = Math.max(0, Number(s[1])); continue; }
      const e = line.match(/silence_end:\s*(-?[\d.]+)/);
      if (e && open !== null) {
        const end = Number(e[1]);
        if (end > open) spans.push({ start: open, end });
        open = null;
      }
    }
    return spans;
  } catch {
    return [];
  }
}

export type SnapOpts = {
  minSetup?: number; // seconds of lead-in to always keep before the peak (default 8)
  minTail?: number;  // seconds to always keep after the peak              (default 6)
  minLen?: number;   // discard the snap if it would shorten below this    (default 12)
};

/**
 * Given a section spanning [0, len] with its peak at `peak`, trim only the dead
 * air at the very start and end so the clip opens and closes on a pause. If the
 * section doesn't begin/end in silence this is a no-op (returns 0..len), so it
 * can never make a clip worse — only tighter.
 */
export function snapToSilence(
  len: number,
  peak: number,
  silences: SilenceSpan[],
  opts: SnapOpts = {},
): { start: number; end: number } {
  const minSetup = opts.minSetup ?? 8;
  const minTail = opts.minTail ?? 6;
  const minLen = opts.minLen ?? 12;

  let start = 0;
  let end = len;

  // Leading dead air: a silence that begins at the very start of the section.
  const lead = silences.find((s) => s.start <= 0.5 && s.end > 0.5);
  if (lead) start = Math.max(0, Math.min(lead.end, peak - minSetup));

  // Trailing dead air: a silence that runs to the end of the section. Cut where
  // it begins, but never before the reaction has had `minTail` to land.
  const tail = [...silences].reverse().find((s) => s.end >= len - 0.5 && s.start < len - 0.5);
  if (tail) end = Math.min(len, Math.max(tail.start, peak + minTail));

  if (end - start < minLen) return { start: 0, end: len };
  return { start, end };
}
