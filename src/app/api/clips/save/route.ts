import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { writeFile } from "fs/promises";
import path from "path";
import os from "os";
import { storeTempFile } from "@/lib/storage";
import { getServerSession } from "@/lib/auth";
import { checkClipQuota, quotaMessage, recordClip } from "@/lib/plan";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create: createYtDlp } = require("yt-dlp-exec") as {
  create: (binPath: string) => (url: string, flags: Record<string, unknown>) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg") as { path: string };

const ytDlpBin = path.join(
  process.cwd(),
  "node_modules",
  "yt-dlp-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);
const ytDlp = createYtDlp(ytDlpBin);

function refererFor(url: string): string {
  if (url.includes("kick.com"))                                    return "https://kick.com/";
  if (url.includes("tiktok.com"))                                  return "https://www.tiktok.com/";
  if (url.includes("youtube.com") || url.includes("youtu.be"))    return "https://www.youtube.com/";
  if (url.includes("instagram.com"))                               return "https://www.instagram.com/";
  return "https://clips.twitch.tv/";
}

async function tryDirectDownload(videoUrl: string, tmpPath: string, referer: string): Promise<boolean> {
  if (!videoUrl) return false;
  try {
    const res = await axios.get(videoUrl, {
      responseType: "arraybuffer",
      timeout: 60_000,
      maxContentLength: 500 * 1024 * 1024,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": referer,
        "Accept": "video/mp4,video/*,*/*",
      },
    });
    const buffer = Buffer.from(res.data as ArrayBuffer);
    if (!buffer.length) return false;
    await writeFile(tmpPath, buffer);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { videoUrl, clipPageUrl, title } = await req.json();
  if (!videoUrl && !clipPageUrl) return NextResponse.json({ error: "videoUrl or clipPageUrl required" }, { status: 400 });

  const quota = await checkClipQuota(session.userId);
  if (!quota.allowed) return NextResponse.json({ error: quotaMessage(quota) }, { status: 403 });

  const res = await handleSave(videoUrl, clipPageUrl, title);
  try {
    if (res.status === 200) {
      const body = (await res.clone().json()) as { url?: string };
      if (body?.url) await recordClip({ userId: session.userId, url: body.url, kind: "import", countsQuota: true });
    }
  } catch { /* recording is best-effort */ }
  return res;
}

async function handleSave(
  videoUrl: string | undefined,
  clipPageUrl: string | undefined,
  title: string | undefined,
): Promise<NextResponse> {
  const safe = (title ?? "clip").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
  const base = `vybe-${Date.now()}-${safe}`;
  const tmpPath = path.join(os.tmpdir(), `${base}.mp4`);

  const pageUrl = clipPageUrl ?? videoUrl ?? "";
  const referer = refererFor(pageUrl);
  const isTikTok = pageUrl.includes("tiktok.com");

  try {
    // Fast path: direct HTTP download — skip for TikTok whose CDN requires session cookies
    if (videoUrl && !isTikTok) {
      const ok = await tryDirectDownload(videoUrl, tmpPath, referer);
      if (ok) {
        const url = await storeTempFile(tmpPath, `${base}.mp4`, "video/mp4");
        return NextResponse.json({ url });
      }
    }

    // Slow path: yt-dlp for platforms that sign/protect their streams
    if (clipPageUrl) {
      const ytDlpOpts: Record<string, unknown> = {
        output: tmpPath,
        format: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        mergeOutputFormat: "mp4",
        recodeVideo: "mp4",
        ffmpegLocation: ffmpegPath,
        noCheckCertificates: true,
        noWarnings: true,
      };
      if (isTikTok) {
        ytDlpOpts.addHeader = "Referer:https://www.tiktok.com/";
      }
      try {
        await ytDlp(clipPageUrl, ytDlpOpts);
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const fullErr = (e.stderr || e.message || String(err)).trim();
        const detail = fullErr.split("\n").filter(Boolean)[0];
        console.error("[clips/save] yt-dlp failed:", fullErr);
        return NextResponse.json({ error: `Download failed: ${detail}` }, { status: 502 });
      }

      const { existsSync, readdirSync } = await import("fs");
      let usedPath = tmpPath;
      if (!existsSync(tmpPath)) {
        const dir = path.dirname(tmpPath);
        const match = readdirSync(dir).find((f) => f.startsWith(base));
        if (!match) return NextResponse.json({ error: "Download completed but file not found" }, { status: 502 });
        usedPath = path.join(dir, match);
      }

      const url = await storeTempFile(usedPath, `${base}.mp4`, "video/mp4");
      return NextResponse.json({ url });
    }

    return NextResponse.json({ error: "Could not download video" }, { status: 502 });
  } catch (err) {
    const e = err as { message?: string };
    return NextResponse.json({ error: e.message ?? "Download failed" }, { status: 500 });
  } finally {
    const { unlink } = await import("fs/promises");
    await unlink(tmpPath).catch(() => {});
  }
}
