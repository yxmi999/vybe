import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { recordAsset } from "@/lib/plan";
import { generateObject } from "ai";
import { google } from "@/lib/ai-keys";
import { z } from "zod";
import { GEMINI_MODELS, isTransient, aiFailure } from "@/lib/ai";
import { storeBuffer } from "@/lib/storage";

// AI Auto B-roll: read the transcript, pick the strongest visual moments, and
// fetch matching stock photos (Pexels, free key) for each. Returns timed overlay
// descriptors the editor drops straight into its existing asset/overlay system —
// no new render plumbing. Text + HTTP only, so it's quick and cheap.

const schema = z.object({
  picks: z.array(z.object({
    time: z.number().describe("source-time in seconds where this B-roll should appear (a moment the words evoke a concrete visual)"),
    query: z.string().describe("a 1-3 word CONCRETE, visual stock-photo search term (e.g. 'city skyline', 'stock market', 'ocean waves') — never abstract"),
  })).describe("a SPARSE set of the most visual moments — never one per sentence"),
});

// Pexels orientation that best matches the output frame.
function orientationFor(aspect: string): "landscape" | "portrait" | "square" {
  if (aspect === "9:16" || aspect === "4:5") return "portrait";
  if (aspect === "1:1") return "square";
  return "landscape";
}

type PexelsPhoto = { src?: { large2x?: string; large?: string; medium?: string; original?: string } };

async function searchPexels(query: string, orientation: string, key: string): Promise<string | null> {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=${orientation}`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) return null;
  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  const src = data.photos?.[0]?.src;
  return src?.large2x || src?.large || src?.original || src?.medium || null;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return NextResponse.json(
      { error: "AI isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local and restart." },
      { status: 500 },
    );
  }
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (!pexelsKey) {
    return NextResponse.json(
      { error: "B-roll isn't configured. Add PEXELS_API_KEY (a free key from pexels.com/api) to .env.local and restart." },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const segments = Array.isArray(body.segments)
    ? body.segments
        .filter((s: { start?: unknown; end?: unknown; text?: unknown }) =>
          typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string" && s.text.trim())
        .slice(0, 200)
    : [];
  if (segments.length === 0) {
    return NextResponse.json({ error: "No transcript — generate subtitles first so B-roll can pick moments." }, { status: 400 });
  }
  const aspect = String(body.aspectRatio ?? "9:16");
  const duration = Math.max(1, Number(body.duration) || 30);

  // One insert per ~10s of clip feels punchy without burying the speaker.
  const cap = Math.max(1, Math.min(5, Math.round(duration / 10)));
  const transcript = segments
    .map((s: { start: number; text: string }) => `[${s.start.toFixed(1)}s] ${s.text.trim()}`)
    .join("\n");

  const system =
    "You are a short-form video editor adding B-roll (stock footage cutaways) to a vertical clip. " +
    "You are given the transcript with timestamps. Pick the moments where a CONCRETE visual would reinforce the words " +
    "(a place, object, action, or scene that's named or strongly implied) and give each a simple, searchable stock-photo query. " +
    `Be SPARSE and tasteful: choose at most ${cap} moment(s), spread across the clip, never overlapping. ` +
    "Skip abstract talk with no clear image. Queries must be generic and visual (e.g. 'mountain sunrise', 'busy office', 'gold coins'), " +
    "1-3 words, no names or text. If nothing is clearly visual, return an empty list. Use timestamps from the transcript.";

  let picks: { time: number; query: string }[] = [];
  let lastErr: unknown;
  for (const model of GEMINI_MODELS) {
    try {
      const { object } = await generateObject({ model: google(model), schema, system, prompt: transcript });
      picks = (object.picks ?? [])
        .filter((p) => typeof p.time === "number" && p.query?.trim())
        .map((p) => ({ time: Math.max(0, p.time), query: p.query.trim() }))
        .sort((a, b) => a.time - b.time)
        .slice(0, cap);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) break;
    }
  }
  if (lastErr) {
    const { error, status } = aiFailure(lastErr);
    console.error("[clips/broll] model", lastErr);
    return NextResponse.json({ error }, { status });
  }

  const orientation = orientationFor(aspect);
  const assets: { timestamp: number; query: string; url: string; name: string }[] = [];
  for (const p of picks) {
    try {
      const imgUrl = await searchPexels(p.query, orientation, pexelsKey);
      if (!imgUrl) continue;
      const resp = await fetch(imgUrl);
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      const url = await storeBuffer(buf, `vybe-broll-${Date.now()}-${assets.length}.jpg`, "image/jpeg");
      await recordAsset(session.userId, url);
      assets.push({ timestamp: Number(p.time.toFixed(2)), query: p.query, url, name: `B-roll · ${p.query}` });
    } catch (err) {
      console.error("[clips/broll] fetch", p.query, err);
    }
  }

  return NextResponse.json({ assets });
}

export const maxDuration = 120;
