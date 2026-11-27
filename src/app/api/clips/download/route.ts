import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { existsSync, mkdirSync, readdirSync } from "fs";
import { readFile, rm } from "fs/promises";
import { getServerSession } from "@/lib/auth";
import { uploadsDir, uploadFilePath } from "@/lib/desktop";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { create: createYtDlp } = require("yt-dlp-exec") as {
  create: (binPath: string) => (url: string, flags: Record<string, unknown>) => Promise<unknown>;
};

const ytDlpBin = path.join(
  process.cwd(),
  "node_modules",
  "yt-dlp-exec",
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);
const ytDlp = createYtDlp(ytDlpBin);

function ensureUploads(): string {
  const dir = uploadsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Download via yt-dlp (Twitch/Kick page URLs) and stream back to browser
async function downloadViaYtDlp(pageUrl: string): Promise<Response> {
  const uploadDir = ensureUploads();
  const base = `dl-${Date.now()}`;
  const outPath = path.join(uploadDir, `${base}.mp4`);

  try {
    await ytDlp(pageUrl, {
      output: outPath,
      format: "best[ext=mp4]/best",
      mergeOutputFormat: "mp4",
      noCheckCertificates: true,
      noWarnings: true,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || String(err)).split("\n").filter(Boolean)[0];
    return NextResponse.json({ error: `Download failed: ${detail}` }, { status: 502 });
  }

  // Find the file (yt-dlp might pick a different extension)
  let filename = `${base}.mp4`;
  if (!existsSync(outPath)) {
    const match = readdirSync(uploadDir).find((f) => f.startsWith(base));
    if (!match) return NextResponse.json({ error: "Download completed but file not found" }, { status: 502 });
    filename = match;
  }

  const filePath = path.join(uploadDir, filename);
  const buffer = await readFile(filePath);
  const slug = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "clip";

  // Temp download only exists to stream back — don't let it pile up on disk
  for (const f of readdirSync(uploadDir).filter((f) => f.startsWith(base))) {
    await rm(path.join(uploadDir, f), { force: true }).catch(() => {});
  }

  return new Response(buffer, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${slug}.mp4"`,
      "Content-Length": String(buffer.length),
    },
  });
}

// Reject URLs that point at localhost/private networks so this route can't be
// used to reach internal services (basic SSRF guard; doesn't cover DNS rebinding)
function isPrivateTarget(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host.endsWith(".local")) return true;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // pageUrl = original Twitch/Kick page URL → use yt-dlp
  const pageUrl = req.nextUrl.searchParams.get("pageUrl");
  if (pageUrl) {
    let parsed: URL;
    try { parsed = new URL(pageUrl); } catch {
      return NextResponse.json({ error: "Invalid pageUrl" }, { status: 400 });
    }
    if (!["http:", "https:"].includes(parsed.protocol) || isPrivateTarget(parsed)) {
      return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
    }
    return downloadViaYtDlp(pageUrl);
  }

  // url = local /uploads/ path or other direct URL → serve/proxy
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url or pageUrl required" }, { status: 400 });

  // Local file: serve it directly with download header
  if (url.startsWith("/uploads/")) {
    const filePath = uploadFilePath(url);
    if (!filePath) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
    if (!existsSync(filePath)) return NextResponse.json({ error: "File not found" }, { status: 404 });
    const buffer = await readFile(filePath);
    const name = path.basename(filePath);
    return new Response(buffer, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Length": String(buffer.length),
      },
    });
  }

  // External URL: proxy with proper headers
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || isPrivateTarget(parsed)) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "video/mp4,video/*,*/*",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Could not reach source: ${e instanceof Error ? e.message : e}` }, { status: 502 });
  }

  if (!upstream.ok) {
    return NextResponse.json({ error: `Source returned ${upstream.status}` }, { status: 502 });
  }

  const name = parsed.pathname.split("/").filter(Boolean).pop()?.split("?")[0] ?? "clip.mp4";
  const headers: Record<string, string> = {
    "Content-Type": upstream.headers.get("content-type") || "video/mp4",
    "Content-Disposition": `attachment; filename="${name}"`,
  };
  const cl = upstream.headers.get("content-length");
  if (cl) headers["Content-Length"] = cl;

  return new Response(upstream.body, { headers });
}
