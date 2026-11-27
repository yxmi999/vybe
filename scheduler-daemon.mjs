/**
 * Local stand-in for the Vercel crons (see vercel.json). Run it beside
 * `npm run dev`:
 *   node scheduler-daemon.mjs
 *
 * - every 60s:  /api/scheduler       publishes posts that are due
 * - every 10m:  /api/auto-pilot/run  runs due Auto-Pilots (incl. Live mode checks)
 */
import { setInterval } from "timers";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const CRON_SECRET = process.env.CRON_SECRET;
const headers = CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {};

async function call(label, path) {
  try {
    const res = await fetch(`${APP_URL}${path}`, { method: "POST", headers });
    const data = await res.json();
    console.log(`[${new Date().toISOString()}] ${label}:`, JSON.stringify(data).slice(0, 400));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ${label} error:`, err.message);
  }
}

// An Auto-Pilot run can take minutes (cutting + rendering); never overlap two.
let pilotBusy = false;
async function pilots() {
  if (pilotBusy) return;
  pilotBusy = true;
  try { await call("Auto-Pilot", "/api/auto-pilot/run"); } finally { pilotBusy = false; }
}

console.log("Scheduler daemon started: posts every 60s, Auto-Pilot every 10 min.");
call("Scheduler", "/api/scheduler");
pilots();
setInterval(() => call("Scheduler", "/api/scheduler"), 60_000);
setInterval(pilots, 10 * 60_000);
