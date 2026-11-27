// Clip rendering core — extracted from the /api/clips/process route so both the
// interactive editor export and the Auto-Pilot engine render through the exact
// same ffmpeg pipeline. The route is now a thin session-checked wrapper around
// `renderClip()`.
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { resolveToTempFile, storeTempFile } from "./storage";
import { recordClip, getUserPlan, limitsFor, requiresWatermark, recordWatermarkedExport } from "./plan";
import {
  ASPECTS, type AspectKey, type CropKeyframe, type ZoomKeyframe, type TextStyle,
  buildVideoFilters, captionDrawtext, escapeDrawtext, audioPitchFilters, audioFadeFilters, audioVolumeFilters,
  styleDrawOptions, DEFAULT_TEXT_STYLE,
  COLOR_FILTERS, COLOR_FILTER_KEYS, type ColorFilterKey,
  EFFECTS, EFFECT_KEYS, type EffectSegment, type VolumeKeyframe,
  type SplitConfig, sanitizeSplit,
  TEXT_FONTS, BRAND_FONTS, watermarkGraph, isFontKey, fontfileOpt,
} from "./clip-filters";
import { buildAss, type SubtitleStyle } from "./ass-subtitles";
import { sanitizeSubtitleLook, type SubtitleLook } from "./subtitle-look";
import { withRenderSlot } from "./render-gate";
import { assembleClips } from "./clip-assemble";
import { type Clip, type Subtitle, relayoutClips, totalDuration, mapSubtitlesToTimeline, clipVolume } from "./timeline";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Bundled fonts (public/fonts) — identical on every machine and deploy target.
// next.config's outputFileTracingIncludes ships them with the server functions.
const FONTS_DIR = path.join(process.cwd(), "public", "fonts");
const bundled = (file: string) => {
  const p = path.join(FONTS_DIR, file);
  return existsSync(p) ? p : "";
};

// Default font (intro/outro cards, classic subtitles): the default "Bold" style.
function getFontPath(): string {
  return bundled(TEXT_FONTS.bold.file);
}

// Fonts that cover CJK scripts. Dev = Windows system fonts; Linux/Mac fall back
// to Noto CJK / platform fonts when installed.
const NOTO = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
];
const CJK_FONTS: Record<"zh" | "ja" | "ko", string[]> = {
  zh: ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhl.ttc", "C:/Windows/Fonts/simsun.ttc", ...NOTO, "/System/Library/Fonts/PingFang.ttc"],
  ja: ["C:/Windows/Fonts/YuGothM.ttc", "C:/Windows/Fonts/meiryo.ttc", "C:/Windows/Fonts/msgothic.ttc", ...NOTO, "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"],
  ko: ["C:/Windows/Fonts/malgun.ttf", "C:/Windows/Fonts/gulim.ttc", "C:/Windows/Fonts/batang.ttc", ...NOTO, "/System/Library/Fonts/AppleSDGothicNeo.ttc"],
};
const fontCache: Record<string, string> = {};
function resolveFont(cands: string[]): string {
  const key = cands[0];
  if (fontCache[key] !== undefined) return fontCache[key];
  return (fontCache[key] = cands.find(existsSync) ?? "");
}
// Latin style fonts come from the shared registry (lib/clip-filters TEXT_FONTS).
function styleFont(style: TextStyle): string {
  return bundled((TEXT_FONTS[style.font] ?? TEXT_FONTS.bold).file) || getFontPath();
}

// libass picks fonts by family name; pointing `fontsdir` at public/fonts and
// using each file's own internal family name makes it load exactly that file
// (no reliance on fontconfig, which often isn't configured on render hosts).
function assFontFor(style: TextStyle): { path: string; family: string; bold: 0 | 1 } {
  const f = TEXT_FONTS[style.font] ?? TEXT_FONTS.bold;
  return { path: styleFont(style), family: f.family, bold: f.assBold };
}

// The watermark needs the brand font; skip it rather than fail the render.
function hasWatermarkAssets() {
  return !!bundled(BRAND_FONTS.bold);
}

// Choose a glyph-capable font for the given text (Korean → Japanese → Chinese → Latin).
function fontForText(text: string, latin: string): string {
  if (/[가-힯ᄀ-ᇿ]/.test(text)) return resolveFont(CJK_FONTS.ko) || resolveFont(CJK_FONTS.zh) || latin;
  if (/[぀-ヿ]/.test(text)) return resolveFont(CJK_FONTS.ja) || resolveFont(CJK_FONTS.zh) || latin;
  if (/[㐀-鿿豈-﫿]/.test(text)) return resolveFont(CJK_FONTS.zh) || latin;
  return latin;
}


// Overlay/sound assets, resolved to local temp files by renderClip().
type ProcessAsset = {
  type: "image" | "video" | "sound";
  path: string;
  hasAudio: boolean;    // probed for videos; sounds are always true, images false
  timestamp: number;    // source-relative seconds
  duration: number;     // window length (image) / play length (video, sound)
  volume: number;       // 0–200
  x: number; y: number; // top-left, % of output frame
  scale: number;        // width, % of output frame width
};

// ffmpeg -i always exits non-zero without an output file, but its stderr lists
// the streams — enough to know whether a video asset brings audio to mix.
async function hasAudioStream(file: string): Promise<boolean> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  try {
    await promisify(execFile)(ffmpegInstaller.path, ["-hide_banner", "-i", file], { timeout: 30_000 });
    return false;
  } catch (err) {
    return /Stream #[^\n]*Audio:/.test(String((err as { stderr?: string }).stderr ?? ""));
  }
}

// The whole filter graph maps the source's [0:a]/0:a audio, so a clip with no
// audio track (some YouTube sections, screen recordings, silent uploads) makes
// ffmpeg fail with "Stream map '0:a' matches no streams". Give such clips a
// silent stereo track once, up front, so the rest of the pipeline is unchanged.
async function ensureAudioTrack(file: string): Promise<void> {
  if (await hasAudioStream(file)) return;
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const tmp = file.replace(/\.mp4$/i, "") + `-aud-${Date.now()}.mp4`;
  await run(
    ffmpegInstaller.path,
    [
      "-hide_banner", "-y",
      "-i", file,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      tmp,
    ],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const { unlink, rename } = await import("fs/promises");
  await unlink(file).catch(() => {});
  await rename(tmp, file);
}

// Split one subtitle segment into consecutive pieces of at most `maxChars`
// characters. With word timings each piece spans its own words (and holds
// until the next piece starts, so there's no flicker between them); without,
// the segment's time is shared out in proportion to each piece's length.
export function chunkSubtitle(s: Subtitle, maxChars: number): Subtitle[] {
  const text = s.text.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return [s];
  const words = s.words?.length ? s.words : null;
  const tokens = words ? words.map((w) => w.word.trim()).filter(Boolean) : text.split(" ");
  const groups: number[][] = [];
  let cur: number[] = [], len = 0;
  tokens.forEach((tok, i) => {
    const add = (cur.length ? 1 : 0) + tok.length;
    if (cur.length && len + add > maxChars) { groups.push(cur); cur = []; len = 0; }
    len += (cur.length ? 1 : 0) + tok.length;
    cur.push(i);
  });
  if (cur.length) groups.push(cur);
  if (groups.length <= 1) return [s];
  if (words) {
    const valid = words.filter((w) => w.word.trim());
    return groups.map((g, gi) => {
      const start = gi === 0 ? s.start : valid[g[0]].start;
      const next = groups[gi + 1];
      const end = next ? valid[next[0]].start : s.end;
      return { ...s, id: `${s.id}.${gi}`, start, end: Math.max(end, start + 0.05), text: g.map((i) => tokens[i]).join(" "), words: g.map((i) => valid[i]) };
    });
  }
  const total = groups.reduce((n, g) => n + g.reduce((m, i) => m + tokens[i].length + 1, 0), 0);
  let t = s.start;
  return groups.map((g, gi) => {
    const piece = g.map((i) => tokens[i]).join(" ");
    const dur = (s.end - s.start) * ((piece.length + 1) / total);
    const out = { ...s, id: `${s.id}.${gi}`, start: t, end: gi === groups.length - 1 ? s.end : t + dur, text: piece, words: undefined };
    t += dur;
    return out;
  });
}

// Burn timed subtitles as one drawtext per segment (no libass dependency).
// Times are shifted to the trimmed output and gated with `enable=between(t,...)`.
// `speed` must match where the filter sits in the chain: when the drawtext runs
// after setpts (the standard path), `t` is on the sped-up output timeline, so
// source times are divided by it; when it runs before setpts (blur-fill path),
// pass 1.
function subtitleFilters(
  subs: Subtitle[], trimStart: number, trimEnd: number, outH: number, fontPath: string, style: TextStyle,
  speed = 1, posX = 50, posY = 88, sizeMul = 1, outW = 0,
): string[] {
  if (!fontPath || !subs?.length) return [];
  const span = Math.max(0.1, (trimEnd - trimStart) / speed);
  const fontsize = Math.max(16, Math.round((outH || 1080) / 26 * (sizeMul > 0 ? sizeMul : 1)));
  // drawtext never wraps: a long Whisper segment rendered as one line runs
  // off both sides of a vertical frame. Re-chunk segments into lines that fit
  // ~88% of the width (avg glyph ≈ 0.56em for the bundled sans/bold faces).
  if (outW > 0) {
    const maxChars = Math.max(8, Math.floor((outW * 0.88) / (fontsize * 0.56)));
    subs = subs.flatMap((s) => chunkSubtitle(s, maxChars));
  }
  // Center the text block on the user's dragged (posX%, posY%) position —
  // drawtext's x/y are the top-left corner, so offset by half the measured
  // text size (text_w/text_h are ffmpeg's own built-in expression vars).
  const xPos = `(w*${(posX / 100).toFixed(4)})-text_w/2`;
  const yPos = `(h*${(posY / 100).toFixed(4)})-text_h/2`;
  const opts = styleDrawOptions(style, fontsize);
  const latin = styleFont(style);
  const out: string[] = [];
  for (const s of subs) {
    const st = Math.max(0, (s.start - trimStart) / speed);
    const en = Math.min(span, (s.end - trimStart) / speed);
    if (en <= st) continue;
    const esc = escapeDrawtext(s.text.replace(/\s+/g, " ").trim());
    if (!esc) continue;
    const font = fontfileOpt(fontForText(s.text, latin)); // CJK-aware
    out.push(
      `drawtext=${font}expansion=none:text=${esc}:x=${xPos}:y=${yPos}:fontsize=${fontsize}:${opts}:` +
      `enable='between(t,${st.toFixed(3)},${en.toFixed(3)})'`,
    );
  }
  return out;
}

export interface FfmpegArgs {
  inputPath: string;
  outputPath: string;
  srcW: number; srcH: number; fps: number;
  trimStart: number;
  trimEnd: number;
  duration: number;
  caption: string;
  captionX: number; captionY: number; captionSize: number;
  textStyle: TextStyle;
  aspect: AspectKey;
  cropX: number;
  cropKeys: CropKeyframe[];
  cropSmooth: boolean;
  zoom: number;
  zoomKeys: ZoomKeyframe[];
  zoomSmooth: boolean;
  blurFill: boolean;    // fit whole video into the aspect, pad with a blurred copy
  split?: SplitConfig | null; // multi-panel split screen (replaces crop/zoom; excludes blurFill)
  introText: string;
  outroText: string;
  subtitles: Subtitle[];
  subtitleStyle: SubtitleStyle;     // 'classic' (drawtext lines) | 'karaoke' | 'word' (animated, libass)
  subtitleHighlight: string;        // active-word colour for animated styles, RRGGBB
  subtitleX: number;                // 0-100, % of frame width — center of the text block
  subtitleY: number;                // 0-100, % of frame height
  subtitleSize: number;             // font-size multiplier, 1 = default
  subtitleLook?: SubtitleLook;      // animated styles: words/line, caps, outline, active word, pop
  musicPath: string;
  musicVolume: number;  // 0–100
  musicDuration: number; // seconds; 0 = entire clip
  videoVolume: number;  // 0–100
  speed: number;        // 0.5 | 0.75 | 1 | 1.25 | 1.5 | 2
  brightness: number;   // -50 to 50
  contrast: number;     // -50 to 50
  videoPitch: number;   // semitones, -12..+12
  saturation: number;   // -50 to 50
  colorFilter: ColorFilterKey;
  mirror: boolean;
  fadeIn: number;       // seconds (output timeline)
  fadeOut: number;      // seconds (output timeline)
  vignette: boolean;
  effects: EffectSegment[];     // timed effect windows (source-relative)
  volumeKeys: VolumeKeyframe[]; // keyframed volume (source-relative)
  loudnorm: boolean;            // loudness-normalize on export
  captionStart: number;         // caption window, source seconds (0 = open)
  captionEnd: number;
  assets: ProcessAsset[];       // image/video overlays + sound effects
  maxShortSide: number;         // per-plan cap on the shorter output side (0 = none)
  watermark: boolean;           // burn in the brand watermark (free tier)
  tempFiles: string[];          // scratch files (e.g. a generated .ass) for the caller to clean up
  clips?: Clip[];               // non-destructive timeline cuts (2+ = concat pre-pass; see below)
}

// One render job = one semaphore slot, even though a job may run several
// ffmpeg commands back to back (intro/outro cards, concat, music mix) — they
// are sequential within the job, so it never uses more than one core-set.
export function runFfmpeg(args: FfmpegArgs): Promise<void> {
  return withRenderSlot(async () => {
    // Non-destructive timeline: `clips` is the single source of truth for
    // "what to include" whenever present, at any length — callers no longer
    // need to special-case length===1 themselves.
    if (args.clips && args.clips.length === 1) {
      // One clip: exactly today's trim, just sourced from `clips[0]` instead
      // of a bare trimStart/trimEnd pair. Subtitles need no remap here
      // (mapSubtitlesToTimeline reduces to `t - sourceStart` for one clip,
      // identical to the existing `(t - trimStart)/speed` math). But
      // cropKeys/zoomKeys/effects/volumeKeys/captionStart/captionEnd are set
      // by the editor from `currentTime`, which is TIMELINE time (0-based) —
      // whereas this fast path still seeks the real input to `sourceStart`
      // and converts filter time via `t - trimStart` (== `t - sourceStart`
      // below), the same as before this feature existed. Since a lone clip's
      // timelineStart is always 0, timeline time -> source time is just
      // `+ sourceStart` — shift those arrays back so the existing math (which
      // assumes source-absolute keyframes) still lines up. A no-op whenever
      // sourceStart is 0 (the common untrimmed case), so this is a
      // correctness fix for the "trimmed single clip" case, not new behavior
      // for the byte-for-byte-unchanged common path.
      const [c] = args.clips;
      const shift = c.sourceStart;
      args = {
        ...args,
        trimStart: c.sourceStart,
        trimEnd: c.sourceEnd,
        // A lone segment's own volume folds into the overall video volume.
        videoVolume: (args.videoVolume * clipVolume(c)) / 100,
        cropKeys: args.cropKeys.map((k) => ({ ...k, time: k.time + shift })),
        zoomKeys: args.zoomKeys.map((k) => ({ ...k, time: k.time + shift })),
        effects: args.effects.map((e) => ({ ...e, start: e.start + shift, end: e.end + shift })),
        volumeKeys: args.volumeKeys.map((k) => ({ ...k, time: k.time + shift, v: (k.v * clipVolume(c)) / 100 })),
        captionStart: args.captionStart > 0 ? args.captionStart + shift : args.captionStart,
        captionEnd: args.captionEnd > 0 ? args.captionEnd + shift : args.captionEnd,
      };
    } else if (args.clips && args.clips.length >= 2) {
      // 2+ clips: concat the cuts into one working video FIRST, then run the
      // rest of this function completely unchanged against it with an
      // effective trimStart=0 — the crop/zoom/color/caption/subtitle/
      // watermark chain below has no idea a timeline was ever involved.
      const id = Date.now();
      const assembledPath = await assembleClips(args.inputPath, args.clips, os.tmpdir(), id);
      args.tempFiles.push(assembledPath);
      const duration = totalDuration(args.clips);
      args = {
        ...args,
        inputPath: assembledPath,
        trimStart: 0,
        trimEnd: duration,
        duration,
        subtitles: mapSubtitlesToTimeline(args.subtitles, args.clips),
      };
    }
    return runFfmpegNow(args);
  });
}

async function runFfmpegNow(args: FfmpegArgs): Promise<void> {
  const {
    inputPath, outputPath, srcW, srcH, fps, trimStart, trimEnd, duration,
    caption, captionX, captionY, captionSize, textStyle, aspect, cropX, cropKeys, cropSmooth, zoom, zoomKeys, zoomSmooth, blurFill,
    introText, outroText, subtitles, subtitleStyle, subtitleHighlight, subtitleX, subtitleY, subtitleSize, subtitleLook, musicPath, musicVolume, musicDuration, videoVolume, speed, brightness, contrast, videoPitch,
    saturation, colorFilter, mirror, fadeIn, fadeOut,
    vignette, effects, volumeKeys, loudnorm, captionStart, captionEnd, assets,
    maxShortSide, watermark, tempFiles, split,
  } = args;

  const outDur = Math.max(0, (trimEnd - trimStart) / speed);

  // Gate a drawtext caption to its time window. `tScale` follows the same
  // rule as subtitleFilters: the speed when the filter runs after setpts, 1
  // when it runs before.
  const captionWindow = (filter: string, tScale = 1): string => {
    if (captionStart <= 0 && captionEnd <= 0) return filter;
    const a = Math.max(0, (captionStart - trimStart) / tScale);
    const b = (captionEnd > 0 ? Math.max(a, (captionEnd - trimStart) / tScale) : Math.max(a, (trimEnd - trimStart) / tScale));
    return `${filter}:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;
  };

  // Optional cap on how long the music plays.
  const mtrim = musicDuration > 0 ? `atrim=0:${musicDuration.toFixed(3)},` : "";

  const fontPath  = getFontPath();
  const id        = Date.now();
  const tmpDir    = os.tmpdir();
  const hasIntro  = !!introText;
  const hasOutro  = !!outroText;
  const hasMusic  = !!musicPath;
  const hasAssets = assets.length > 0;
  const overlayAssets = assets.filter((a) => a.type !== "sound");
  const audioAssets   = assets.filter((a) => a.type !== "image" && a.hasAudio && a.volume > 0);
  const hasMod    = speed !== 1 || brightness !== 0 || contrast !== 0 || videoVolume !== 100 || videoPitch !== 0
    || saturation !== 0 || colorFilter !== "none" || mirror || fadeIn > 0 || fadeOut > 0
    || vignette || effects.length > 0 || volumeKeys.length > 0 || loudnorm;

  // ── Build video filter chain (crop / scale / zoom / eq / speed) ─────────────
  const { filters: builtV, outW, outH } = buildVideoFilters({
    srcW, srcH, fps, aspect, cropX, cropKeys, cropSmooth, zoom, zoomKeys, zoomSmooth,
    trimStart, brightness, contrast, speed,
    saturation, colorFilter, mirror, fadeIn, fadeOut, trimEnd,
    effects, vignette, maxShortSide, split,
  });
  // When the resolution cap kicks in for an uncropped clip, we must force the
  // downscale (the no-op path below otherwise keeps full source size).
  const capActive = maxShortSide > 0 && Math.min(srcW, srcH) > maxShortSide;
  const vFilters: string[] = [...builtV];
  // When the chain hasn't already scaled (original aspect, no zoom), normalize
  // dimensions here — before the caption so the text isn't rescaled. The server
  // always re-encodes, and libx264 rejects odd width/height, so we force even
  // dimensions (and the exact card size when concatenating intro/outro).
  const normalized = aspect !== "original" || zoom > 1.001 || (zoomKeys?.length ?? 0) > 0;
  if (!normalized) {
    vFilters.push(
      hasIntro || hasOutro || capActive ? `scale=${outW}:${outH}` : "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "setsar=1",
    );
  }
  // Word-level animated captions (karaoke / word-by-word) are burned via libass
  // from a generated ASS file. Subtitles always render server-side, so there's no
  // wasm-parity constraint. The filter sits post-setpts in every path, so the ASS
  // event times use the sped-up output timeline (tScale = speed). `classic` keeps
  // the original drawtext-per-segment path.
  const animatedSubs = subtitleStyle !== "classic" && subtitles.length > 0 && !!fontPath;
  let assPath = "";
  let assFilter: string | null = null;
  if (animatedSubs) {
    assPath = path.join(tmpDir, `vybe-sub-${id}.ass`);
    tempFiles.push(assPath);
    const assFont = assFontFor(textStyle);
    await writeFile(
      assPath,
      buildAss({
        segments: subtitles,
        mode: subtitleStyle === "word" ? "word" : "karaoke",
        trimStart, trimEnd, speed, outW, outH,
        style: textStyle,
        fontFamily: assFont.family,
        fontBold: assFont.bold,
        highlightHex: subtitleHighlight || "FFE000",
        posX: subtitleX, posY: subtitleY, sizeMul: subtitleSize,
        look: subtitleLook,
      }),
      "utf8",
    );
    // Validated escaping for the subtitles filter on Windows: forward slashes,
    // escaped drive colon, single-quoted. `fontsdir` points libass at the exact
    // font file we resolved above, so it doesn't need fontconfig to find it.
    const escPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
    const fontsDir = assFont.path ? `:fontsdir='${escPath(path.dirname(assFont.path))}'` : "";
    assFilter = `subtitles=f='${escPath(assPath)}'${fontsDir}`;
  }

  // Caption + subtitles are kept separate from the base chain so overlay
  // assets can slot in between — text always renders on top of overlays.
  // These sit after setpts in the chain, so their windows scale by speed.
  const textFilters: string[] = [];
  if (caption && fontPath) {
    textFilters.push(captionWindow(captionDrawtext(caption, captionX, captionY, outH, fontForText(caption, styleFont(textStyle)), captionSize, textStyle), speed));
  }
  // Subtitles: libass for animated styles, else timed drawtext per segment.
  if (assFilter) textFilters.push(assFilter);
  else textFilters.push(...subtitleFilters(subtitles, trimStart, trimEnd, outH, fontPath, textStyle, speed, subtitleX, subtitleY, subtitleSize, outW));
  // Brand watermark on top of everything (free tier).
  if (watermark && hasWatermarkAssets()) textFilters.push(watermarkGraph(outW, outH, bundled(BRAND_FONTS.bold)));
  const vAll = [...vFilters, ...textFilters];

  // ── Asset graph builders (shared by the export paths) ──────────────────────
  const AFMT = "aformat=sample_rates=44100:channel_layouts=stereo";

  // Chain image/video overlays onto `chainIn`. `tScale` converts source-relative
  // asset times to the timeline where the overlay runs: pass `speed` when the
  // chain is post-setpts (standard path), 1 when pre-setpts (blur-fill path).
  // Overlay width is scale% of the output frame, matching the preview.
  function overlayChainParts(chainIn: string, idxOf: (a: ProcessAsset) => number, tScale: number, tag: string) {
    const parts: string[] = [];
    let chain = chainIn;
    overlayAssets.forEach((a, i) => {
      const ii = idxOf(a);
      const t0 = Math.max(0, (a.timestamp - trimStart) / tScale);
      // A video plays its own length in real time; an image window lives on the
      // (possibly sped-up) output timeline.
      const win = a.type === "video" ? Math.max(0.05, a.duration) : Math.max(0.05, a.duration / tScale);
      const t1 = t0 + win;
      const w = Math.max(2, Math.round(outW * a.scale / 100));
      const pos = `(main_w*${(a.x / 100).toFixed(4)}):(main_h*${(a.y / 100).toFixed(4)})`;
      const en = `enable='between(t,${t0.toFixed(3)},${t1.toFixed(3)})'`;
      if (a.type === "video") {
        // Shift the asset's frames to start at t0; let the base keep playing
        // after the asset runs out.
        parts.push(`[${ii}:v]scale=${w}:-2,setpts=PTS-STARTPTS+${t0.toFixed(3)}/TB[${tag}s${i}]`);
        parts.push(`${chain}[${tag}s${i}]overlay=${pos}:eof_action=pass:${en}[${tag}o${i}]`);
      } else {
        parts.push(`[${ii}:v]scale=${w}:-2[${tag}s${i}]`);
        parts.push(`${chain}[${tag}s${i}]overlay=${pos}:${en}[${tag}o${i}]`);
      }
      chain = `[${tag}o${i}]`;
    });
    return { parts, chain };
  }

  // Sound effects + overlay-video audio, delayed to their output-timeline spot.
  function assetAudioParts(idxOf: (a: ProcessAsset) => number, tag: string) {
    const parts: string[] = [];
    const labels: string[] = [];
    audioAssets.forEach((a, i) => {
      const ii = idxOf(a);
      const delayMs = Math.max(0, Math.round(((a.timestamp - trimStart) / speed) * 1000));
      parts.push(
        `[${ii}:a]${AFMT},atrim=0:${Math.max(0.1, a.duration).toFixed(3)},` +
        `adelay=${delayMs}|${delayMs},volume=${(a.volume / 100).toFixed(3)}[${tag}${i}]`,
      );
      labels.push(`[${tag}${i}]`);
    });
    return { parts, labels };
  }

  // The full single-input complex graph: base filters → overlays → text, plus
  // main audio, optional music, and asset audio mixed together. Inputs must be
  // ordered main(0) → music (if withMusic) → assets.
  function applyAssetComplex(cmd: ReturnType<typeof ffmpeg>, withMusic: boolean) {
    let nextIdx = 1;
    const musicIdx = withMusic ? nextIdx++ : -1;
    const assetIdx = new Map<ProcessAsset, number>();
    for (const a of assets) assetIdx.set(a, nextIdx++);
    const idxOf = (a: ProcessAsset) => assetIdx.get(a)!;

    const parts: string[] = [];
    let chain = "[0:v]";
    if (vFilters.length > 0) { parts.push(`[0:v]${vFilters.join(",")}[vbase]`); chain = "[vbase]"; }
    const ov = overlayChainParts(chain, idxOf, speed, "ov");
    parts.push(...ov.parts); chain = ov.chain;
    if (textFilters.length > 0) { parts.push(`${chain}${textFilters.join(",")}[vtxt]`); chain = "[vtxt]"; }

    parts.push(`[0:a]${aFilters.length > 0 ? aFilters.join(",") + "," : ""}${AFMT}[amain]`);
    const aSrcs = ["[amain]"];
    if (musicIdx >= 0) {
      parts.push(`[${musicIdx}:a]${mtrim}volume=${(musicVolume / 100).toFixed(3)},atempo=${speed},${AFMT}[amusic]`);
      aSrcs.push("[amusic]");
    }
    const ax = assetAudioParts(idxOf, "asx");
    parts.push(...ax.parts); aSrcs.push(...ax.labels);
    let aMap = "[amain]";
    if (aSrcs.length > 1) {
      parts.push(`${aSrcs.join("")}amix=inputs=${aSrcs.length}:duration=first:dropout_transition=0[aout]`);
      aMap = "[aout]";
    }

    cmd.complexFilter(parts.join(";"));
    cmd.map(chain === "[0:v]" ? "0:v" : chain).map(aMap);
  }

  // ── Build audio filter chain for original track ─────────────────────────────
  // Pitch → volume (keyframes use clip-relative t, before atempo) → atempo →
  // fades (output timeline) → loudness normalization last.
  const aFilters: string[] = [...audioPitchFilters(videoPitch)];
  aFilters.push(...audioVolumeFilters(volumeKeys, trimStart, videoVolume));
  if (speed !== 1)         aFilters.push(`atempo=${speed}`);
  aFilters.push(...audioFadeFilters(fadeIn, fadeOut, outDur));
  if (loudnorm) aFilters.push("loudnorm=I=-16:TP=-1.5:LRA=11");

  function run(cmd: ReturnType<typeof ffmpeg>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      cmd
        .on("end", () => resolve())
        .on("error", (err: Error, _stdout: unknown, stderr: unknown) => {
          // fluent-ffmpeg's message is just "Conversion failed!" — surface the
          // tail of stderr, which has the actual reason.
          const tail = String(stderr ?? "").split("\n").filter(Boolean).slice(-8).join("\n");
          reject(new Error(tail ? `${err.message}\n${tail}` : err.message));
        })
        .run();
    });
  }

  // ── Blurred-fill mode — whole video centered over a blurred, zoomed copy ─────
  if (blurFill && aspect !== "original") {
    // Input options must precede further inputs — fluent attaches them to the
    // most recently added input.
    const cmd = ffmpeg(inputPath);
    if (trimStart > 0)      cmd.seekInput(trimStart);
    if (trimEnd < duration) cmd.inputOption(`-to ${trimEnd}`);
    if (hasMusic) cmd.input(musicPath);
    for (const a of assets) cmd.input(a.path);
    let blurNextIdx = 1;
    const blurMusicIdx = hasMusic ? blurNextIdx++ : -1;
    const blurAssetIdx = new Map<ProcessAsset, number>();
    for (const a of assets) blurAssetIdx.set(a, blurNextIdx++);
    const blurIdxOf = (a: ProcessAsset) => blurAssetIdx.get(a)!;

    const eqParts = [
      `brightness=${(brightness / 100).toFixed(3)}`,
      `contrast=${(1 + contrast / 100).toFixed(3)}`,
    ];
    if (saturation !== 0) eqParts.push(`saturation=${Math.max(0, 1 + saturation / 100).toFixed(3)}`);
    // Timed effect windows run pre-split so they hit both the blurred
    // background and the foreground (t is clip-relative, pre-setpts).
    const effectFilters = (effects ?? []).map((s) => {
      const fx = EFFECTS[s.type];
      if (!fx) return "";
      const a = Math.max(0, s.start - trimStart);
      const b = Math.max(a + 0.05, s.end - trimStart);
      return `${fx.ff}:enable='between(t,${a.toFixed(2)},${b.toFixed(2)})'`;
    }).filter(Boolean);
    const look = [
      (brightness !== 0 || contrast !== 0 || saturation !== 0) ? `eq=${eqParts.join(":")}` : "",
      COLOR_FILTERS[colorFilter].ff,
      ...effectFilters,
    ].filter(Boolean).join(",");
    const eq = look ? `${look},` : "";

    // Overlays + speed applied after the framed picture. Mirror runs before
    // text so captions stay readable; fades run last on the output timeline.
    const post: string[] = [];
    if (vignette) post.push("vignette=PI/4");
    if (mirror) post.push("hflip");
    if (caption && fontPath) post.push(captionWindow(captionDrawtext(caption, captionX, captionY, outH, fontForText(caption, styleFont(textStyle)), captionSize, textStyle)));
    // Classic subtitles burn pre-speed here; animated (libass) go in after setpts
    // below so their ASS times match the sped-up output timeline.
    if (!animatedSubs) post.push(...subtitleFilters(subtitles, trimStart, trimEnd, outH, fontPath, textStyle, 1, subtitleX, subtitleY, subtitleSize, outW));
    if (watermark && hasWatermarkAssets()) post.push(watermarkGraph(outW, outH, bundled(BRAND_FONTS.bold)));
    if (speed !== 1) post.push(`setpts=PTS/${speed}`);
    if (fadeIn > 0) post.push(`fade=t=in:st=0:d=${fadeIn.toFixed(2)}`);
    if (fadeOut > 0 && outDur > 0) post.push(`fade=t=out:st=${Math.max(0, outDur - fadeOut).toFixed(2)}:d=${fadeOut.toFixed(2)}`);
    if (assFilter) post.push(assFilter);
    const blurR = Math.max(8, Math.round(outW / 40));

    // Framed picture first, then overlay assets (clip-relative t, pre-setpts —
    // pass tScale 1), then the post chain (text, speed, fades) on top.
    const parts: string[] = [
      `[0:v]${eq}split=2[bg][fg]`,
      `[bg]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=${blurR}:1[bgb]`,
      `[fg]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fgs]`,
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vfr]`,
    ];
    const ov = overlayChainParts("[vfr]", blurIdxOf, 1, "bv");
    parts.push(...ov.parts);
    parts.push(`${ov.chain}${post.length ? post.join(",") : "null"}[vout]`);

    const aF: string[] = [...audioPitchFilters(videoPitch)];
    aF.push(...audioVolumeFilters(volumeKeys, trimStart, videoVolume));
    if (speed !== 1)         aF.push(`atempo=${speed}`);
    aF.push(...audioFadeFilters(fadeIn, fadeOut, outDur));
    if (loudnorm) aF.push("loudnorm=I=-16:TP=-1.5:LRA=11");

    // Always route audio through the graph so both maps are graph labels
    // (mapping a raw 0:a stream alongside -filter_complex is rejected by ffmpeg).
    parts.push(`[0:a]${aF.length > 0 ? aF.join(",") + "," : ""}${AFMT}[va]`);
    const aSrcs = ["[va]"];
    if (blurMusicIdx >= 0) {
      parts.push(`[${blurMusicIdx}:a]${mtrim}volume=${(musicVolume / 100).toFixed(3)},atempo=${speed},${AFMT}[ma]`);
      aSrcs.push("[ma]");
    }
    const ax = assetAudioParts(blurIdxOf, "bsx");
    parts.push(...ax.parts); aSrcs.push(...ax.labels);
    let aMap = "[va]";
    if (aSrcs.length > 1) {
      parts.push(`${aSrcs.join("")}amix=inputs=${aSrcs.length}:duration=first:dropout_transition=0[aout]`);
      aMap = "[aout]";
    }

    cmd.complexFilter(parts.join(";"));
    cmd.map("[vout]").map(aMap);
    cmd.outputOptions(["-c:v libx264", "-preset fast", "-crf 22", "-c:a aac", "-ar 44100", "-pix_fmt yuv420p"]);
    await run(cmd.output(outputPath));
    return;
  }

  // ── No intro/outro — single-pass command ───────────────────────────────────
  if (!hasIntro && !hasOutro) {
    // Input options must be applied before further inputs are added — fluent
    // attaches them to the most recently added input.
    const cmd = ffmpeg(inputPath);
    if (trimStart > 0)        cmd.seekInput(trimStart);
    if (trimEnd < duration)   cmd.inputOption(`-to ${trimEnd}`);
    if (hasMusic) cmd.input(musicPath);
    for (const a of assets) cmd.input(a.path);

    if (hasMusic || hasAssets) {
      applyAssetComplex(cmd, hasMusic);
    } else if (vAll.length > 0 || hasMod) {
      if (vAll.length > 0) cmd.videoFilters(vAll);
      if (aFilters.length > 0) cmd.audioFilters(aFilters);
    }

    cmd.outputOptions(["-c:v libx264", "-preset fast", "-crf 22", "-c:a aac", "-ar 44100", "-pix_fmt yuv420p"]);
    await run(cmd.output(outputPath));
    return;
  }

  // ── With intro/outro — build segments then concat ──────────────────────────

  // Step 1: main clip with all video + audio filters (and assets) applied
  const mainPath = path.join(tmpDir, `vybe-main-${id}.mp4`);
  await (() => {
    const cmd = ffmpeg(inputPath);
    if (trimStart > 0)      cmd.seekInput(trimStart);
    if (trimEnd < duration) cmd.inputOption(`-to ${trimEnd}`);
    if (hasAssets) {
      for (const a of assets) cmd.input(a.path);
      applyAssetComplex(cmd, false); // music is mixed after the concat step
    } else {
      if (vAll.length > 0) cmd.videoFilters(vAll);
      if (aFilters.length > 0) cmd.audioFilters(aFilters);
    }
    return run(cmd.outputOptions(["-c:v libx264", "-preset fast", "-crf 22", "-c:a aac", "-ar 44100", "-pix_fmt yuv420p"]).output(mainPath));
  })();

  // Card dimensions = the main clip's output dimensions so concat lines up.
  const w = outW;
  const h = outH;
  const cardDuration = 3;

  async function makeCard(text: string, suffix: string): Promise<string> {
    const cardPath = path.join(tmpDir, `vybe-card-${id}-${suffix}.mp4`);
    const cardFont = fontForText(text, fontPath);
    const font = fontfileOpt(cardFont);
    await run(
      ffmpeg()
        .input(`color=c=black:s=${w}x${h}:d=${cardDuration}`)
        .inputFormat("lavfi")
        .input("anullsrc=channel_layout=stereo:sample_rate=44100")
        .inputFormat("lavfi")
        .videoFilters(`drawtext=${font}expansion=none:text=${escapeDrawtext(text)}:x=(w-text_w)/2:y=(h-text_h)/2:fontsize=${Math.max(28, Math.round(h / 16))}:fontcolor=white`)
        .outputOptions(["-c:v libx264", "-preset fast", "-crf 22", "-c:a aac", "-ar 44100", "-pix_fmt yuv420p", "-t", String(cardDuration)])
        .output(cardPath)
    );
    return cardPath;
  }

  const segments: string[] = [];
  if (hasIntro) segments.push(await makeCard(introText, "intro"));
  segments.push(mainPath);
  if (hasOutro) segments.push(await makeCard(outroText, "outro"));

  const concatPath = hasMusic ? path.join(tmpDir, `vybe-concat-${id}.mp4`) : outputPath;
  await (() => {
    const cmd = ffmpeg();
    segments.forEach((s) => cmd.input(s));
    const streamRefs = segments.map((_, i) => `[${i}:v][${i}:a]`).join("");
    const filterStr  = `${streamRefs}concat=n=${segments.length}:v=1:a=1[vcat][acat]`;
    return run(
      cmd.complexFilter(filterStr)
        .map("[vcat]").map("[acat]")
        .outputOptions(["-c:v libx264", "-preset fast", "-crf 22", "-c:a aac", "-ar 44100", "-pix_fmt yuv420p"])
        .output(concatPath)
    );
  })();

  if (hasMusic) {
    await run(
      ffmpeg(concatPath)
        .input(musicPath)
        .complexFilter([
          `[0:a]volume=${(videoVolume / 100).toFixed(3)}[va]`,
          `[1:a]${mtrim}volume=${(musicVolume / 100).toFixed(3)},atempo=${speed}[ma]`,
          "[va][ma]amix=inputs=2:duration=first:dropout_transition=0[aout]",
        ].join(";"))
        .map("0:v").map("[aout]")
        .outputOptions(["-c:v copy", "-c:a aac", "-ar 44100"])
        .output(outputPath)
    );
    await unlink(concatPath).catch(() => {});
  }

  await Promise.all(segments.map((s) => unlink(s).catch(() => {})));
}

// Everything renderClip accepts. Mirrors the editor's export payload; the
// Auto-Pilot engine passes the same shape from a saved template.
export type RenderClipInput = {
  userId: number;
  recordKind?: "export" | "autopilot";
  countsQuota?: boolean;
  videoUrl: string;
  trimStart?: number;   // legacy single-clip trim (kept for back-compat: Auto-Pilot, schedule-vod)
  trimEnd?: number;
  clips?: Clip[];       // preferred: non-destructive timeline cuts from the editor
  duration?: number;
  caption?: string;
  captionX?: number;
  captionY?: number;
  captionSize?: number;
  textStyle?: Partial<TextStyle>;
  cropAspect?: string;
  cropVertical?: boolean;
  cropFill?: string;    // "crop" | "blur" | "split"
  split?: unknown;      // SplitConfig when cropFill === "split" (sanitized below)
  cropX?: number;
  cropKeys?: CropKeyframe[];
  cropSmooth?: boolean;
  zoom?: number;
  zoomKeys?: ZoomKeyframe[];
  zoomSmooth?: boolean;
  introText?: string;
  outroText?: string;
  subtitles?: Subtitle[];
  subtitleStyle?: SubtitleStyle;
  subtitleHighlight?: string;
  subtitleX?: number;
  subtitleY?: number;
  subtitleSize?: number;
  subtitleLook?: unknown;   // SubtitleLook (sanitized below)
  srcW?: number;
  srcH?: number;
  fps?: number;
  title?: string;
  musicUrl?: string;
  musicVolume?: number;
  musicDuration?: number;
  videoVolume?: number;
  speed?: number;
  brightness?: number;
  contrast?: number;
  videoPitch?: number;
  saturation?: number;
  colorFilter?: string;
  mirror?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  vignette?: boolean;
  effects?: unknown[];
  volumeKeys?: unknown[];
  loudnorm?: boolean;
  captionStart?: number;
  captionEnd?: number;
  assets?: unknown[];
};

// Resolve the source + assets, render through the ffmpeg pipeline, store the
// output, and ledger it. Throws on any failure; callers map to HTTP/log.
export async function renderClip(input: RenderClipInput): Promise<{ url: string }> {
  const {
    userId,
    recordKind = "export",
    countsQuota = false,
    videoUrl,
    trimStart    = 0,
    trimEnd,
    clips,
    duration,
    caption      = "",
    captionX     = 50,
    captionY     = 88,
    captionSize  = 1,
    textStyle    = DEFAULT_TEXT_STYLE,
    cropAspect,
    cropVertical = false, // legacy fallback
    cropFill     = "crop", // "crop" | "blur" | "split"
    split: rawSplit,
    cropX        = 50,
    cropKeys     = [],
    cropSmooth   = true,
    zoom         = 1,
    zoomKeys     = [],
    zoomSmooth   = true,
    introText    = "",
    outroText    = "",
    subtitles    = [],
    subtitleStyle = "classic",
    subtitleHighlight = "FFE000",
    subtitleX    = 50,
    subtitleY    = 88,
    subtitleSize = 1,
    subtitleLook,
    srcW         = 1280,
    srcH         = 720,
    fps          = 30,
    title        = "clip",
    musicUrl     = "",
    musicVolume  = 80,
    musicDuration = 0,
    videoVolume  = 100,
    speed        = 1,
    brightness   = 0,
    contrast     = 0,
    videoPitch   = 0,
    saturation   = 0,
    colorFilter  = "none",
    mirror       = false,
    fadeIn       = 0,
    fadeOut      = 0,
    vignette     = false,
    effects      = [],
    volumeKeys   = [],
    loudnorm     = false,
    captionStart = 0,
    captionEnd   = 0,
    assets       = [],
  } = input;

  if (!videoUrl) throw new Error("videoUrl is required");

  // Per-plan export limits: free exports are capped to 720p and watermarked.
  const limits = limitsFor(await getUserPlan(userId));
  const watermark = await requiresWatermark(userId);

  const aspect: AspectKey =
    (cropAspect && cropAspect in ASPECTS) ? cropAspect as AspectKey
    : cropVertical ? "9:16" : "original";

  const id         = Date.now();
  const inputPath  = path.join(os.tmpdir(), `vybe-input-${id}.mp4`);
  const musicPath  = musicUrl ? path.join(os.tmpdir(), `vybe-music-${id}.mp3`) : "";
  const safeName   = (title as string).replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40);
  const outputPath = path.join(os.tmpdir(), `clip-${safeName}-${id}.mp4`);
  const assetPaths: string[] = [];
  const tempFiles: string[] = []; // scratch files created mid-render (e.g. .ass)

  try {
    await resolveToTempFile(videoUrl as string, inputPath);
    await ensureAudioTrack(inputPath);

    // Split screen: download each screen's own video (webcam, second clip…).
    // `path` is set only here — sanitizeSplit drops any client-sent path.
    const split = cropFill === "split" && aspect !== "original" ? sanitizeSplit(rawSplit) : null;
    if (split) {
      for (let i = 0; i < split.panels.length; i++) {
        const m = split.panels[i].media;
        if (!m) continue;
        const p = path.join(os.tmpdir(), `vybe-split-${id}-${i}.mp4`);
        await resolveToTempFile(m.url, p);
        assetPaths.push(p); // cleaned up with the other downloads
        m.path = p;
      }
    }
    if (musicUrl) await resolveToTempFile(musicUrl as string, musicPath);

    // ── Overlay/sound assets: download each, probe videos for audio ──
    type IncomingAsset = {
      type?: string; url?: string; timestamp?: number; duration?: number;
      volume?: number; x?: number; y?: number; scale?: number;
    };
    const assetDefs = (Array.isArray(assets) ? assets : [])
      .filter((a): a is IncomingAsset => !!a && ["image", "video", "sound"].includes(String((a as IncomingAsset).type)) && typeof (a as IncomingAsset).url === "string" && !!(a as IncomingAsset).url)
      .slice(0, 12);
    const resolvedAssets: ProcessAsset[] = [];
    for (let i = 0; i < assetDefs.length; i++) {
      const a = assetDefs[i];
      const cleanUrl = String(a.url).split(/[?#]/)[0];
      const ext = (cleanUrl.match(/\.([a-zA-Z0-9]{1,5})$/)?.[1]
        ?? (a.type === "image" ? "png" : a.type === "sound" ? "mp3" : "mp4")).toLowerCase();
      const p = path.join(os.tmpdir(), `vybe-asset-${id}-${i}.${ext}`);
      await resolveToTempFile(String(a.url), p);
      assetPaths.push(p);
      resolvedAssets.push({
        type: a.type as ProcessAsset["type"],
        path: p,
        hasAudio: a.type === "sound" ? true : a.type === "video" ? await hasAudioStream(p) : false,
        timestamp: Math.max(0, Number(a.timestamp) || 0),
        duration: Math.min(120, Math.max(0.1, Number(a.duration) || 3)),
        volume: Math.max(0, Math.min(200, Number(a.volume ?? 80))),
        x: Math.max(0, Math.min(100, Number(a.x ?? 5))),
        y: Math.max(0, Math.min(100, Number(a.y ?? 5))),
        scale: Math.max(1, Math.min(200, Number(a.scale ?? 25))),
      });
    }

    // Source dimensions + frame rate come from the caller (detected at load),
    // so the server needs no ffprobe binary.
    const effectiveDuration = (duration && duration > 0) ? duration : (trimEnd && trimEnd > 0) ? trimEnd : 60;
    const effectiveTrimEnd  = (trimEnd  && trimEnd  > 0) ? trimEnd  : effectiveDuration;

    // Non-destructive timeline: prefer `clips` (the editor's cut list) over the
    // legacy flat `trimStart`/`trimEnd`. Absence of `clips` (Auto-Pilot,
    // schedule-vod, or any pre-timeline caller) falls back to a single implicit
    // clip covering [trimStart, effectiveTrimEnd] — the exact same range those
    // callers already pass — so they need zero changes.
    type IncomingClip = { id?: unknown; sourceStart?: unknown; sourceEnd?: unknown; volume?: unknown };
    const rawClips = (Array.isArray(clips) ? clips : []) as IncomingClip[];
    const validClips: Clip[] = rawClips
      .filter((c): c is IncomingClip & { sourceStart: number; sourceEnd: number } =>
        !!c && typeof c.sourceStart === "number" && typeof c.sourceEnd === "number" && c.sourceEnd > c.sourceStart)
      .slice(0, 50)
      .map((c, i) => ({
        id: typeof c.id === "string" && c.id ? c.id : `clip-${i}`,
        sourceStart: Math.max(0, c.sourceStart),
        sourceEnd: c.sourceEnd,
        timelineStart: 0,
        duration: 0,
        ...(typeof c.volume === "number" && isFinite(c.volume) ? { volume: Math.max(0, Math.min(200, c.volume)) } : {}),
      }));
    const effectiveClips: Clip[] = relayoutClips(
      validClips.length > 0 ? validClips : [{ id: "legacy", sourceStart: trimStart, sourceEnd: effectiveTrimEnd, timelineStart: 0, duration: 0 }],
    );

    await runFfmpeg({
      inputPath, outputPath, srcW, srcH, fps,
      trimStart, trimEnd: effectiveTrimEnd, duration: effectiveDuration,
      // runFfmpeg() derives the actual trimStart/trimEnd (and, for 2+ clips,
      // the assembled working video) from `clips` whenever present — the
      // trimStart/trimEnd above are only the fallback for legacy callers with
      // no `clips` at all.
      clips: effectiveClips,
      caption, captionX, captionY, captionSize,
      textStyle: {
        font: isFontKey(textStyle?.font) ? textStyle.font : "bold",
        color: String(textStyle?.color ?? "FFFFFF"),
        template: (textStyle?.template ?? "outline"),
      } as TextStyle,
      aspect, cropX, cropKeys: cropKeys as CropKeyframe[], cropSmooth,
      zoom, zoomKeys: zoomKeys as ZoomKeyframe[], zoomSmooth,
      blurFill: cropFill === "blur" && aspect !== "original",
      split,
      introText, outroText,
      subtitles: subtitles as Subtitle[],
      subtitleStyle: (["classic", "karaoke", "word"].includes(String(subtitleStyle)) ? subtitleStyle : "classic") as SubtitleStyle,
      subtitleHighlight: String(subtitleHighlight ?? "FFE000").replace(/[^0-9a-fA-F]/g, "").slice(0, 6) || "FFE000",
      subtitleX: Math.max(0, Math.min(100, Number(subtitleX) || 50)),
      subtitleY: Math.max(0, Math.min(100, Number(subtitleY) || 88)),
      subtitleSize: Math.max(0.4, Math.min(3, Number(subtitleSize) || 1)),
      subtitleLook: sanitizeSubtitleLook(subtitleLook),
      tempFiles,
      musicPath, musicVolume, musicDuration, videoVolume,
      speed, brightness, contrast, videoPitch,
      saturation: Math.max(-50, Math.min(50, Number(saturation) || 0)),
      colorFilter: (COLOR_FILTER_KEYS as string[]).includes(colorFilter) ? colorFilter as ColorFilterKey : "none",
      mirror: mirror === true,
      fadeIn: Math.max(0, Math.min(5, Number(fadeIn) || 0)),
      fadeOut: Math.max(0, Math.min(5, Number(fadeOut) || 0)),
      vignette: vignette === true,
      effects: (Array.isArray(effects) ? effects : [])
        .filter((s): s is EffectSegment => !!s && (EFFECT_KEYS as string[]).includes(String((s as EffectSegment).type))
          && typeof (s as EffectSegment).start === "number" && typeof (s as EffectSegment).end === "number" && (s as EffectSegment).end > (s as EffectSegment).start)
        .slice(0, 30),
      volumeKeys: (Array.isArray(volumeKeys) ? volumeKeys : [])
        .filter((k): k is { time: number; v: number } => !!k && typeof (k as { time?: unknown }).time === "number" && typeof (k as { v?: unknown }).v === "number")
        .map((k) => ({ time: Math.max(0, k.time), v: Math.max(0, Math.min(200, k.v)) }))
        .slice(0, 50),
      loudnorm: loudnorm === true,
      captionStart: Math.max(0, Number(captionStart) || 0),
      captionEnd: Math.max(0, Number(captionEnd) || 0),
      assets: resolvedAssets,
      maxShortSide: limits.maxShortSide,
      watermark,
    });

    const outputFilename = `clip-${safeName}-${id}.mp4`;
    const url = await storeTempFile(outputPath, outputFilename, "video/mp4");
    await recordClip({ userId, url, kind: recordKind, countsQuota });
    // Leaderboard eligibility: remember this export carries the watermark
    // (the clips ledger row above is deleted with the free-tier TTL).
    if (watermark && hasWatermarkAssets()) await recordWatermarkedExport(userId, url);
    return { url };
  } finally {
    await unlink(inputPath).catch(() => {});
    if (musicPath) await unlink(musicPath).catch(() => {});
    await Promise.all(assetPaths.map((p) => unlink(p).catch(() => {})));
    await Promise.all(tempFiles.map((p) => unlink(p).catch(() => {})));
    await unlink(outputPath).catch(() => {});
  }
}
