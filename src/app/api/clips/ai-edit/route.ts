import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { runEditAgent, EditAgentError, type ClipMeta } from "@/lib/edit-agent";

// Natural-language AI editor. The model works as a tool-using agent over the
// editor's own tools (see lib/edit-agent.ts) and returns a PARTIAL edit object
// — only the fields it changed — plus a one-line note on what it did.
export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { prompt, clip, currentState, transcript, videoUrl } = await req.json().catch(() => ({})) as {
    prompt?: string;
    clip?: ClipMeta;
    currentState?: Record<string, unknown>;
    transcript?: string; // "[12.3-14.1] words…" lines (SOURCE seconds)
    videoUrl?: string;   // server-fetchable source, enables the media detectors
  };

  if (!prompt?.trim() || !clip) return NextResponse.json({ error: "Missing prompt or clip" }, { status: 400 });

  try {
    const result = await runEditAgent({
      prompt: prompt.slice(0, 2000),
      clip,
      state: currentState ?? {},
      transcript: typeof transcript === "string" ? transcript.slice(0, 20_000) : "",
      videoUrl,
    });
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof EditAgentError ? err.status : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : "AI request failed" }, { status });
  }
}

export const maxDuration = 120;
