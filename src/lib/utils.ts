import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export async function safeFetch<T = unknown>(
  input: RequestInfo,
  init?: RequestInit,
  fallback?: T
): Promise<T> {
  try {
    const res = await fetch(input, init);
    const text = await res.text();
    if (!text) return fallback as T;
    return JSON.parse(text) as T;
  } catch {
    return fallback as T;
  }
}

// Parses a fetch Response as JSON without letting a non-JSON body (an HTML
// error page from a timeout/crash, a proxy's plaintext error, an empty body)
// surface as a raw "JSON.parse: unexpected character..." exception — that
// message tells the user nothing actionable. Callers keep their existing
// `const data = await parseJsonResponse(res); if (!res.ok) throw new Error(data.error ?? ...)`
// shape unchanged (return type mirrors `res.json()`'s `Promise<any>`, plus a
// guaranteed `.error` string on the synthesized-failure path).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return { error: `Empty response (${res.status})` };
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: res.status >= 500
        ? "The server took too long or hit an error — try again, or use a shorter clip / fewer results."
        : `Request failed (${res.status})`,
    };
  }
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// crypto.randomUUID only exists in secure contexts (HTTPS/localhost). On a
// phone hitting the dev server over plain HTTP via a LAN IP it's undefined, so
// fall back to a manual UUID v4 built from getRandomValues / Math.random.
export function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function platformColor(platform: string) {
  switch (platform) {
    case "instagram": return "bg-gradient-to-r from-purple-500 to-pink-500";
    case "twitter": return "bg-sky-500";
    case "tiktok": return "bg-black";
    case "youtube": return "bg-red-600";
    default: return "bg-gray-500";
  }
}

export function platformIcon(platform: string) {
  switch (platform) {
    case "instagram": return "📸";
    case "twitter": return "𝕏";
    case "tiktok": return "🎵";
    case "youtube": return "▶️";
    default: return "📱";
  }
}

export function statusColor(status: string) {
  switch (status) {
    case "published": return "text-green-600 bg-green-100";
    case "scheduled": return "text-blue-600 bg-blue-100";
    case "failed": return "text-red-600 bg-red-100";
    case "draft": return "text-gray-600 bg-gray-100";
    default: return "text-gray-600 bg-gray-100";
  }
}
