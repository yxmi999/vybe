// Shared types and constants for the clip editor (extracted from page.tsx).

export type Platform = "twitch" | "kick" | "youtube" | "tiktok" | "instagram" | "local" | "ai";

export type ClipInfo = {
  platform: Platform;
  title: string;
  duration: number;
  thumbnailUrl: string;
  videoUrl: string;
  streamer: string;
  alreadySaved?: boolean;
  clipPageUrl?: string;
};

export type AssetItem = {
  id: string;
  type: "sound" | "image" | "video";
  name: string;
  localUrl: string;
  serverUrl: string;
  uploading: boolean;
  timestamp: number;
  duration: number;
  volume: number;
  x: number;
  y: number;
  scale: number;
};

export function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Editor timecode with tenths — precise enough to land a cut, short enough to scan.
export function formatTimecode(s: number) {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const tenth = Math.floor((t * 10) % 10);
  return `${m}:${sec.toString().padStart(2, "0")}.${tenth}`;
}

export type SubWord = { word: string; start: number; end: number; emoji?: string };
export type Subtitle = { id: string; start: number; end: number; text: string; words?: SubWord[] };

export const SUB_LANGS: { code: string; label: string }[] = [
  { code: "original", label: "Original (no translation)" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "ar", label: "Arabic" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "it", label: "Italian" },
  { code: "ru", label: "Russian" },
  { code: "zh", label: "Chinese" },
  { code: "ko", label: "Korean" },
  { code: "tr", label: "Turkish" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
];

// Valid keys the AI assistant may set for text styling.
export { FONT_KEYS } from "@/lib/clip-filters";
export const TEMPLATE_KEYS = ["outline", "box", "shadow", "pop"] as const;

export const P: Record<Platform, { bg: string; text: string; dot: string; label: string; icon: string }> = {
  twitch:    { bg: "bg-purple-500/10", text: "text-purple-300", dot: "bg-purple-400", label: "Twitch",     icon: "🎮" },
  kick:      { bg: "bg-green-500/10",  text: "text-green-300",  dot: "bg-green-400",  label: "Kick",       icon: "🎯" },
  youtube:   { bg: "bg-red-500/10",    text: "text-red-300",    dot: "bg-red-400",    label: "YouTube",    icon: "▶"  },
  tiktok:    { bg: "bg-white/[0.06]",  text: "text-white/55",   dot: "bg-white/40",   label: "TikTok",     icon: "♪"  },
  instagram: { bg: "bg-pink-500/10",   text: "text-pink-300",   dot: "bg-pink-400",   label: "Instagram",  icon: "📷" },
  local:     { bg: "bg-white/[0.06]",  text: "text-white/45",   dot: "bg-white/30",   label: "Local",      icon: "📁" },
  ai:        { bg: "bg-violet-500/10", text: "text-violet-300", dot: "bg-violet-400", label: "AI",         icon: "✨" },
};

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
