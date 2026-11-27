// Wall-clock ↔ UTC conversion for a user's IANA timezone (e.g. "Europe/Paris").
// The server runs in UTC on Vercel, so anything a user picks as "18:00" must be
// interpreted in *their* zone, not the server's. Uses Intl only (no deps) and
// handles DST: the offset is looked up for the actual instant being produced.

/** Returns `tz` if it's a valid IANA zone, else "UTC". */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall-clock date/time of `date` as seen in `tz` (month is 1-12). */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) {
    if (type !== "literal") p[type] = Number(value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (UTC+2 → +7_200_000). */
function offsetAt(ms: number, tz: string): number {
  const z = zonedParts(new Date(ms), tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant for wall-clock y-m-d h:m in `tz`. Day overflow is fine
 * (day 32 rolls into next month). A time skipped by a DST jump lands just after it.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - offsetAt(guess, tz);
  // Re-check at the result: crossing a DST boundary changes the offset.
  const second = guess - offsetAt(ms, tz);
  if (second !== ms) ms = second;
  return new Date(ms);
}

/** Day of week (0 = Sunday) of the calendar date y-m-d — timezone-free. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
