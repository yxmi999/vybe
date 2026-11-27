import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { storeBuffer } from "@/lib/storage";
import { getServerSession } from "@/lib/auth";
import { checkSideUploadAllowance, MEDIA_TTL_DAYS, recordClip } from "@/lib/plan";

// Post attachments (compose / calendar) when direct-to-Blob uploads aren't
// available. Only media types are accepted, and the stored name gets a random
// part so URLs can't be guessed.
const MAX_BYTES = 500 * 1024 * 1024;
const MEDIA_TYPE = /^(image|video|audio)\/[a-z0-9.+-]+$/i;

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!MEDIA_TYPE.test(contentType)) {
    return NextResponse.json({ error: "Only image, video and audio files can be uploaded" }, { status: 415 });
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 500 MB)" }, { status: 413 });
  }

  const side = await checkSideUploadAllowance(session.userId, "media");
  if (!side.allowed) return NextResponse.json({ error: side.message }, { status: 403 });

  try {
    const name = req.nextUrl.searchParams.get("name") ?? "upload";
    const buffer = Buffer.from(await req.arrayBuffer());

    if (!buffer.length) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }
    if (buffer.length > MAX_BYTES) {
      return NextResponse.json({ error: "File too large (max 500 MB)" }, { status: 413 });
    }

    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`;
    const url = await storeBuffer(buffer, filename, contentType);
    await recordClip({ userId: session.userId, url, kind: "media", countsQuota: false, sizeBytes: buffer.length, minTtlDays: MEDIA_TTL_DAYS });

    return NextResponse.json({ url });
  } catch (err) {
    console.error("Upload error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
