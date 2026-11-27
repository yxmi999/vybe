// Desktop app only: self-check of the bundled tools — actually runs the
// ffmpeg and yt-dlp binaries the clipper spawns and reports their versions.
// Used by the shell's smoke test and for diagnosing a broken install.
// Guarded by the shell's per-launch secret; 404 everywhere else.
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { dataDir, isDesktopControlRequest } from "@/lib/desktop";

const run = promisify(execFile);

async function version(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(bin, args, { timeout: 20_000, windowsHide: true });
    return stdout.split(/\r?\n/)[0].trim().slice(0, 120);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!isDesktopControlRequest(req)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let ffmpegPath = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ffmpegPath = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
  } catch (e) {
    return NextResponse.json({ ok: false, ffmpeg: null, error: String(e) });
  }
  // The JS wrappers must load too (with all their dependencies), not just
  // the binaries — the clip routes require() them exactly like this.
  const modules: Record<string, string> = {};
  for (const [name, load] of [
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ["yt-dlp-exec", () => require("yt-dlp-exec")],
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ["fluent-ffmpeg", () => require("fluent-ffmpeg")],
  ] as const) {
    try { load(); modules[name] = "ok"; } catch (e) { modules[name] = String(e instanceof Error ? e.message : e).slice(0, 160); }
  }
  const ytDlpPath = path.join(process.cwd(), "node_modules", "yt-dlp-exec", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const [ffmpeg, ytDlp] = await Promise.all([version(ffmpegPath, ["-version"]), version(ytDlpPath, ["--version"])]);
  const modulesOk = Object.values(modules).every((v) => v === "ok");
  return NextResponse.json({ ok: !!ffmpeg && !!ytDlp && modulesOk, ffmpeg, ytDlp, modules, dataDir: dataDir() });
}
