import { z } from "zod";
import { FONT_KEYS, SPLIT_LAYOUT_KEYS } from "./clip-filters";

// Structured editing parameters the clip editor understands. Shared by the
// natural-language assistant (/api/clips/ai-edit) and the one-click Auto-edit
// (/api/clips/auto-edit) so both speak the exact same vocabulary. EVERY editor
// control is represented here so the model can drive the whole editor.
export const editSchema = z.object({
  trimStart: z.number().describe("Clip start time in seconds"),
  trimEnd: z.number().describe("Clip end time in seconds"),

  // ── Caption (a single static text overlay) ──
  caption: z.string().describe("A SINGLE static text overlay (a title or call-to-action) — NOT subtitles. Never put transcribed speech here. Empty string for none."),
  captionX: z.number().describe("Caption horizontal center, 0–100 (0=left, 50=center, 100=right)."),
  captionY: z.number().describe("Caption vertical center, 0–100 (≈12=top, 50=middle, ≈88=bottom)."),
  captionSize: z.number().describe("Caption text size multiplier, 0.5–2.5 (1 = default)."),
  captionStart: z.number().describe("Second (source time) the caption appears. 0 = from the clip start."),
  captionEnd: z.number().describe("Second (source time) the caption disappears. 0 = until the clip end."),

  // ── Text styling (applies to BOTH the caption and any subtitles) ──
  captionFont: z.enum(FONT_KEYS).describe("Font for caption + subtitles: 'bold' = heavy Montserrat (default, CapCut look), 'impact' = Anton (bold meme/hype), 'condensed' = tall Bebas Neue (clean, cinematic), 'sans' = clean Poppins, 'serif' = elegant DM Serif, 'round' = chunky friendly Lilita, 'marker' = hand-drawn Permanent Marker, 'mono' = Space Mono (techy)."),
  captionTemplate: z.enum(["outline", "box", "shadow", "pop"]).describe("Text style for caption + subtitles: 'outline' (black outline), 'box' (solid background behind text), 'shadow' (drop shadow), 'pop' (thick outline + shadow)."),
  captionColor: z.string().describe("Text color for caption + subtitles as a 6-digit hex WITHOUT '#'. Examples: FFFFFF white, FFE000 yellow, 000000 black, FF3B30 red, 34C759 green, 32ADE6 blue, FF2D92 pink, AF7BFF purple."),

  // ── Subtitles (auto-transcribed spoken words) ──
  generateSubtitles: z.boolean().describe("Set true ONLY when the user wants auto subtitles/captions of the SPOKEN words (e.g. 'add subtitles', 'subtitle this', 'captions in Spanish'). This triggers AI transcription separately — leave the caption field unchanged when true."),
  subtitleLanguage: z.enum(["original", "en", "es", "fr", "ar", "de", "pt", "hi", "ja", "it", "ru", "zh", "ko", "tr", "nl", "pl"]).describe("Target language for subtitles when generateSubtitles is true: 'original' keeps the spoken language; otherwise translate. Use 'original' when not generating subtitles."),
  subtitleStyle: z.enum(["classic", "karaoke", "word"]).describe("Animated caption style: 'karaoke' = full phrase with the spoken word highlighted (the lively TikTok/CapCut look), 'word' = one big word at a time, 'classic' = plain static lines. Pick 'karaoke' for 'animated/word-by-word/highlighted/karaoke captions'; keep the current value otherwise."),
  subtitleEmoji: z.boolean().describe("Auto-add emoji to the animated captions — AI tags impactful keywords with a fitting emoji (the Opus Clip / CapCut look). Set true for 'add emojis/emoji captions/auto emoji'. Only applies to 'karaoke' or 'word' subtitle styles; ignored for 'classic'."),

  // ── Framing / crop ──
  cropAspect: z.enum(["original", "9:16", "1:1", "4:5", "16:9"]).describe(
    "Output aspect ratio. 9:16 = vertical (TikTok/Shorts/Reels), 1:1 = square, 4:5 = portrait, 16:9 = landscape, original = no crop.",
  ),
  cropFill: z.enum(["crop", "blur"]).describe("How to fill the frame when cropAspect is NOT 'original': 'crop' zooms the video to fill the frame (loses edges); 'blur' fits the WHOLE video with a blurred copy of it behind as background (no cropping). Ignored when cropAspect is 'original'."),
  cropX: z.number().describe("Static horizontal crop position 0–100 (0=left, 50=center, 100=right). Used only when cropKeys is empty."),
  cropKeys: z.array(z.object({
    time: z.number().describe("Seconds from the start of the clip"),
    x: z.number().describe("Crop position at that time: 0=left, 50=center, 100=right"),
  })).describe("Time-based crop keyframes for a MOVING crop (give ≥2). Empty array for a fixed crop."),
  cropSmooth: z.boolean().describe("When using cropKeys: true = pan smoothly between positions, false = hard cut (snap)."),

  // ── Zoom (static or animated) ──
  zoom: z.number().describe("Static zoom magnification 1.0–3.0. 1 = no zoom. Used only when zoomKeys is empty."),
  zoomKeys: z.array(z.object({
    time: z.number().describe("Seconds from the start of the clip"),
    z: z.number().describe("Zoom factor 1.0–3.0 at that time"),
  })).describe("Time-based zoom keyframes for an ANIMATED zoom (give ≥2). Empty array for a fixed zoom. Punch-in example: [{time:0,z:1},{time:2,z:1.8}]."),
  zoomSmooth: z.boolean().describe("When using zoomKeys: true = ramp smoothly between zooms, false = snap at each keyframe."),

  // ── Look + audio ──
  speed: z.number().describe("Playback speed multiplier; must be one of 0.5, 0.75, 1, 1.25, 1.5, 2."),
  brightness: z.number().describe("Brightness -50 to 50 (0 = unchanged)"),
  contrast: z.number().describe("Contrast -50 to 50 (0 = unchanged)"),
  saturation: z.number().describe("Color saturation -50 to 50 (0 = unchanged, negative = washed out, positive = more vivid)"),
  colorFilter: z.enum(["none", "bw", "sepia", "vivid", "warm", "cool", "faded"]).describe("Color look preset: 'bw' = black & white, 'sepia' = vintage brown, 'vivid' = punchy colors, 'warm' = orange tint, 'cool' = blue tint, 'faded' = muted/matte. 'none' = no filter."),
  mirror: z.boolean().describe("Flip the video horizontally (mirror image). Use for 'mirror/flip the video'."),
  fadeIn: z.number().describe("Fade from black at the start, in seconds 0–3 (0 = none). Typical: 0.5–1."),
  fadeOut: z.number().describe("Fade to black at the end, in seconds 0–3 (0 = none). Typical: 0.5–1."),
  vignette: z.boolean().describe("Darkened frame edges (cinematic vignette)."),
  effects: z.array(z.object({
    type: z.enum(["flash", "blur", "bw", "vivid", "warm", "cool", "invert", "dim", "punch"]).describe("Effect look for this window: flash = white flash, invert = negative (glitchy hit), dim = darken (dramatic pause), punch = contrast+saturation hit"),
    start: z.number().describe("Window start, seconds (source time)"),
    end: z.number().describe("Window end, seconds (source time, > start)"),
  })).describe("TIMED effect segments — each look applies only between start..end (e.g. flash at a highlight, blur an intro, B&W for a flashback). Empty array = none. This REPLACES the existing segment list, so include existing segments you want to keep."),
  videoVolume: z.number().describe("Original audio volume 0–100"),
  volumeKeys: z.array(z.object({
    time: z.number().describe("Seconds (source time)"),
    v: z.number().describe("Volume % at that time, 0–200"),
  })).describe("Volume keyframes for ducking/ramping audio over time (give ≥2; ramps smoothly between them). Empty array = static volume. REPLACES the existing list."),
  loudnorm: z.boolean().describe("Auto-level (normalize) loudness on export. Use for 'fix/level the audio', 'make the volume consistent'."),
  videoPitch: z.number().describe("Voice/audio pitch shift in semitones, -12 to +12 (0 = unchanged). Negative = deeper, positive = higher/chipmunk."),

  // ── Intro / outro cards ──
  introText: z.string().describe("Text for a 3-second black intro card. Empty string for none."),
  outroText: z.string().describe("Text for a 3-second black outro card. Empty string for none."),
});

export type ClipEdits = z.infer<typeof editSchema>;

// The natural-language assistant also drives the timeline (segments + their
// volume), the overlay/audio tracks, and split screen / facecam framing.
// Kept off the shared editSchema so the one-click Auto-edit is unaffected.
export const aiEditSchema = editSchema.extend({
  segments: z.array(z.object({
    start: z.number().describe("Segment start, SOURCE seconds"),
    end: z.number().describe("Segment end, SOURCE seconds (> start)"),
    volume: z.number().describe("This segment's audio volume %, 0–200 (100 = unchanged, 0 = muted)"),
  })).describe(
    "The full ordered list of timeline segments (cuts of the source, played back to back). Use it to CUT OUT parts " +
    "(\"remove 10–15s\" → segments before and after the gap), reorder, or set PER-SEGMENT volume (\"mute the second " +
    "segment\", \"make 20–30s louder\" → split there and set volume). When set, it REPLACES the timeline and trimStart/" +
    "trimEnd are ignored. EMPTY ARRAY = leave the timeline exactly as it is (the usual answer).",
  ),
  trackEdits: z.array(z.object({
    id: z.string().describe("id of an existing track item from the current settings (\"__music\" = background music)"),
    start: z.number().describe("New start, TIMELINE seconds; -1 = unchanged. Music always starts at 0."),
    duration: z.number().describe("New length in seconds; -1 = unchanged. For music 0 = the whole clip."),
    volume: z.number().describe("New volume %, 0–200 (music 0–100); -1 = unchanged. Images have no volume."),
    remove: z.boolean().describe("true = delete this item from the timeline"),
  })).describe("Changes to EXISTING overlay/audio track items (sound effects, footage, images, music). Only list items to change. Empty array = none."),
  splitScreen: z.enum(["keep", "off", ...SPLIT_LAYOUT_KEYS]).describe(
    "Split-screen layout: 'facecam' = webcam on top + gameplay below (the streamer look), 'stack2' = 2 stacked, " +
    "'stack3' = 3 stacked, 'top1bottom2' = 1 + 2, 'grid4' = 2×2. 'off' = no split. 'keep' = unchanged (the usual answer).",
  ),
  detectFacecam: z.boolean().describe(
    "true = auto-detect the streamer's webcam and frame the top screen on the WHOLE cam (implies a split layout; uses " +
    "'facecam' if none is set). For 'put the facecam on top', 'cam on top, gameplay below', 'fix/fit the facecam'.",
  ),
  splitTopHeight: z.number().describe("Height of the top screen in 2-screen stacked layouts, % of the frame 20–60. 0 = unchanged."),
});
