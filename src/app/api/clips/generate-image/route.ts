import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { recordAsset } from "@/lib/plan";
import { storeBuffer } from "@/lib/storage";

// Text-to-image via fal.ai FLUX. Pairs with the video generator: make a still
// here (Higgsfield "Soul"-style), then animate it with an effect.
const ASPECT_TO_SIZE: Record<string, "landscape_16_9" | "portrait_16_9" | "square_hd"> = {
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "1:1": "square_hd",
};

class NotConfiguredError extends Error {}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Gated while AI Studio is "coming soon" — paid per-call on fal.ai.
  if (process.env.AI_GENERATION_ENABLED !== "true") {
    return NextResponse.json({ error: "AI Studio is coming soon." }, { status: 503 });
  }

  const { prompt = "", aspectRatio = "9:16", model = "flux-schnell" } =
    (await req.json()) as { prompt?: string; aspectRatio?: string; model?: string };

  const text = prompt.trim();
  if (!text) return NextResponse.json({ error: "Describe the image you want." }, { status: 400 });

  if (!process.env.FAL_KEY) {
    return NextResponse.json(
      { error: "Image generation isn't configured. Add FAL_KEY (a free key from fal.ai) to .env.local and restart." },
      { status: 400 },
    );
  }

  const endpoint = model === "flux-dev" ? "fal-ai/flux/dev" : "fal-ai/flux/schnell";
  const image_size = ASPECT_TO_SIZE[aspectRatio] ?? "portrait_16_9";

  try {
    const { fal } = await import("@fal-ai/client");
    fal.config({ credentials: process.env.FAL_KEY });

    const result = (await fal.subscribe(endpoint, {
      input: { prompt: text, image_size, num_images: 1 },
    })) as { data?: { images?: { url?: string }[] } };

    const imgUrl = result?.data?.images?.[0]?.url;
    if (!imgUrl) throw new Error("fal.ai did not return an image");

    const resp = await fetch(imgUrl);
    if (!resp.ok) throw new Error("Failed to download the generated image");
    const buf = Buffer.from(await resp.arrayBuffer());
    const stored = await storeBuffer(buf, `vybe-ai-img-${Date.now()}.png`, "image/png");
    await recordAsset(session.userId, stored);

    return NextResponse.json({ url: stored });
  } catch (err) {
    console.error("[clips/generate-image]", err);
    const msg = err instanceof Error ? err.message : "Image generation failed";
    return NextResponse.json({ error: msg }, { status: err instanceof NotConfiguredError ? 400 : 500 });
  }
}

export const maxDuration = 120;
