import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { generateSubtitles } from "@/lib/subtitle-generation";

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { videoUrl, language = "original" } = await req.json();
  if (!videoUrl) return NextResponse.json({ error: "videoUrl is required" }, { status: 400 });

  try {
    const result = await generateSubtitles({ videoUrl, language });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[clips/subtitles]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Subtitle generation failed" }, { status: 500 });
  }
}

export const maxDuration = 120;
