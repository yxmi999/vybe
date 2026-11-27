import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { recordAsset } from "@/lib/plan";
import { storeBuffer } from "@/lib/storage";
import { getEffect } from "@/lib/ai-presets";

// Pluggable AI video provider. Default is fal.ai (Kling) — cheap and has free
// starting credits. The Studio can also request Google Veo per-call (needs a
// paid key); VIDEO_PROVIDER=veo flips the default.
const DEFAULT_PROVIDER = (process.env.VIDEO_PROVIDER || "fal").toLowerCase();

// Kling does 1:1 too; Veo only does 16:9 / 9:16.
const ASPECTS = ["16:9", "9:16", "1:1"] as const;
type Aspect = (typeof ASPECTS)[number];

type GenInput = {
  prompt: string;
  image?: { bytes: Uint8Array; mediaType: string };
  aspect: Aspect;
  duration: "5" | "10";
  modelId: string;     // picker id, e.g. "kling-standard" | "kling-pro"
};

// Thrown when a provider's API key is missing — surfaced as a friendly message.
class NotConfiguredError extends Error {}

function decodeImage(input: string): { bytes: Uint8Array; mediaType: string } {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(input);
  const mediaType = m ? m[1] : "image/png";
  const b64 = m ? m[2] : input;
  return { bytes: new Uint8Array(Buffer.from(b64, "base64")), mediaType };
}

async function persistFromUrl(videoUrl: string): Promise<string> {
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error("Failed to download the generated video");
  const buf = Buffer.from(await resp.arrayBuffer());
  return storeBuffer(buf, `vybe-ai-${Date.now()}.mp4`, "video/mp4");
}

// Map a picker id + whether an image was supplied to a concrete Kling endpoint.
// Text-to-video only ships in the "master" tier; image-to-video has standard/pro.
function falModel(modelId: string, hasImage: boolean): string {
  if (hasImage) {
    if (process.env.FAL_IMAGE_MODEL) return process.env.FAL_IMAGE_MODEL;
    const tier = modelId === "kling-pro" ? "pro" : "standard";
    return `fal-ai/kling-video/v2.1/${tier}/image-to-video`;
  }
  return process.env.FAL_TEXT_MODEL || "fal-ai/kling-video/v2.1/master/text-to-video";
}

// ── fal.ai (Kling) ────────────────────────────────────────────────────────────
async function generateFal({ prompt, image, aspect, duration, modelId }: GenInput): Promise<string> {
  if (!process.env.FAL_KEY) {
    throw new NotConfiguredError("AI video generation isn't configured. Add FAL_KEY (a free key from fal.ai) to .env.local and restart.");
  }
  const { fal } = await import("@fal-ai/client");
  fal.config({ credentials: process.env.FAL_KEY });

  const model = falModel(modelId, !!image);
  let result: { data?: { video?: { url?: string } } };
  if (image) {
    // Kling image-to-video needs a fetchable URL — upload the bytes to fal first.
    const image_url = await fal.storage.upload(new Blob([image.bytes as BlobPart], { type: image.mediaType }));
    result = await fal.subscribe(model, {
      input: { prompt: prompt || undefined, image_url, duration, aspect_ratio: aspect },
    });
  } else {
    result = await fal.subscribe(model, { input: { prompt, duration, aspect_ratio: aspect } });
  }

  const videoUrl = result?.data?.video?.url;
  if (!videoUrl) throw new Error("fal.ai did not return a video");
  return persistFromUrl(videoUrl);
}

// ── Google Veo ─────────────────────────────────────────────────────────────────
async function generateVeo({ prompt, image, aspect }: GenInput): Promise<string> {
  const key = process.env.VEO_API_KEY || "";
  if (!key) {
    throw new NotConfiguredError("Veo isn't configured. Add VEO_API_KEY (a paid Google API key with Veo access) to .env.local and restart.");
  }
  // Veo only supports 16:9 / 9:16.
  const veoAspect = aspect === "1:1" ? "9:16" : aspect;
  const { experimental_generateVideo: generateVideo } = await import("ai");
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const veo = createGoogleGenerativeAI({ apiKey: key });
  const { video } = await generateVideo({
    model: veo.video(process.env.VEO_MODEL || "veo-3.0-generate-001"),
    prompt: image ? { image: image.bytes, text: prompt || undefined } : prompt,
    aspectRatio: veoAspect,
    providerOptions: { google: { personGeneration: "allow_adult" } },
  });
  return storeBuffer(Buffer.from(video.uint8Array), `vybe-ai-${Date.now()}.mp4`, video.mediaType || "video/mp4");
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // AI generation is gated while it's in "coming soon". Paid per-call on
  // fal.ai/Veo, so we refuse here too — not just in the UI — to protect credits.
  if (process.env.AI_GENERATION_ENABLED !== "true") {
    return NextResponse.json({ error: "AI Studio is coming soon." }, { status: 503 });
  }

  const body = (await req.json()) as {
    prompt?: string;
    image?: string;
    aspectRatio?: string;
    duration?: string | number;
    model?: string;     // picker id; "veo" selects the Veo provider
    effectId?: string;  // a preset from ai-presets
  };

  const aspect: Aspect = (ASPECTS as readonly string[]).includes(body.aspectRatio ?? "")
    ? (body.aspectRatio as Aspect) : "9:16";
  const duration: "5" | "10" = String(body.duration) === "10" ? "10" : "5";
  const img = body.image ? decodeImage(body.image) : undefined;

  // An effect preset contributes its prompt; the user's own words refine it.
  const effect = getEffect(body.effectId);
  const userPrompt = (body.prompt ?? "").trim();
  const prompt = [effect?.prompt, userPrompt].filter(Boolean).join(". ");

  if (!prompt && !img) {
    return NextResponse.json({ error: "Provide a prompt, an image, or both." }, { status: 400 });
  }
  if (effect && !img) {
    return NextResponse.json({ error: "Effects need an image to animate — upload one first." }, { status: 400 });
  }

  const modelId = body.model || "kling-standard";
  const provider = modelId === "veo" ? "veo" : (DEFAULT_PROVIDER === "veo" && !body.model ? "veo" : "fal");

  try {
    const input: GenInput = { prompt, image: img, aspect, duration, modelId };
    const url = provider === "veo" ? await generateVeo(input) : await generateFal(input);
    await recordAsset(session.userId, url);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[clips/generate]", err);
    const msg = err instanceof Error ? err.message : "Video generation failed";
    return NextResponse.json({ error: msg }, { status: err instanceof NotConfiguredError ? 400 : 500 });
  }
}

// Video models are long-running (the SDK/client polls until the clip is ready).
export const maxDuration = 300;
