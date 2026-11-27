import { NextResponse } from "next/server";

// Only applied to mobile-facing routes (auth/mobile/*, jobs/*, oauth init with
// ?client=mobile) — the web portal stays cookie + same-origin and untouched.
const ALLOWED_ORIGIN = process.env.MOBILE_APP_ORIGIN ?? "*";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export function withCors<T extends NextResponse>(res: T): T {
  for (const [key, value] of Object.entries(corsHeaders())) res.headers.set(key, value);
  return res;
}

export function corsPreflight() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
