/**
 * Render-path test matrix. Drives the REAL ffmpeg graph builder (`runFfmpeg`)
 * across a matrix of editor option combinations against a synthetic clip, so a
 * broken filter string, an undefined expression variable, a bad escape, or an
 * incompatible filter combo fails HERE instead of in a user's export.
 *
 *   npx tsx scripts/test-render.ts   (or: npm run test:render)
 *
 * This is the regression net for bugs like the zoompan `it`→`on/fps` one: that
 * was a runtime ffmpeg error a string-shape assertion would never have caught —
 * only actually running the encoder surfaces it. Each case renders a few real
 * frames through the bundled @ffmpeg-installer binary and asserts the output is
 * a valid, correctly-sized video.
 *
 * No DB / storage / auth: runFfmpeg only touches ffmpeg + clip-filters, so this
 * exercises the production pipeline without the surrounding plumbing.
 */
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { execFile } from "child_process";
import { promisify } from "util";
import { stat, unlink, mkdtemp } from "fs/promises";
import path from "path";
import os from "os";
import { runFfmpeg, type FfmpegArgs } from "../src/lib/clip-render";
import { type TextStyle, type SplitConfig, defaultSplit } from "../src/lib/clip-filters";
import { relayoutClips, type Clip } from "../src/lib/timeline";

const run = promisify(execFile);
const FF = ffmpegInstaller.path;

const SRC_W = 1280, SRC_H = 720, SRC_FPS = 30, SRC_DUR = 4;

let passed = 0, failed = 0;
const failures: string[] = [];

// ── Synthetic source: moving test pattern + tone, known WxH/fps/duration ──
async function makeSource(dir: string): Promise<string> {
  const out = path.join(dir, "src.mp4");
  await run(FF, [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${SRC_W}x${SRC_H}:rate=${SRC_FPS}`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", String(SRC_DUR),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", out,
  ], { timeout: 60_000 });
  return out;
}

// Second "webcam" fixture for split screens with their own video: different
// size, and SHORTER than the source so the panel must loop and the render must
// still end with the clip (not run forever / end early).
const CAM_W = 640, CAM_H = 480, CAM_DUR = 1.5;
async function makeCam(dir: string): Promise<string> {
  const out = path.join(dir, "cam.mp4");
  await run(FF, [
    "-y", "-f", "lavfi", "-i", `smptebars=size=${CAM_W}x${CAM_H}:rate=25`,
    "-t", String(CAM_DUR), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out,
  ], { timeout: 60_000 });
  return out;
}
// Panel media placeholder; "__CAM__" is swapped for the real fixture path.
const cam = (offset = 0) => ({ url: "test://cam", w: CAM_W, h: CAM_H, duration: CAM_DUR, offset, path: "__CAM__" });

// Parse the output's video dimensions + audio presence + duration from
// ffmpeg -i stderr. Duration is the check that would most easily catch a
// silent multi-clip concat bug (a dropped or duplicated segment) — dims and
// audio presence alone wouldn't notice the output is the wrong length.
async function probe(file: string): Promise<{ w: number; h: number; hasAudio: boolean; duration: number }> {
  let stderr = "";
  try { await run(FF, ["-hide_banner", "-i", file], { timeout: 30_000 }); }
  catch (e) { stderr = String((e as { stderr?: string }).stderr ?? ""); }
  const dim = stderr.match(/Video:.*?[, ](\d{2,5})x(\d{2,5})/);
  const dur = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return {
    w: dim ? Number(dim[1]) : 0,
    h: dim ? Number(dim[2]) : 0,
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : -1,
  };
}

const STYLE: TextStyle = { font: "bold", color: "FFFFFF", template: "pop" };

// Two short subtitle segments with per-word timings, for classic/karaoke/word.
const SUBS = [
  { id: "s1", start: 0.2, end: 1.8, text: "hello there world", words: [
    { word: "hello", start: 0.2, end: 0.8 },
    { word: "there", start: 0.8, end: 1.3 },
    { word: "world", start: 1.3, end: 1.8 },
  ] },
  { id: "s2", start: 2.0, end: 3.6, text: "second line here", words: [
    { word: "second", start: 2.0, end: 2.6 },
    { word: "line", start: 2.6, end: 3.1 },
    { word: "here", start: 3.1, end: 3.6 },
  ] },
];

// Same segments with auto-emoji on a couple of keywords (libass ASS path).
const SUBS_EMOJI = SUBS.map((s) => ({
  ...s,
  words: s.words.map((w) =>
    w.word === "world" ? { ...w, emoji: "🔥" } : w.word === "here" ? { ...w, emoji: "💯" } : w),
}));

// Full FfmpegArgs with neutral defaults; each case overrides a subset.
function baseArgs(input: string, output: string, tempFiles: string[]): FfmpegArgs {
  return {
    inputPath: input, outputPath: output,
    srcW: SRC_W, srcH: SRC_H, fps: SRC_FPS,
    trimStart: 0, trimEnd: SRC_DUR, duration: SRC_DUR,
    caption: "", captionX: 50, captionY: 88, captionSize: 1, textStyle: STYLE,
    aspect: "original", cropX: 50, cropKeys: [], cropSmooth: true,
    zoom: 1, zoomKeys: [], zoomSmooth: true, blurFill: false,
    introText: "", outroText: "",
    subtitles: [], subtitleStyle: "classic", subtitleHighlight: "FFE000",
    subtitleX: 50, subtitleY: 88, subtitleSize: 1,
    musicPath: "", musicVolume: 80, musicDuration: 0, videoVolume: 100,
    speed: 1, brightness: 0, contrast: 0, videoPitch: 0, saturation: 0,
    colorFilter: "none", mirror: false, fadeIn: 0, fadeOut: 0, vignette: false,
    effects: [], volumeKeys: [], loudnorm: false, captionStart: 0, captionEnd: 0,
    assets: [], maxShortSide: 0, watermark: false, tempFiles,
  };
}

// Builds a relayouted Clip[] from bare source windows — runFfmpeg() trusts
// its `clips` input is already relayouted (that normalization is renderClip()'s
// job for real JSON payloads), so tests must do it themselves.
function mkClips(windows: { sourceStart: number; sourceEnd: number }[]): Clip[] {
  return relayoutClips(windows.map((w, i) => ({ id: `c${i}`, timelineStart: 0, duration: 0, ...w })));
}

type Case = {
  name: string;
  over: Partial<FfmpegArgs>;
  expect?: { w: number; h: number };   // assert output dimensions (the cropped paths)
  expectDuration?: number;             // assert output duration (multi-clip concat correctness)
};

// 9:16 → 1080x1920, 1:1 → 1080x1080, 16:9 → 1920x1080 (from ASPECTS canon sizes).
const cases: Case[] = [
  { name: "passthrough (original, no filters)", over: {} },
  { name: "aspect 9:16 crop", over: { aspect: "9:16" }, expect: { w: 1080, h: 1920 } },
  { name: "aspect 1:1 crop", over: { aspect: "1:1" }, expect: { w: 1080, h: 1080 } },
  { name: "aspect 16:9 crop", over: { aspect: "16:9" }, expect: { w: 1920, h: 1080 } },
  { name: "static crop position (right)", over: { aspect: "9:16", cropX: 80 } },
  { name: "motion crop keyframes (pan)", over: { aspect: "9:16", cropKeys: [
    { time: 0, x: 10 }, { time: 2, x: 50 }, { time: 4, x: 90 } ] } },
  { name: "motion crop keyframes (hard cut)", over: { aspect: "9:16", cropSmooth: false, cropKeys: [
    { time: 0, x: 20 }, { time: 2, x: 80 } ] } },
  { name: "static zoom 1.4x", over: { aspect: "9:16", zoom: 1.4 } },
  // The exact shape of the bug that started this: time-keyframed zoompan.
  { name: "zoom keyframes (zoompan ramp)", over: { aspect: "9:16", zoomKeys: [
    { time: 0, z: 1 }, { time: 2, z: 1.5 }, { time: 4, z: 1.2 } ] } },
  { name: "zoom + motion crop together (zoompan fx)", over: { aspect: "9:16",
    zoomKeys: [{ time: 0, z: 1 }, { time: 3, z: 1.4 }],
    cropKeys: [{ time: 0, x: 30 }, { time: 3, x: 70 }] } },
  { name: "zoom on original aspect (no crop)", over: { zoomKeys: [
    { time: 0, z: 1 }, { time: 2, z: 1.3 } ] } },
  { name: "blur-fill mode", over: { aspect: "9:16", blurFill: true }, expect: { w: 1080, h: 1920 } },
  { name: "subtitles classic (drawtext)", over: { subtitles: SUBS } },
  { name: "subtitles classic, long line chunked to fit 9:16", over: { aspect: "9:16", subtitles: [
    { id: "long", start: 0.2, end: 3.6, text: "this is a very long whisper segment that would run off both sides of a vertical frame" } ] },
    expect: { w: 1080, h: 1920 } },
  { name: "subtitles karaoke (libass)", over: { subtitles: SUBS, subtitleStyle: "karaoke", aspect: "9:16" } },
  { name: "subtitles word (libass)", over: { subtitles: SUBS, subtitleStyle: "word", aspect: "9:16" } },
  { name: "subtitles karaoke + speed (ASS timeline)", over: { subtitles: SUBS, subtitleStyle: "karaoke", speed: 1.5 } },
  { name: "subtitles karaoke in blur-fill", over: { subtitles: SUBS, subtitleStyle: "karaoke", aspect: "9:16", blurFill: true } },
  { name: "subtitles karaoke + auto-emoji (libass)", over: { subtitles: SUBS_EMOJI, subtitleStyle: "karaoke", aspect: "9:16" } },
  { name: "subtitles word + auto-emoji (libass)", over: { subtitles: SUBS_EMOJI, subtitleStyle: "word", aspect: "9:16" } },
  { name: "effects: invert + dim + punch (timed)",
    over: { aspect: "9:16", effects: [
      { type: "invert", start: 0.5, end: 0.7 }, { type: "dim", start: 1, end: 2 }, { type: "punch", start: 2.5, end: 3 },
    ] } },
  { name: "built-in SFX mixed in (public/sfx)",
    over: { assets: [
      { type: "sound", path: path.join(process.cwd(), "public", "sfx", "hit.mp3"), hasAudio: true, timestamp: 0.5, duration: 0.45, volume: 100, x: 0, y: 0, scale: 100 },
      { type: "sound", path: path.join(process.cwd(), "public", "sfx", "whoosh.mp3"), hasAudio: true, timestamp: 2, duration: 0.7, volume: 80, x: 0, y: 0, scale: 100 },
    ] } },
  { name: "subtitles karaoke look: 2 words/line, caps, box highlight, pop",
    over: { subtitles: SUBS_EMOJI, subtitleStyle: "karaoke", aspect: "9:16",
      subtitleLook: { wordsPerLine: 2, uppercase: true, outline: 1.5, activeMode: "box", pop: true } } },
  { name: "subtitles karaoke look: scale highlight, no outline",
    over: { subtitles: SUBS, subtitleStyle: "karaoke", aspect: "9:16",
      subtitleLook: { wordsPerLine: 3, uppercase: false, outline: 0, activeMode: "scale", pop: false } } },
  { name: "subtitles word look: box + pop",
    over: { subtitles: SUBS, subtitleStyle: "word", aspect: "9:16",
      subtitleLook: { wordsPerLine: 0, uppercase: true, outline: 2, activeMode: "box", pop: true } } },
  { name: "caption with nasty chars (escaping)", over: { caption: "it's 100%: a, b; [test] \"x\"" } },
  { name: "caption windowed", over: { caption: "hi", captionStart: 1, captionEnd: 3 } },
  { name: "speed 0.5x (setpts/atempo)", over: { speed: 0.5 } },
  { name: "speed 2x", over: { speed: 2 } },
  { name: "timed effects (enable windows)", over: { effects: [
    { type: "blur", start: 0.5, end: 1.5 }, { type: "flash", start: 2, end: 2.5 } ] } },
  { name: "volume keyframes (ducking)", over: { volumeKeys: [
    { time: 0, v: 100 }, { time: 2, v: 20 }, { time: 4, v: 100 } ] } },
  { name: "fades + mirror + vignette", over: { fadeIn: 0.5, fadeOut: 0.5, mirror: true, vignette: true } },
  { name: "color filter + eq", over: { colorFilter: "warm", brightness: 10, contrast: 15, saturation: 20 } },
  { name: "pitch shift + loudnorm", over: { videoPitch: 4, loudnorm: true } },
  { name: "intro/outro concat", over: { introText: "INTRO", outroText: "OUTRO", aspect: "9:16" } },
  { name: "watermark (free tier)", over: { watermark: true } },
  // 1920x1080 capped to 480 short side → width even(1920*480/1080)=852 (even, libx264-safe).
  { name: "resolution cap (maxShortSide 480)", over: { aspect: "16:9", maxShortSide: 480 }, expect: { w: 852, h: 480 } },
  { name: "trimmed segment", over: { trimStart: 1, trimEnd: 3, aspect: "9:16" } },
  // Everything-on stress: catches cross-filter interactions.
  { name: "STRESS: crop+zoom+subs+caption+effects+fades+speed+look", over: {
    aspect: "9:16",
    cropKeys: [{ time: 0, x: 30 }, { time: 3, x: 70 }],
    zoomKeys: [{ time: 0, z: 1 }, { time: 3, z: 1.3 }],
    subtitles: SUBS, subtitleStyle: "karaoke",
    caption: "BIG MOMENT", captionStart: 0.5, captionEnd: 3,
    effects: [{ type: "vivid", start: 1, end: 2 }],
    fadeIn: 0.3, fadeOut: 0.3, speed: 1.25, colorFilter: "vivid",
    loudnorm: true, watermark: true, volumeKeys: [{ time: 0, v: 100 }, { time: 2, v: 50 }],
  } },
  // ── Non-destructive timeline (multi-clip concat) ──────────────────────────
  { name: "single clip via `clips` array (fast path, no concat)",
    over: { clips: mkClips([{ sourceStart: 1, sourceEnd: 3 }]) }, expectDuration: 2 },
  { name: "multi-clip concat (2 clips, no gap effects)",
    over: { clips: mkClips([{ sourceStart: 0, sourceEnd: 1.5 }, { sourceStart: 2.5, sourceEnd: 4 }]) }, expectDuration: 3 },
  { name: "multi-clip + crop/zoom keyframes (timeline-relative)",
    over: {
      clips: mkClips([{ sourceStart: 0, sourceEnd: 1 }, { sourceStart: 1.5, sourceEnd: 2.5 }, { sourceStart: 3, sourceEnd: 4 }]),
      aspect: "9:16",
      zoomKeys: [{ time: 0, z: 1 }, { time: 3, z: 1.4 }],
      cropKeys: [{ time: 0, x: 20 }, { time: 3, x: 80 }],
    }, expect: { w: 1080, h: 1920 }, expectDuration: 3 },
  // Clip a: source [0,2) -> timeline [0,2); clip b: source [2.5,4) -> timeline
  // [2,3.5). A subtitle in SOURCE time [1.5, 3] straddles the trimmed-out gap
  // [2,2.5) — mapSubtitlesToTimeline must clip/shift it into two pieces.
  { name: "multi-clip + subtitle straddling the cut (karaoke, mapped timing)",
    over: {
      clips: mkClips([{ sourceStart: 0, sourceEnd: 2 }, { sourceStart: 2.5, sourceEnd: 4 }]),
      subtitleStyle: "karaoke",
      subtitles: [
        { id: "straddle", start: 1.5, end: 3, text: "hello world friend", words: [
          { word: "hello", start: 1.5, end: 2 },
          { word: "world", start: 2.5, end: 2.8 },
          { word: "friend", start: 2.8, end: 3 },
        ] },
      ],
    }, expectDuration: 3.5 },
  // ── Split screen (multi-panel layouts) ────────────────────────────────────
  // The split graph is spliced into the comma-joined chain, so it must survive
  // every path: plain -vf, the complex graph (music/assets), intro/outro
  // concat, the multi-clip pre-pass, and the resolution cap.
  { name: "split: facecam top 9:16 (-vf path)",
    over: { aspect: "9:16", split: defaultSplit("facecam") }, expect: { w: 1080, h: 1920 } },
  { name: "split: 2x2 grid 9:16", over: { aspect: "9:16", split: defaultSplit("grid4") }, expect: { w: 1080, h: 1920 } },
  { name: "split: 1+2 on 1:1", over: { aspect: "1:1", split: defaultSplit("top1bottom2") }, expect: { w: 1080, h: 1080 } },
  { name: "split: 3 stacked + look/effects/fades/mirror/speed",
    over: { aspect: "9:16", split: defaultSplit("stack3"), colorFilter: "warm", brightness: 10,
      effects: [{ type: "flash", start: 1, end: 1.5 }], fadeIn: 0.3, fadeOut: 0.3, mirror: true, vignette: true, speed: 1.5 },
    expect: { w: 1080, h: 1920 } },
  { name: "split: + karaoke subs + caption + watermark",
    over: { aspect: "9:16", split: defaultSplit("stack2"), subtitles: SUBS, subtitleStyle: "karaoke",
      caption: "SPLIT", watermark: true }, expect: { w: 1080, h: 1920 } },
  { name: "split: complex graph path (music mixed in)",
    over: { aspect: "9:16", split: defaultSplit("facecam"), musicPath: "__SRC__" }, expect: { w: 1080, h: 1920 } },
  { name: "split: intro/outro concat",
    over: { aspect: "9:16", split: defaultSplit("facecam"), introText: "IN", outroText: "OUT" }, expect: { w: 1080, h: 1920 } },
  { name: "split: multi-clip timeline",
    over: { aspect: "9:16", split: defaultSplit("grid4"),
      clips: mkClips([{ sourceStart: 0, sourceEnd: 1.5 }, { sourceStart: 2.5, sourceEnd: 4 }]) },
    expect: { w: 1080, h: 1920 }, expectDuration: 3 },
  { name: "split: resolution cap 720 + custom zoomed panels",
    over: { aspect: "9:16", maxShortSide: 720, split: { layout: "facecam", panels: [
      { cx: 0.95, cy: 0.05, zoom: 6 }, { cx: 0.3, cy: 0.6, zoom: 1.4 } ] } },
    expect: { w: 720, h: 1280 } },
  // ── Split screen with screens showing their OWN video (movie= source) ─────
  { name: "split media: facecam layout, screen 1 = webcam video (loops)",
    over: { aspect: "9:16", split: { layout: "facecam", panels: [
      { cx: 0.5, cy: 0.5, zoom: 1, media: cam() }, { cx: 0.5, cy: 0.5, zoom: 1 } ] } },
    expect: { w: 1080, h: 1920 }, expectDuration: SRC_DUR },
  { name: "split media: 3 stacked, clip + cam + cam(offset, zoomed)",
    over: { aspect: "9:16", split: { layout: "stack3", panels: [
      { cx: 0.5, cy: 0.5, zoom: 1 }, { cx: 0.5, cy: 0.5, zoom: 1, media: cam() },
      { cx: 0.2, cy: 0.3, zoom: 2.5, media: cam(0.7) } ] } },
    expect: { w: 1080, h: 1920 }, expectDuration: SRC_DUR },
  { name: "split media: every screen media -> clip forced into screen 1",
    over: { aspect: "9:16", split: { layout: "stack2", panels: [
      { cx: 0.5, cy: 0.5, zoom: 1, media: cam() }, { cx: 0.5, cy: 0.5, zoom: 1, media: cam() } ] } },
    expect: { w: 1080, h: 1920 }, expectDuration: SRC_DUR },
  { name: "split media: + music (complex) + subs + speed 2x",
    over: { aspect: "9:16", musicPath: "__SRC__", speed: 2, subtitles: SUBS, subtitleStyle: "karaoke",
      split: { layout: "facecam", panels: [{ cx: 0.5, cy: 0.5, zoom: 1, media: cam() }, { cx: 0.5, cy: 0.5, zoom: 1 }] } },
    expect: { w: 1080, h: 1920 }, expectDuration: SRC_DUR / 2 },
  { name: "split media: intro/outro + trimmed segment",
    over: { aspect: "9:16", introText: "IN", outroText: "OUT", trimStart: 1, trimEnd: 3,
      split: { layout: "grid4", panels: [
        { cx: 0.25, cy: 0.25, zoom: 2 }, { cx: 0.5, cy: 0.5, zoom: 1, media: cam() },
        { cx: 0.25, cy: 0.75, zoom: 2 }, { cx: 0.5, cy: 0.5, zoom: 1.5, media: cam(1) } ] } },
    expect: { w: 1080, h: 1920 }, expectDuration: 2 + 6 },
  { name: "split media: multi-clip timeline",
    over: { aspect: "9:16", clips: mkClips([{ sourceStart: 0, sourceEnd: 1.5 }, { sourceStart: 2.5, sourceEnd: 4 }]),
      split: { layout: "facecam", panels: [{ cx: 0.5, cy: 0.5, zoom: 1, media: cam() }, { cx: 0.5, cy: 0.5, zoom: 1 }] } },
    expect: { w: 1080, h: 1920 }, expectDuration: 3 },
];

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vybe-render-test-"));
  console.log(`render-path matrix · src ${SRC_W}x${SRC_H}@${SRC_FPS} ${SRC_DUR}s · ${cases.length} cases\n`);
  const src = await makeSource(dir);
  const camPath = await makeCam(dir);

  for (const c of cases) {
    const out = path.join(dir, `out-${c.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.mp4`);
    const tempFiles: string[] = [];
    const args = { ...baseArgs(src, out, tempFiles), ...c.over };
    // "__SRC__" = reuse the synthetic source as a music track (it has a tone),
    // to force the -filter_complex path without a separate fixture.
    if (args.musicPath === "__SRC__") args.musicPath = src;
    if (args.split) {
      args.split = { ...args.split, panels: args.split.panels.map((p) =>
        p.media?.path === "__CAM__" ? { ...p, media: { ...p.media, path: camPath } } : p) } as SplitConfig;
    }
    try {
      await runFfmpeg(args);
      const s = await stat(out).catch(() => null);
      if (!s || s.size < 1024) throw new Error(`output missing or tiny (${s?.size ?? 0} bytes)`);
      const p = await probe(out);
      if (p.w === 0 || p.h === 0) throw new Error("no video stream in output");
      if (!p.hasAudio) throw new Error("no audio stream in output");
      if (c.expect && (p.w !== c.expect.w || p.h !== c.expect.h))
        throw new Error(`dims ${p.w}x${p.h}, expected ${c.expect.w}x${c.expect.h}`);
      if (c.expectDuration != null && Math.abs(p.duration - c.expectDuration) > 0.3)
        throw new Error(`duration ${p.duration.toFixed(2)}s, expected ~${c.expectDuration}s`);
      passed++;
      console.log(`  ✓ ${c.name}  (${p.w}x${p.h}${c.expectDuration != null ? `, ${p.duration.toFixed(2)}s` : ""})`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      failures.push(`${c.name}: ${msg}`);
      console.log(`  ✗ ${c.name}\n      ${err instanceof Error ? err.message : err}`);
    } finally {
      await unlink(out).catch(() => {});
      await Promise.all(tempFiles.map((f) => unlink(f).catch(() => {})));
    }
  }

  await unlink(src).catch(() => {});
  await unlink(camPath).catch(() => {});
  console.log(`\n${failed === 0 ? "✓ all passed" : "✗ failures"}: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
