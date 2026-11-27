// Shared guard for cron-triggered routes. Vercel Cron sends CRON_SECRET as a
// Bearer token. Without a secret we only allow requests outside hosted
// production (local dev, the desktop app), so a missing env var on Vercel
// closes the endpoint instead of opening it to the internet.
import { isDesktop } from "./desktop";

export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production" || isDesktop();
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
