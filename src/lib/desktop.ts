// Desktop mode — the same app packaged as a local Electron app (see desktop/).
//
// The Electron shell runs this Next.js server on the user's own machine with
// VYBE_DESKTOP=1. Everything heavy (VOD downloads, ffmpeg renders, AI calls
// with the user's own API keys, storage) then happens locally, so it costs us
// nothing — in exchange the desktop free tier is more generous but always
// carries the watermark (see plan.ts).
//
// Paths: in the cloud/dev build, uploads live in <cwd>/public/uploads and the
// DB at <cwd>/vybe.db. A packaged app's install folder is read-only (and the
// standalone server chdir()s into it), so the shell points VYBE_DATA_DIR at a
// writable per-user folder and both move there. Read-only bundled assets
// (fonts) still come from <cwd>/public. Server-only.
import path from "path";

export function isDesktop(): boolean {
  return process.env.VYBE_DESKTOP === "1";
}

/** Writable folder for the DB and user media. */
export function dataDir(): string {
  return process.env.VYBE_DATA_DIR || process.cwd();
}

/** Where stored media files live on disk. */
export function uploadsDir(): string {
  return process.env.VYBE_DATA_DIR
    ? path.join(process.env.VYBE_DATA_DIR, "uploads")
    : path.join(process.cwd(), "public", "uploads");
}

/**
 * Map a stored "/uploads/<name>" URL to its file on disk, or null if the URL
 * isn't a plain upload (or tries to escape the uploads folder).
 */
export function uploadFilePath(url: string): string | null {
  const m = /^\/?uploads\/(.+)$/.exec(url);
  if (!m) return null;
  const root = path.resolve(uploadsDir());
  const file = path.resolve(root, decodeURIComponent(m[1]));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

/** Local file for a stored media URL: an upload, or a path as-is. */
export function localMediaPath(mediaUrl: string): string {
  return uploadFilePath(mediaUrl) ?? (mediaUrl.startsWith("/") ? path.join(process.cwd(), "public", mediaUrl) : mediaUrl);
}

// API keys / OAuth app credentials the desktop Settings page may set. Only
// these names can be written through the desktop settings endpoint.
export const DESKTOP_KEY_NAMES = [
  "GOOGLE_GENERATIVE_AI_API_KEYS",
  "GROQ_API_KEYS",
  "FAL_KEY",
  "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET",
  "TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET",
  "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET",
  "INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET",
] as const;
export type DesktopKeyName = (typeof DESKTOP_KEY_NAMES)[number];

/** The shell authenticates its control calls with a per-launch secret. */
export function isDesktopControlRequest(req: Request): boolean {
  const token = process.env.VYBE_DESKTOP_TOKEN;
  return isDesktop() && !!token && req.headers.get("x-vybe-desktop") === token;
}
