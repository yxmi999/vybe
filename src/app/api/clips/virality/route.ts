import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { aiFailure } from "@/lib/ai";
import { scoreClipVirality, viralityAvailable, type ViralityClipMeta } from "@/lib/virality";

// Virality score: the model SEES the clip (sampled frames + transcript) and rates
// its short-form viral potential 0-100, with a verdict, the reasons, and concrete
// fixes. The scoring itself lives in lib/virality so Auto-Pilot shares it.

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!viralityAvailable()) {
    return NextResponse.json(
      { error: "AI isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart." },
      { status: 500 },
    );
  }

  const { videoUrl, clip, transcript = "", trimStart = 0, trimEnd = 0 } = (await req.json()) as {
    videoUrl?: string;
    clip?: ViralityClipMeta;
    transcript?: string;
    trimStart?: number;
    trimEnd?: number;
  };
  if (!clip) return NextResponse.json({ error: "Missing clip" }, { status: 400 });

  try {
    const result = await scoreClipVirality({ videoUrl, clip, transcript, trimStart, trimEnd });
    return NextResponse.json(result);
  } catch (err) {
    const fail = aiFailure(err);
    return NextResponse.json({ error: fail.error }, { status: fail.status });
  }
}
