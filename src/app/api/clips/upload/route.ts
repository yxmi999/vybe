import { NextRequest, NextResponse } from "next/server";
import { storeBuffer } from "@/lib/storage";
import { getServerSession } from "@/lib/auth";
import { checkClipQuota, checkSideUploadAllowance, quotaMessage, recordClip } from "@/lib/plan";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const maxSize = 500 * 1024 * 1024;
    if (file.size > maxSize) return NextResponse.json({ error: "File too large (max 500 MB)" }, { status: 413 });

    // Re-uploading a rendered export ("kind=export") belongs to a clip that was
    // already counted on import, so it doesn't hit the monthly quota — but it
    // still gets a ledger row so it expires on the free tier.
    const isExport = formData.get("kind") === "export";
    if (!isExport) {
      const quota = await checkClipQuota(session.userId);
      if (!quota.allowed) return NextResponse.json({ error: quotaMessage(quota) }, { status: 403 });
    } else {
      const side = await checkSideUploadAllowance(session.userId, "export");
      if (!side.allowed) return NextResponse.json({ error: side.message }, { status: 403 });
    }

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "mp4";
    const safe = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
    const filename = `${Date.now()}-${safe}.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());
    const url = await storeBuffer(buffer, filename, file.type || "application/octet-stream");

    await recordClip({
      userId: session.userId,
      url,
      kind: isExport ? "export" : "upload",
      countsQuota: !isExport,
      sizeBytes: file.size,
    });

    return NextResponse.json({ url, name: file.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
