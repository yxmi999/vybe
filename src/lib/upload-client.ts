// Client-side file upload that works everywhere:
//   • Hosted (Vercel, BLOB_READ_WRITE_TOKEN set): the browser uploads
//     straight to Vercel Blob — function request bodies are capped at 4.5 MB
//     there, so posting a video through our API would fail. /api/blob-upload
//     authorizes it and records it.
//   • Local dev / desktop app: posts to the existing upload routes, which
//     store the file on disk.
"use client";

export type UploadKind = "upload" | "export" | "media";

let directSupport: Promise<boolean> | null = null;
function directAvailable(): Promise<boolean> {
  directSupport ??= fetch("/api/blob-upload")
    .then((r) => (r.ok ? r.json() : { direct: false }))
    .then((d: { direct?: boolean }) => !!d.direct)
    .catch(() => false);
  return directSupport;
}

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "file";

/**
 * Upload a file and return its stored URL. `kind`: "upload" = a clip
 * imported into the editor (counts toward the monthly quota), "export" = a
 * re-upload of an already-counted clip, "media" = a post attachment.
 * Throws with a readable message on failure.
 */
export async function uploadFile(file: File | Blob, kind: UploadKind, name = (file as File).name ?? "file"): Promise<string> {
  if (await directAvailable()) {
    const { upload } = await import("@vercel/blob/client");
    const blob = await upload(`${kind}/${Date.now()}-${safeName(name)}`, file, {
      access: "public",
      handleUploadUrl: "/api/blob-upload",
      clientPayload: JSON.stringify({ kind }),
      contentType: file.type || undefined,
      // Big videos go up in parts (faster, resumable per part).
      multipart: file.size > 50 * 1024 * 1024,
    });
    return blob.url;
  }

  let res: Response;
  if (kind === "media") {
    res = await fetch(`/api/upload?name=${encodeURIComponent(name)}`, {
      method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" },
    });
  } else {
    const form = new FormData();
    form.append("file", file, name);
    if (kind === "export") form.append("kind", "export");
    res = await fetch("/api/clips/upload", { method: "POST", body: form });
  }
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error ?? "Upload failed");
  return data.url;
}
