import path from "path";
import os from "os";
import { readFile, unlink, writeFile } from "fs/promises";
import { runFfmpeg } from "./clip-render";
import { captionLook, type ClipStyle } from "./clip-style";

// "Did we copy it right?" — re-create a reference frame's captions with the
// extracted ClipStyle, using the REAL export renderer (libass, same fonts), on
// a blurred copy of that frame. The analyzer then shows the model the original
// next to the re-creation and lets it correct the caption fields.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

const tmp = (ext: string) => path.join(os.tmpdir(), `vybe-verify-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);

async function ff(args: string[]) {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  await promisify(execFile)(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 60_000 });
}

/**
 * Render `text` as the style's subtitles over a blurred `still` (JPEG) and
 * return the frame where the middle word is the active one. Null on failure.
 */
export async function recreateCaptionFrame(still: Buffer, style: ClipStyle, text: string): Promise<Buffer | null> {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 12);
  if (words.length === 0) return null;
  const stillPath = tmp("jpg"), clipPath = tmp("mp4"), outPath = tmp("mp4"), framePath = tmp("jpg");
  const DUR = 1.2;
  try {
    await writeFile(stillPath, still);
    // 1.2s video of the blurred still (even dims for x264) with a silent track.
    await ff([
      "-loop", "1", "-i", stillPath, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-t", String(DUR), "-r", "30",
      "-vf", "gblur=sigma=22,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipPath,
    ]);
    const probe = await (async () => {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      try { await promisify(execFile)(ffmpegPath, ["-hide_banner", "-i", clipPath]); return ""; }
      catch (e) { return String((e as { stderr?: string }).stderr ?? ""); }
    })();
    const dim = probe.match(/Video:.*?[, ](\d{2,5})x(\d{2,5})/);
    const w = dim ? Number(dim[1]) : 720, h = dim ? Number(dim[2]) : 1280;

    // Evenly timed words; the middle word is active at the sampled instant.
    const per = DUR / words.length;
    const mid = Math.floor(words.length / 2);
    const animated = style.captions.animation !== "classic";
    await runFfmpeg({
      inputPath: clipPath, outputPath: outPath, srcW: w, srcH: h, fps: 30,
      trimStart: 0, trimEnd: DUR, duration: DUR,
      caption: "", captionX: 50, captionY: 12, captionSize: 1,
      textStyle: { font: style.captions.font, color: style.captions.color, template: style.captions.template },
      aspect: "original", cropX: 50, cropKeys: [], cropSmooth: true, zoom: 1, zoomKeys: [], zoomSmooth: true, blurFill: false,
      introText: "", outroText: "",
      subtitles: [{ id: "v", start: 0, end: DUR, text: words.join(" "), words: words.map((word, i) => ({ word, start: i * per, end: (i + 1) * per })) }],
      subtitleStyle: animated ? style.captions.animation : "classic",
      subtitleHighlight: style.captions.highlight,
      subtitleX: 50, subtitleY: style.captions.positionY, subtitleSize: style.captions.size,
      subtitleLook: captionLook(style),
      musicPath: "", musicVolume: 0, musicDuration: 0, videoVolume: 100, speed: 1, brightness: 0, contrast: 0, videoPitch: 0,
      saturation: 0, colorFilter: "none", mirror: false, fadeIn: 0, fadeOut: 0, vignette: false,
      effects: [], volumeKeys: [], loudnorm: false, captionStart: 0, captionEnd: 0,
      assets: [], maxShortSide: 0, watermark: false, tempFiles: [],
    });
    await ff(["-ss", ((mid + 0.5) * per).toFixed(2), "-i", outPath, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "4", framePath]);
    return await readFile(framePath);
  } catch (err) {
    console.error("[style-verify] recreate failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    for (const p of [stillPath, clipPath, outPath, framePath]) await unlink(p).catch(() => {});
  }
}
