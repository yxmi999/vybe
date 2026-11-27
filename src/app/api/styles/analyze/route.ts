import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { analyzeReference, StyleAnalyzeError } from "@/lib/style-analyze";

export const maxDuration = 180;

const MAX_UPLOAD = 200 * 1024 * 1024;

// Analyze a reference clip's editing style. Doesn't save anything (and doesn't
// touch the clip quota) — the client previews the result, then POSTs
// /api/styles to keep it.
//   multipart: file=<video>
//   json:      { url }  — a TikTok/YouTube/IG/X/Twitch/Kick link, a direct
//              .mp4 link, or a clip already stored by the app ("/uploads/…")
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    let result;
    let source = "";
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file") as File | null;
      if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
      if (file.size > MAX_UPLOAD) return NextResponse.json({ error: "File too large (max 200 MB)." }, { status: 413 });
      source = file.name;
      result = await analyzeReference({ buffer: Buffer.from(await file.arrayBuffer()) }, source);
    } else {
      const { url } = await req.json().catch(() => ({})) as { url?: string };
      source = String(url ?? "").trim();
      result = await analyzeReference({ url: source }, source.startsWith("/") ? "" : source);
    }
    return NextResponse.json({ ...result, source });
  } catch (err) {
    const status = err instanceof StyleAnalyzeError ? err.status : 500;
    console.error("[styles/analyze]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't analyze that clip." }, { status });
  }
}
