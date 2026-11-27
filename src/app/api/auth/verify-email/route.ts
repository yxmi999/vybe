import { NextRequest, NextResponse } from "next/server";
import { consumeVerificationToken } from "@/lib/email-verification";

// The link in the verification email. Public (the link may be opened on a
// different device than the one that's signed in); the signed token is the proof.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const userId = token ? await consumeVerificationToken(token) : null;
  const dest = new URL(userId ? "/dashboard?verified=1" : "/dashboard?verified=invalid", req.nextUrl.origin);
  return NextResponse.redirect(dest);
}
