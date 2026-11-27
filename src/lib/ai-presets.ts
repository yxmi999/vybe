// Curated AI generation presets — shared by the Studio page (renders the grid)
// and the generate route (resolves a preset id to its prompt). Pure data, no
// server-only deps, so it imports cleanly on both sides.
//
// Effect presets are prompt engineering over an image-to-video model: the same
// approach Higgsfield-style tools use. Each one turns a still image into a clip
// with a dramatic camera move or VFX, driven entirely by the prompt.

export type EffectCategory = "camera" | "vfx";

export type Effect = {
  id: string;
  label: string;
  emoji: string;
  category: EffectCategory;
  blurb: string;     // short UI description
  prompt: string;    // the generation prompt (combined with any user prompt)
};

export const EFFECTS: Effect[] = [
  // ── Camera moves ──
  { id: "crash-zoom", label: "Crash Zoom", emoji: "💥", category: "camera",
    blurb: "Aggressive fast push-in",
    prompt: "extremely fast aggressive crash zoom rushing toward the subject, dramatic motion blur, punchy cinematic energy" },
  { id: "orbit", label: "360 Orbit", emoji: "🔄", category: "camera",
    blurb: "Smooth orbit around subject",
    prompt: "smooth 360 degree orbital camera rotation circling around the subject, cinematic parallax, steady motion" },
  { id: "dolly-in", label: "Dolly In", emoji: "🎬", category: "camera",
    blurb: "Slow cinematic push-in",
    prompt: "slow steady cinematic dolly push-in toward the subject, shallow depth of field, film look" },
  { id: "pull-back", label: "Pull Back", emoji: "↔️", category: "camera",
    blurb: "Reveal the wider scene",
    prompt: "slow cinematic dolly pull-back revealing the wider environment around the subject" },
  { id: "fpv", label: "FPV Drone", emoji: "🚁", category: "camera",
    blurb: "Swooping fly-through",
    prompt: "fast first-person-view drone fly-through, swooping dynamic aerial motion, immersive speed" },
  { id: "bullet-time", label: "Bullet Time", emoji: "🕴️", category: "camera",
    blurb: "Frozen-moment arc",
    prompt: "bullet-time frozen-moment camera arcing around the subject, time dramatically slowed, Matrix style" },
  { id: "crane-up", label: "Crane Up", emoji: "🏗️", category: "camera",
    blurb: "Sweeping rise to reveal",
    prompt: "sweeping crane shot rising upward and tilting down to reveal the scene from above, epic scale" },
  { id: "dolly-zoom", label: "Dolly Zoom", emoji: "🌀", category: "camera",
    blurb: "Vertigo warp effect",
    prompt: "vertigo dolly-zoom effect, background warping and stretching while the subject stays fixed, unsettling cinematic tension" },

  // ── VFX ──
  { id: "explode", label: "Explode", emoji: "🧨", category: "vfx",
    blurb: "Bursts into pieces",
    prompt: "the subject violently explodes into flying debris and shrapnel, dramatic slow-motion shockwave, cinematic VFX" },
  { id: "disintegrate", label: "Disintegrate", emoji: "✨", category: "vfx",
    blurb: "Crumbles to dust",
    prompt: "the subject disintegrates into floating particles drifting away like dust on the wind, Thanos-snap effect" },
  { id: "fire", label: "Set Ablaze", emoji: "🔥", category: "vfx",
    blurb: "Bursts into flames",
    prompt: "the subject bursts into roaring flames with embers and rising smoke, intense cinematic fire VFX" },
  { id: "freeze", label: "Frostbite", emoji: "🧊", category: "vfx",
    blurb: "Freezes over in ice",
    prompt: "the subject rapidly freezes over as ice crystals spread across it, frosty mist and cracking, wintry VFX" },
  { id: "electrify", label: "Electrify", emoji: "⚡", category: "vfx",
    blurb: "Crackling lightning",
    prompt: "crackling electricity and lightning arcs surging over the subject, glowing energy, high-voltage VFX" },
  { id: "melt", label: "Melt", emoji: "🫠", category: "vfx",
    blurb: "Liquefies and drips",
    prompt: "the subject slowly melts and drips downward in a surreal liquefying transformation" },
  { id: "inflate", label: "Inflate", emoji: "🎈", category: "vfx",
    blurb: "Balloons up comically",
    prompt: "the subject comically inflates and balloons up larger and larger, then wobbles and jiggles" },
  { id: "hyperspace", label: "Hyperspace", emoji: "🌌", category: "vfx",
    blurb: "Light-speed zoom burst",
    prompt: "explosive zoom burst jumping into hyperspace, streaking stars and light-speed motion trails" },
];

export function getEffect(id: string | undefined | null): Effect | undefined {
  if (!id) return undefined;
  return EFFECTS.find((e) => e.id === id);
}

// ── Models & aspects ─────────────────────────────────────────────────────────
// The picker chooses a quality tier (and provider); the generate route maps the
// id to a concrete model endpoint.

export type VideoModel = { id: string; label: string; blurb: string };

export const VIDEO_MODELS: VideoModel[] = [
  { id: "kling-standard", label: "Kling 2.1 Standard", blurb: "Fast, great value" },
  { id: "kling-pro",      label: "Kling 2.1 Pro",      blurb: "Higher fidelity, slower" },
  { id: "veo",            label: "Google Veo 3",       blurb: "Top quality (needs Veo key)" },
];

export const IMAGE_MODELS: VideoModel[] = [
  { id: "flux-schnell", label: "FLUX Schnell", blurb: "Fast, photoreal" },
  { id: "flux-dev",     label: "FLUX Dev",     blurb: "Sharper, slower" },
];

export const ASPECTS = ["9:16", "16:9", "1:1"] as const;
export type AspectRatio = (typeof ASPECTS)[number];

export const DURATIONS = ["5", "10"] as const;
export type Duration = (typeof DURATIONS)[number];
