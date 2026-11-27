import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { planAutoEdit, AutoEditError, type ClipMeta } from "@/lib/auto-edit";
import { parseInlineStyle, resolveStyle } from "@/lib/style-store";

export const maxDuration = 120;

// One-click "Auto-edit": the model WATCHES the clip and returns a complete
// timed edit plan (see lib/auto-edit.ts). An optional style — a saved/builtin
// ref (`styleRef`) or an inline, not-yet-saved style object (`style`) — steers
// the plan and pins the look so the clip matches a copied style.
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as {
    videoUrl?: string;
    clip?: ClipMeta;
    transcript?: string;
    trimStart?: number;
    trimEnd?: number;
    styleRef?: string | number;
    style?: unknown;
  };
  if (!body.clip) return NextResponse.json({ error: "Missing clip" }, { status: 400 });

  const style = parseInlineStyle(body.style) ?? await resolveStyle(session.userId, body.styleRef);

  try {
    const result = await planAutoEdit({
      videoUrl: body.videoUrl,
      clip: body.clip,
      transcript: body.transcript,
      trimStart: body.trimStart,
      trimEnd: body.trimEnd,
      style,
    });
    return NextResponse.json({ ...result, style: style?.name ?? null });
  } catch (err) {
    const status = err instanceof AutoEditError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Auto-edit failed" }, { status });
  }
}
