import path from "path";
import os from "os";
import { unlink, writeFile, readdir } from "fs/promises";
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { resolveToTempFile } from "./storage";
import { GEMINI_MODELS, isTransient, aiFailure } from "./ai";
import { z } from "zod";
import { makeVideoProxy, extractFrames } from "./auto-edit";
import { silences, gradeStats, framesAt, type GradeStats } from "./media-probe";
import { recreateCaptionFrame } from "./style-verify";
import { clipStyleSchema, sanitizeStyle, type ClipStyle } from "./clip-style";

// "Copy this clip's style": take a reference short (an upload, a stored clip,
// or a TikTok / YouTube / Instagram link), MEASURE what can be measured
// (length, cut rate) and let the model WATCH it to describe everything else —
// caption look, hook text, punch-ins, grade — as a portable ClipStyle.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };
// yt-dlp-exec rewrites __dirname under Next's bundler — build the binary path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create: createYtDlp } = require("yt-dlp-exec") as {
  create: (binPath: string) => (url: string, flags: Record<string, unknown>) => Promise<unknown>;
};
const ytDlp = createYtDlp(path.join(
  process.cwd(), "node_modules", "yt-dlp-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
));

// A style shows within the first minute; analysing more just costs tokens.
const ANALYZE_SECONDS = 75;

const SOCIAL_HOST = /(^|\.)(tiktok\.com|youtube\.com|youtu\.be|instagram\.com|twitter\.com|x\.com|twitch\.tv|kick\.com|facebook\.com|fb\.watch|rumble\.com)$/i;
const DIRECT_VIDEO = /\.(mp4|mov|webm|m4v|mkv)(\?|#|$)/i;

export class StyleAnalyzeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const tmpBase = () => path.join(os.tmpdir(), `vybe-style-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

async function downloadSocial(url: string): Promise<string> {
  const base = tmpBase();
  try {
    await ytDlp(url, {
      output: `${base}.%(ext)s`,
      // H.264 so the bundled ffmpeg can decode it (YouTube also serves AV1).
      format: "best[vcodec^=avc1][height<=720]/bestvideo[vcodec^=avc1][height<=720]+bestaudio/best[height<=720]/best",
      mergeOutputFormat: "mp4",
      downloadSections: `*0-${ANALYZE_SECONDS}`,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
      noCheckCertificates: true,
      noWarnings: true,
      ...(url.includes("tiktok.com") ? { addHeader: "Referer:https://www.tiktok.com/" } : {}),
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).split("\n").filter(Boolean).slice(0, 2).join(" | ");
    if (/login|sign in|private/i.test(detail)) throw new StyleAnalyzeError("That video is private or needs a login — use a public link or upload the file.");
    throw new StyleAnalyzeError(`Couldn't download that link: ${detail}`);
  }
  const dir = path.dirname(base);
  const name = (await readdir(dir)).find((f) => f.startsWith(path.basename(base)));
  if (!name) throw new StyleAnalyzeError("Download finished but no video file was produced.");
  return path.join(dir, name);
}

// Get the reference onto local disk. Returns the path (caller deletes it).
export async function acquireReference(src: { buffer?: Buffer; url?: string }): Promise<string> {
  if (src.buffer) {
    const p = `${tmpBase()}.mp4`;
    await writeFile(p, src.buffer);
    return p;
  }
  const url = (src.url ?? "").trim();
  if (!url) throw new StyleAnalyzeError("Upload a video or paste a link.");
  if (url.startsWith("/")) {
    // A clip already stored by this app (public/…). No traversal.
    if (url.includes("..")) throw new StyleAnalyzeError("Invalid path.");
    const p = `${tmpBase()}.mp4`;
    await resolveToTempFile(url, p);
    return p;
  }
  let u: URL;
  try { u = new URL(url); } catch { throw new StyleAnalyzeError("That doesn't look like a link."); }
  if (!/^https?:$/.test(u.protocol)) throw new StyleAnalyzeError("Only http(s) links are supported.");
  if (SOCIAL_HOST.test(u.hostname)) return downloadSocial(url);
  if (DIRECT_VIDEO.test(u.pathname)) {
    const p = `${tmpBase()}.mp4`;
    await resolveToTempFile(url, p);
    return p;
  }
  throw new StyleAnalyzeError("Paste a TikTok, YouTube, Instagram, X, Twitch or Kick link — or upload the file.");
}

// Duration, frame size + hard-cut count in one ffmpeg pass (scene-change
// detector). Cut rate is the single most telling pacing fact, and models can't
// count it reliably; the frame size gives the TRUE aspect ratio.
async function measure(videoPath: string): Promise<{ duration: number; cuts: number; window: number; w: number; h: number }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  let stderr = "";
  try {
    const r = await run(ffmpegPath, [
      "-t", String(ANALYZE_SECONDS), "-i", videoPath,
      "-vf", "scale=320:-2,select='gt(scene,0.32)',showinfo", "-an", "-f", "null", "-",
    ], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
    stderr = r.stderr;
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? "";
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  const cuts = (stderr.match(/pts_time:/g) ?? []).length;
  const dim = stderr.match(/Video:.*?[, ](\d{2,5})x(\d{2,5})/);
  // Rotated phone uploads report the stored size; honour the rotation tag.
  const rotated = /rotate\s*:\s*-?(90|270)/.test(stderr) || /rotation of -?90/.test(stderr);
  let w = dim ? Number(dim[1]) : 0, h = dim ? Number(dim[2]) : 0;
  if (rotated) [w, h] = [h, w];
  return { duration, cuts, window: Math.min(duration || ANALYZE_SECONDS, ANALYZE_SECONDS), w, h };
}

const ASPECT_RATIOS: { key: ClipStyle["framing"]["aspect"]; r: number }[] = [
  { key: "9:16", r: 9 / 16 }, { key: "4:5", r: 4 / 5 }, { key: "1:1", r: 1 }, { key: "16:9", r: 16 / 9 },
];
function measuredAspect(w: number, h: number): ClipStyle["framing"]["aspect"] | null {
  if (!(w > 0 && h > 0)) return null;
  const r = w / h;
  const best = ASPECT_RATIOS.reduce((a, b) => (Math.abs(Math.log(b.r / r)) < Math.abs(Math.log(a.r / r)) ? b : a));
  return Math.abs(Math.log(best.r / r)) < 0.04 ? best.key : null;
}

export type StyleFacts = { duration: number; cutsPerMin: number; aspect?: string | null; pausesPerMin?: number; verified?: boolean };

// The analysis pass also reports which still shows captions best and what they
// say, so the result can be re-created and checked (see style-verify.ts).
const analysisSchema = z.object({
  style: clipStyleSchema,
  captionSample: z.object({
    stillIndex: z.number().describe("Which attached still (0, 1 or 2, in order) shows the burned-in captions most clearly. -1 if none has captions."),
    text: z.string().describe("The exact caption words visible on that still, as written (keep their case). Empty if none."),
  }),
});

const captionFixSchema = z.object({
  matches: z.boolean().describe("true if the re-creation already matches the original captions closely"),
  captions: clipStyleSchema.shape.captions,
  differences: z.string().describe("What was different and what you changed, one short sentence."),
});

const STILL_FRACTIONS = [0.05, 0.35, 0.65];

export async function analyzeStyle(videoPath: string, sourceLabel = ""): Promise<{ style: ClipStyle; facts: StyleFacts; model: string }> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new StyleAnalyzeError("AI isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart.", 500);
  }
  const { duration, cuts, window, w, h } = await measure(videoPath);
  if (duration > 0 && duration < 2) throw new StyleAnalyzeError("That clip is too short to learn a style from.");
  const win = window || ANALYZE_SECONDS;
  const cutsPerMin = window > 0 ? Math.round((cuts / window) * 60) : 0;
  const aspect = measuredAspect(w, h);

  // Higher res + fps than Auto-edit's proxy: the model must READ caption fonts
  // and colors. Fall back to a lighter proxy, then to stills. The cheap
  // measurements run alongside.
  const [proxy, stills, pauses, grade] = await Promise.all([
    makeVideoProxy(videoPath, 0, win, { height: 540, fps: 4 })
      .then((p) => p ?? makeVideoProxy(videoPath, 0, win, { height: 360, fps: 3 })),
    extractFrames(videoPath, 0, window || 30, STILL_FRACTIONS),
    silences(videoPath, 0.6).then((s) => s.filter((x) => x.start < win)),
    gradeStats(videoPath, 0, win),
  ]);
  if (!proxy && stills.length === 0) throw new StyleAnalyzeError("Couldn't read that video — is it a valid video file?");
  const pausesPerMin = win > 0 ? Math.round((pauses.length / win) * 60) : 0;
  const longestPause = pauses.reduce((m, p) => Math.max(m, p.end - p.start), 0);

  const facts = [
    duration > 0 ? `Total length: ${duration.toFixed(1)}s.` : "",
    w && h ? `Frame size: ${w}x${h}${aspect ? ` → aspect ${aspect} (ground truth — use it)` : ""}.` : "",
    `Measured hard cuts: ${cuts} in the first ${Math.round(win)}s ≈ ${cutsPerMin} cuts/min (0-6 = calm, 7-20 = balanced, 20+ = hype/jump-cut editing).`,
    `Measured pauses ≥0.6s: ${pauses.length} (≈${pausesPerMin}/min, longest ${longestPause.toFixed(1)}s). A talking clip with almost no pauses has had its dead air removed; frequent long pauses mean it hasn't (music-only clips have few pauses too — use your ears).`,
    grade ? `Measured picture: average luma ${grade.brightness}/255 (≈100-130 is normal; <85 dark/moody, >145 bright), average saturation ${grade.saturation} (≈25-45 normal; >55 punchy/vivid; <15 near-B&W), luma spread ${grade.contrast} (≈170-210 normal; >215 high contrast; <150 flat/faded). Treat these as evidence for the grade fields.` : "",
    sourceLabel ? `Source: ${sourceLabel}` : "",
  ].filter(Boolean).join("\n");

  const system = `You are a senior short-form video editor reverse-engineering another creator's EDITING STYLE so it can be reproduced on new clips.
Watch the attached short (and the higher-resolution stills) and describe HOW it is edited — not what it's about.

Be precise about:
- CAPTIONS: Are spoken words burned in? Animation (whole lines / phrase with the active word highlighted = karaoke / one word at a time = word)? Font weight & family (map to the closest of: impact = heavy condensed meme, condensed = tall thin Bebas-like, bold = heavy geometric sans, round = chunky rounded, sans = regular sans, serif, marker = hand-drawn, mono)? Treatment (outline / box behind text / drop shadow / thick outline+shadow = pop)? Main color and the highlight color as hex. Vertical position and size. Emoji in captions?
  Also: how many words are on screen at once (wordsPerLine), ALL CAPS or not, outline thickness, how the spoken word stands out (colour change / coloured box behind it / gets bigger), and whether words pop in.
- HOOK TEXT: a title/question overlay (usually near the top)? Is it ALL CAPS? How long is it on screen? How is it written?
- FRAMING: aspect ratio; does the video fill the frame or sit over a blurred copy of itself? Is the frame split with a facecam/webcam panel on top and gameplay below (layout = facecam)?
- MOTION: how often do zoom punch-ins happen, how strong, snap or smooth?
- PACING: use the measured cut rate and pauses — they're ground truth. Are silences removed (jump cuts in speech)?
- GRADE & TRANSITIONS: color look, contrast/saturation, vignette, fades, white flashes. Grade numbers are ADJUSTMENTS to apply to normal footage (0 = leave as is), so only move them when the reference clearly looks graded.
Use only what you observe; when something isn't present, say so (enabled=false / "none"). In "notes", write concrete guidance another editor could follow to match this style on a different clip.
In captionSample, point at the still whose captions are clearest and copy the words exactly — they will be re-rendered in your extracted style to check your work.`;

  const media = [
    ...(proxy ? [{ type: "file" as const, data: proxy, mediaType: "video/mp4" }] : []),
    ...stills.map((f) => ({ type: "image" as const, image: f })),
  ];

  let lastErr: unknown;
  for (const modelId of GEMINI_MODELS) {
    try {
      const { object } = await generateObject({
        model: google(modelId),
        schema: analysisSchema,
        system,
        messages: [{
          role: "user",
          content: [{ type: "text" as const, text: `Extract the editing style of this reference clip.\n\nMeasured facts:\n${facts}` }, ...media],
        }],
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(75_000),
      });
      let style = reconcileWithMeasurements(sanitizeStyle(object.style), aspect, grade);

      // Re-create the captions in the extracted style and let the model
      // compare them to the original — one correction round.
      let verified = false;
      const sample = object.captionSample;
      if (style.captions.enabled && sample.text.trim() && sample.stillIndex >= 0 && sample.stillIndex < STILL_FRACTIONS.length) {
        const fixed = await verifyCaptions(videoPath, style, sample, win, modelId).catch((err) => {
          console.error("[style-analyze] verify failed:", err instanceof Error ? err.message : err);
          return null;
        });
        if (fixed) { style = fixed; verified = true; }
      }
      return { style, facts: { duration, cutsPerMin, aspect, pausesPerMin, verified }, model: modelId };
    } catch (err) {
      lastErr = err;
      console.error(`[style-analyze] ${modelId} failed:`, err instanceof Error ? err.message : err);
      if (!isTransient(err)) break;
    }
  }
  const fail = aiFailure(lastErr);
  throw new StyleAnalyzeError(fail.error, fail.status);
}

/**
 * Measurements beat impressions. The aspect ratio is taken from the file; a
 * facecam split only exists in vertical frames; and a grade adjustment only
 * survives when the measured picture agrees with it (dark gameplay footage is
 * not a "darkened" grade, a colourful game is not a "vivid" one).
 */
function reconcileWithMeasurements(style: ClipStyle, aspect: ClipStyle["framing"]["aspect"] | null, grade: GradeStats | null): ClipStyle {
  const framing = { ...style.framing, ...(aspect ? { aspect } : {}) };
  if (framing.layout === "facecam" && !["9:16", "4:5"].includes(framing.aspect)) framing.layout = "single";
  const g = { ...style.grade };
  if (grade) {
    if (g.saturation < -10 && grade.saturation >= 18) g.saturation = 0;
    if (g.saturation > 10 && grade.saturation < 48) g.saturation = Math.min(g.saturation, 6);
    if (g.brightness < -8 && grade.brightness >= 85) g.brightness = 0;
    if (g.brightness > 8 && grade.brightness <= 140) g.brightness = 0;
    if (g.contrast < -8 && grade.contrast >= 150) g.contrast = 0;
    if (g.contrast > 8 && grade.contrast <= 205) g.contrast = Math.min(g.contrast, 6);
    if (g.colorFilter === "bw" && grade.saturation >= 12) g.colorFilter = "none";
    // Near-colourless reference = a real B&W look, not a saturation slider.
    if (grade.saturation < 8 && g.colorFilter === "none") { g.colorFilter = "bw"; g.saturation = 0; }
  }
  // Dark or flat SOURCE footage isn't the creator's grade — and a wrong strong
  // grade ruins every clip it's applied to. Copy grades gently.
  const cap = (v: number) => Math.max(-15, Math.min(15, v));
  g.brightness = cap(g.brightness); g.contrast = cap(g.contrast); g.saturation = cap(g.saturation);
  return { ...style, framing, grade: g };
}

async function verifyCaptions(
  videoPath: string, style: ClipStyle, sample: { stillIndex: number; text: string }, win: number, modelId: string,
): Promise<ClipStyle | null> {
  const t = win * STILL_FRACTIONS[sample.stillIndex];
  const [frame] = await framesAt(videoPath, [t], 720);
  if (!frame) return null;
  const recreated = await recreateCaptionFrame(frame.jpeg, style, sample.text);
  if (!recreated) return null;
  const original = (await framesAt(videoPath, [t], 512))[0]?.jpeg ?? frame.jpeg;

  const { object } = await generateObject({
    model: google(modelId),
    schema: captionFixSchema,
    system: `You check a caption-style copy. Image 1 is the ORIGINAL frame. Image 2 is our RE-CREATION of its captions using the extracted settings below, rendered on a blurred copy of the frame (the middle word is the "active" one).
Compare ONLY the captions: font family/weight, letter case, color, highlight color and how the active word is shown (colour / box / bigger), outline/box/shadow treatment and thickness, size relative to the frame, vertical position, words per line.
Return corrected caption settings. Keep every field that already matches; change only what's visibly different. Font options: impact, condensed, bold, round, sans, serif, marker, mono.
Current settings: ${JSON.stringify(style.captions)}`,
    messages: [{
      role: "user",
      content: [
        { type: "text" as const, text: "Image 1 — original:" },
        { type: "image" as const, image: original },
        { type: "text" as const, text: "Image 2 — our re-creation:" },
        { type: "image" as const, image: recreated },
      ],
    }],
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(60_000),
  });
  if (object.matches) return style;
  // Captions must stay enabled/animated as detected — the check is about the look.
  const captions = { ...object.captions, enabled: style.captions.enabled, emoji: style.captions.emoji };
  return sanitizeStyle({ ...style, captions });
}

export async function analyzeReference(src: { buffer?: Buffer; url?: string }, sourceLabel = "") {
  const p = await acquireReference(src);
  try {
    return await analyzeStyle(p, sourceLabel);
  } finally {
    await unlink(p).catch(() => {});
  }
}
