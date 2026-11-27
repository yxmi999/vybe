import { put } from "@vercel/blob";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { uploadsDir, uploadFilePath, localMediaPath } from "./desktop";

/**
 * Store a buffer as a file. In production (BLOB_READ_WRITE_TOKEN set) uses
 * Vercel Blob; in local dev writes to public/uploads/ and returns a /uploads/
 * path so the dev server can serve it statically.
 */
export async function storeBuffer(
  buffer: Buffer,
  filename: string,
  contentType = "application/octet-stream"
): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(filename, buffer, { access: "public", contentType });
    return blob.url;
  }

  const dir = uploadsDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const file = uploadFilePath(`/uploads/${filename}`);
  if (!file) throw new Error("Invalid upload file name");
  await writeFile(file, buffer);
  return `/uploads/${filename}`;
}

/**
 * Store a file that was written to a temp path. Reads it, stores via
 * storeBuffer, then returns the public URL.
 */
export async function storeTempFile(
  tmpPath: string,
  filename: string,
  contentType = "video/mp4"
): Promise<string> {
  // Hosted: stream the file to Blob instead of reading it into memory — a
  // multi-hundred-MB VOD cut would otherwise sit in RAM twice, and function
  // memory is billed for the whole time the request is open. Big files go up
  // in parts (parallel + retried per part).
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { createReadStream } = await import("fs");
    const { stat } = await import("fs/promises");
    const size = (await stat(tmpPath)).size;
    const blob = await put(filename, createReadStream(tmpPath), {
      access: "public",
      contentType,
      multipart: size > 50 * 1024 * 1024,
    });
    return blob.url;
  }
  const { readFile } = await import("fs/promises");
  const buf = await readFile(tmpPath);
  return storeBuffer(buf, filename, contentType);
}

/**
 * Delete a previously stored file by its public URL. Handles both backends:
 * Vercel Blob (remote https URL) and local dev (/uploads/ path). Best-effort —
 * never throws, so cleanup can power through a bad row.
 */
export async function deleteStored(url: string): Promise<void> {
  if (!url) return;
  try {
    if (url.startsWith("http")) {
      if (!process.env.BLOB_READ_WRITE_TOKEN) return;
      const { del } = await import("@vercel/blob");
      await del(url);
    } else {
      const { unlink } = await import("fs/promises");
      const file = uploadFilePath(url);
      if (file) await unlink(file);
    }
  } catch {
    /* already gone or unreachable — ignore */
  }
}

/**
 * Resolve a mediaUrl (either a /uploads/ local path or a remote https:// URL)
 * to an absolute filesystem path inside a temp dir, downloading if needed.
 * Returns the local path.
 */
export async function resolveToTempFile(mediaUrl: string, tmpPath: string): Promise<void> {
  if (!mediaUrl.startsWith("http")) {
    const { copyFile } = await import("fs/promises");
    await copyFile(localMediaPath(mediaUrl), tmpPath);
    return;
  }
  const axios = (await import("axios")).default;
  const resp = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    timeout: 120_000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const { writeFile: wf } = await import("fs/promises");
  await wf(tmpPath, Buffer.from(resp.data as ArrayBuffer));
}
