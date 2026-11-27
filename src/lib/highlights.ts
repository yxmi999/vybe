// Auto-highlight v1 — finds candidate "viral moments" in a video by looking for
// loudness peaks in its audio (screams, hype, laughs, big plays all spike here).
// Runs entirely in the browser via the Web Audio API; the results pre-fill trim
// points in the clip editor.

export type Highlight = {
  id: string;
  time: number;   // peak time (s, source-relative)
  start: number;  // suggested clip start (s)
  end: number;    // suggested clip end (s)
  score: number;  // 0–100 relative loudness
};

export type DetectOpts = {
  duration: number;       // total video length (s)
  preRoll?: number;       // seconds of lead-in before the peak  (default 12)
  postRoll?: number;      // seconds after the peak               (default 8)
  minGap?: number;        // minimum spacing between highlights (s) (default 15)
  max?: number;           // max highlights to return             (default 8)
};

// Hard cap so we don't try to decode multi-hour streams into memory in v1.
export const MAX_ANALYZE_SECONDS = 40 * 60;

function movingAvg(a: number[], radius: number): number[] {
  if (radius <= 0) return a.slice();
  const res = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j >= 0 && j < a.length) { s += a[j]; c++; }
    }
    res[i] = s / c;
  }
  return res;
}

export async function detectAudioHighlights(bytes: ArrayBuffer, opts: DetectOpts): Promise<Highlight[]> {
  const preRoll  = opts.preRoll  ?? 12;
  const postRoll = opts.postRoll ?? 8;
  const minGap   = opts.minGap   ?? 15;
  const maxOut   = opts.max      ?? 8;

  const AC: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new Error("Web Audio not supported in this browser");

  const ctx = new AC();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error("Couldn't read this video's audio");
  } finally {
    ctx.close().catch(() => {});
  }

  const sr = buffer.sampleRate;
  const dur = buffer.duration || opts.duration;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  // RMS loudness envelope at 0.5s resolution.
  const hop = 0.5;
  const win = Math.max(1, Math.floor(sr * hop));
  const n = Math.floor(ch0.length / win);
  const env = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const start = i * win;
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const s = ch1 ? (ch0[start + j] + ch1[start + j]) * 0.5 : ch0[start + j];
      sum += s * s;
    }
    env[i] = Math.sqrt(sum / win);
  }
  if (n < 4) return [];

  const smooth = movingAvg(env, 3); // ~3s window
  const mean = smooth.reduce((s, v) => s + v, 0) / smooth.length;
  const variance = smooth.reduce((s, v) => s + (v - mean) ** 2, 0) / smooth.length;
  const sd = Math.sqrt(variance);
  const max = Math.max(...smooth);
  const min = Math.min(...smooth);
  const threshold = mean + 0.8 * sd;

  // Local maxima above threshold.
  const peaks: { idx: number; level: number }[] = [];
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] >= threshold && smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1]) {
      peaks.push({ idx: i, level: smooth[i] });
    }
  }
  if (peaks.length === 0) return [];

  // Greedily keep the loudest, enforcing minimum spacing.
  peaks.sort((a, b) => b.level - a.level);
  const gapWindows = Math.round(minGap / hop);
  const chosen: { idx: number; level: number }[] = [];
  for (const p of peaks) {
    if (chosen.every((c) => Math.abs(c.idx - p.idx) >= gapWindows)) chosen.push(p);
    if (chosen.length >= maxOut) break;
  }

  return chosen
    .map((p) => {
      const time = p.idx * hop;
      const score = Math.round(((p.level - min) / (max - min || 1)) * 100);
      return {
        id: crypto.randomUUID(),
        time,
        start: Math.max(0, time - preRoll),
        end: Math.min(dur, time + postRoll),
        score,
      };
    })
    .sort((a, b) => a.time - b.time);
}
