// Multi-clip timeline assembly — concatenates a Clip[] (cuts over the ONE
// original source video) into a single working video, in one ffmpeg pass,
// before the existing crop/zoom/color/caption/subtitle/watermark pipeline in
// clip-render.ts runs unchanged against the assembled result (with an
// effective trimStart=0). Generalizes the same trim+atrim+concat pattern
// already used by the auto-tighten kept-range re-render
// (src/app/api/clips/tighten/route.ts:136-152), just driven by user-authored
// Clip ranges instead of silence-detected ones.
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import { clipVolume, type Clip } from "./timeline";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

function run(cmd: ReturnType<typeof ffmpeg>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    cmd
      .on("end", () => resolve())
      .on("error", (err: Error, _stdout: unknown, stderr: unknown) => {
        const tail = String(stderr ?? "").split("\n").filter(Boolean).slice(-8).join("\n");
        reject(new Error(tail ? `${err.message}\n${tail}` : err.message));
      })
      .run();
  });
}

// Cuts each clip's [sourceStart, sourceEnd] window out of `inputPath` and
// concatenates them (video + audio) into one mp4, in a single filter_complex
// pass. Returns the assembled file's path — its duration is the sum of the
// clips' durations (computed arithmetically by the caller via
// totalDuration(clips); no need to probe the output).
export async function assembleClips(inputPath: string, clips: Clip[], tmpDir: string, id: number): Promise<string> {
  const outPath = path.join(tmpDir, `vybe-assembled-${id}.mp4`);
  const parts: string[] = [];
  clips.forEach((c, i) => {
    parts.push(`[0:v]trim=${c.sourceStart}:${c.sourceEnd},setpts=PTS-STARTPTS[v${i}]`);
    // Per-segment volume is applied to that cut only, before the concat.
    const vol = clipVolume(c);
    const gain = vol === 100 ? "" : `,volume=${(vol / 100).toFixed(3)}`;
    parts.push(`[0:a]atrim=${c.sourceStart}:${c.sourceEnd},asetpts=PTS-STARTPTS${gain}[a${i}]`);
  });
  const streamRefs = clips.map((_, i) => `[v${i}][a${i}]`).join("");
  parts.push(`${streamRefs}concat=n=${clips.length}:v=1:a=1[v][a]`);

  await run(
    ffmpeg(inputPath)
      .complexFilter(parts.join(";"))
      .map("[v]").map("[a]")
      .outputOptions(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100"])
      .output(outPath),
  );
  return outPath;
}
