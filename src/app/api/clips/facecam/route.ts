import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { detectFacecamInFrames, detectFacecamInImage, facecamAvailable } from "@/lib/facecam";
import { aiFailure } from "@/lib/ai";

// POST /api/clips/facecam — find the streamer's webcam overlay.
// Body: { images: ["data:image/jpeg;base64,…", …] } (1–5 frames grabbed in the
//        editor around the playhead — voted on and snapped to the overlay's
//        real pixel edges)
//    or { image: "data:image/jpeg;base64,…" }       (one frame, same path)
//    or { imageUrl: "https://static-cdn.jtvnw.net/…" } (a Twitch VOD thumbnail,
//        used by the Auto-Pilot builder; only Twitch's CDN is fetched so this
//        can't be used to make the server request arbitrary URLs).
// → { found: true, box: {x,y,w,h} (fractions) } | { found: false, reason }
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;   // per image
const MAX_TOTAL = 4 * 1024 * 1024;   // all frames together (host body limit ~4.5 MB)
const MAX_FRAMES = 5;

function decodeDataUrl(s: unknown): Buffer | null {
  if (typeof s !== "string") return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  return m ? Buffer.from(m[2], "base64") : null;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!facecamAvailable()) {
    return NextResponse.json({ error: "AI isn't configured. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local." }, { status: 500 });
  }

  const body = await req.json().catch(() => ({})) as { image?: unknown; images?: unknown; imageUrl?: unknown };
  try {
    if (Array.isArray(body.images) || typeof body.image === "string") {
      const raw = Array.isArray(body.images) ? body.images.slice(0, MAX_FRAMES) : [body.image];
      const bufs = raw.map(decodeDataUrl);
      if (bufs.length === 0 || bufs.some((b) => !b)) {
        return NextResponse.json({ error: "Send the frames as JPEG/PNG data URLs." }, { status: 400 });
      }
      const frames = bufs as Buffer[];
      const total = frames.reduce((n, b) => n + b.length, 0);
      if (frames.some((b) => b.length === 0 || b.length > MAX_BYTES) || total > MAX_TOTAL) {
        return NextResponse.json({ error: "Frames are empty or too large (4 MB max in total)." }, { status: 400 });
      }
      return NextResponse.json(await detectFacecamInFrames(frames));
    }

    if (typeof body.imageUrl === "string") {
      let u: URL;
      try { u = new URL(body.imageUrl); } catch { return NextResponse.json({ error: "Invalid image URL." }, { status: 400 }); }
      const twitchCdn = u.protocol === "https:" && u.hostname === "static-cdn.jtvnw.net";
      if (!twitchCdn) return NextResponse.json({ error: "Only Twitch thumbnails can be analysed by URL." }, { status: 400 });
      const res = await fetch(u, { redirect: "error" }).catch(() => null);
      if (!res?.ok) return NextResponse.json({ error: "Couldn't load that thumbnail." }, { status: 502 });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) return NextResponse.json({ error: "Image is empty or too large (4 MB max)." }, { status: 400 });
      // A still thumbnail: one look, then snapped to the overlay's edges.
      return NextResponse.json(await detectFacecamInFrames([buf]).catch(() => detectFacecamInImage(buf)));
    }

    return NextResponse.json({ error: "Send images, image or imageUrl." }, { status: 400 });
  } catch (err) {
    const { error, status } = aiFailure(err);
    return NextResponse.json({ error }, { status });
  }
}
