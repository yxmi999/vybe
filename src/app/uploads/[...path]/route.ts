// Serves stored media ("/uploads/<file>") from the uploads folder on disk.
//
// In the cloud/dev build these files sit in public/uploads and Next serves
// them statically (public files win over this route). The desktop app keeps
// them in its per-user data folder instead — a packaged app can't write into
// its install folder, and Next only serves public/ files that existed at
// build time — so this route serves them from there. Supports HTTP Range so
// <video> can seek. Same access model as the static files it stands in for.
import { NextRequest } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import path from "path";
import { uploadFilePath } from "@/lib/desktop";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".srt": "text/plain; charset=utf-8",
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const parts = (await params).path;
  const file = uploadFilePath(`/uploads/${parts.join("/")}`);
  if (!file) return new Response("Not found", { status: 404 });
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new Response("Not found", { status: 404 });

  const size = info.size;
  const headers: Record<string, string> = {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start: number, end: number;
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
    else { start = Math.max(0, size - Number(m[2])); end = size - 1; } // "bytes=-N" = last N bytes
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }

  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, { headers: { ...headers, "Content-Length": String(size) } });
}
