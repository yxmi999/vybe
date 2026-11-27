// Desktop app only: apply API keys / OAuth app credentials entered on the
// Settings page. The Electron shell stores them encrypted (OS keychain) and
// pushes them here at startup and on every save, so they take effect without
// a restart. Only whitelisted names can be set. Guarded by the shell's
// per-launch secret; 404 everywhere else, including the cloud build.
import { NextRequest, NextResponse } from "next/server";
import { DESKTOP_KEY_NAMES, isDesktopControlRequest, type DesktopKeyName } from "@/lib/desktop";

// Many call sites check the single-key name to see whether AI is configured;
// keep it pointing at the first key of the pool.
const SINGLE_OF: Partial<Record<DesktopKeyName, string>> = {
  GOOGLE_GENERATIVE_AI_API_KEYS: "GOOGLE_GENERATIVE_AI_API_KEY",
  GROQ_API_KEYS: "GROQ_API_KEY",
};

export async function POST(req: NextRequest) {
  if (!isDesktopControlRequest(req)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const applied: string[] = [];
  for (const name of DESKTOP_KEY_NAMES) {
    if (!(name in body)) continue;
    const raw = body[name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) process.env[name] = value;
    else delete process.env[name];
    const single = SINGLE_OF[name];
    if (single) {
      const first = value.split(",").map((k) => k.trim()).find(Boolean);
      if (first) process.env[single] = first;
      else delete process.env[single];
    }
    applied.push(name);
  }
  return NextResponse.json({ ok: true, applied });
}
