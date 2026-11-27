// Built-in sound effects (synthesized by scripts/gen-sfx.mjs into public/sfx —
// original, nothing to license). Shared by the editor's quick-add buttons and
// the AI editor's add_sound_effects tool. Keys/durations match the generator.

export type SfxKey = "whoosh" | "boom" | "hit" | "pop" | "ding" | "riser" | "glitch" | "click" | "boing";

export const SFX_LIBRARY: Record<SfxKey, { label: string; url: string; duration: number; use: string }> = {
  whoosh: { label: "Whoosh", url: "/sfx/whoosh.mp3", duration: 0.7, use: "transitions, cuts, fast camera moves, text flying in" },
  boom:   { label: "Boom",   url: "/sfx/boom.mp3",   duration: 1.3, use: "the big reveal / punchline / dramatic moment (deep cinematic hit)" },
  hit:    { label: "Hit",    url: "/sfx/hit.mp3",    duration: 0.45, use: "zoom punch-ins and hard emphasis" },
  pop:    { label: "Pop",    url: "/sfx/pop.mp3",    duration: 0.16, use: "text/emoji/sticker appearing, light emphasis" },
  ding:   { label: "Ding",   url: "/sfx/ding.mp3",   duration: 1.2, use: "correct answer, good idea, positive moment" },
  riser:  { label: "Riser",  url: "/sfx/riser.mp3",  duration: 2.0, use: "build tension BEFORE a payoff — end it exactly on the beat" },
  glitch: { label: "Glitch", url: "/sfx/glitch.mp3", duration: 0.45, use: "glitch/invert effects, chaos, something going wrong" },
  click:  { label: "Click",  url: "/sfx/click.mp3",  duration: 0.14, use: "camera snap, freeze moment, UI click" },
  boing:  { label: "Boing",  url: "/sfx/boing.mp3",  duration: 0.7, use: "comedic fail, bounce, silly moment" },
};

export const SFX_KEYS = Object.keys(SFX_LIBRARY) as SfxKey[];
