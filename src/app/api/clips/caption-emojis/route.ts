import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { pickCaptionEmojis, CaptionEmojiError } from "@/lib/caption-emojis";

// Auto-emoji captions (see lib/caption-emojis.ts). The client merges each emoji
// onto the matching subtitle word by index; rendering happens via ASS events.
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const words: string[] = Array.isArray(body.words) ? body.words.map((w: unknown) => String(w ?? "")) : [];
  try {
    return NextResponse.json({ assignments: await pickCaptionEmojis(words) });
  } catch (err) {
    console.error("[clips/caption-emojis]", err);
    const status = err instanceof CaptionEmojiError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Emoji tagging failed" }, { status });
  }
}

export const maxDuration = 60;
