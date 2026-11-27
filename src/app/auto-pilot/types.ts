// Shared client types for the Auto-Pilot page + builder.
export type Limits = { autoPilotEnabled: boolean; maxAutoPilots: number; autoClipsPerMonth: number; maxClipsPerRun: number };
export type PilotStats = { review: number; scheduled: number; posted: number; failed: number };
export type Pilot = {
  id: number; enabled: boolean; platform: string; channel: string; targetAccountId: number | null;
  cadence: string; days: string | null; postTimes: string | null; clipsPerRun: number;
  minConfidence: number; autoPost: boolean; lastRunAt: string | null; nextRunAt: string | null; lastError: string | null;
  template: string | null; stats?: PilotStats;
  liveMode?: boolean | null; liveState?: string | null; liveClips?: number | null; liveVodId?: string | null;
};
export type Account = { id: number; platform: string; username: string };
export type CampaignOption = { id: number; name: string; cpm: number; currency: string; isDefault: boolean | null };
export type ChannelInfo = {
  login: string; displayName: string; avatar: string;
  vods: { title: string; thumbnail: string; durationSec: number; startTime: string }[];
};

export const DAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_FULL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// "Daily at 18:00", "Mon, Wed, Fri at 18:00 & 21:00"
export function scheduleText(cadence: string, days: number[], times: string[]): string {
  const when = cadence === "daily" ? "Daily" : days.length ? days.map((d) => DAY_FULL[d]).join(", ") : "No days picked";
  const at = times.length ? ` at ${times.join(" & ")}` : "";
  return when + at;
}
