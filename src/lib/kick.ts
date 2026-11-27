import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

// Kick's public site API (no key needed) sits behind Cloudflare, which
// fingerprints the TLS handshake: Node's fetch gets a 403 while curl passes.
// So: try fetch first (cheap), and fall back to spawning curl — bundled with
// Windows 10+, macOS, and most Linux — when Cloudflare blocks us.
export const KICK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": KICK_UA,
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
};

export type KickResponse = { status: number; ok: boolean; data: unknown };

async function curlGet(url: string): Promise<KickResponse> {
  const { stdout } = await execFileP(
    "curl",
    [
      "-s", "-w", "\n%{http_code}",
      "-H", `User-Agent: ${KICK_UA}`,
      "-H", "Accept: application/json",
      "-H", "Accept-Language: en-US,en;q=0.9",
      "--max-time", "20",
      url,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const i = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(i + 1).trim()) || 0;
  const body = stdout.slice(0, i);
  let data: unknown = null;
  try { data = JSON.parse(body); } catch { /* non-JSON (e.g. a challenge page) */ }
  return { status, ok: status >= 200 && status < 300 && data !== null, data };
}

// Once Cloudflare 403s a fetch, it will keep doing so — remember it for a
// while so bulk scans (hundreds of requests) don't pay a wasted fetch each.
let cfBlockedUntil = 0;

/** GET a Kick API path relative to https://kick.com/api/ — e.g. "v2/channels/xqc". */
export async function kickGet(path: string): Promise<KickResponse> {
  const url = `https://kick.com/api/${path}`;
  if (Date.now() >= cfBlockedUntil) {
    try {
      const res = await fetch(url, { headers: HEADERS, cache: "no-store" });
      if (res.status !== 403) {
        let data: unknown = null;
        try { data = await res.json(); } catch { /* ignore */ }
        return { status: res.status, ok: res.ok && data !== null, data };
      }
      cfBlockedUntil = Date.now() + 10 * 60_000;
    } catch { /* network error — let curl try */ }
  }
  // Cloudflare rejected Node's TLS fingerprint — curl's passes.
  try {
    return await curlGet(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT/.test(msg)) {
      return { status: 0, ok: false, data: { error: "curl is not installed — needed to reach Kick behind Cloudflare." } };
    }
    return { status: 0, ok: false, data: null };
  }
}

/** Accepts "xqc", "kick.com/xqc", or a full URL — returns the channel slug. */
export function parseKickSlug(input: string): string {
  return String(input).trim()
    .replace(/^(https?:\/\/)?(www\.)?kick\.com\//i, "")
    .split(/[/?#]/)[0]
    .toLowerCase();
}
