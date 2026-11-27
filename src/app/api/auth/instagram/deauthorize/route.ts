// Meta calls this (POST, form field `signed_request`) when a user removes Vybe
// from their Instagram "Apps and websites" settings. Set it as the
// "Deauthorize callback URL" in the Meta app's Instagram → API setup with
// Instagram login → Business login settings.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import * as instagram from "@/lib/platforms/instagram";

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const signed = form?.get("signed_request");
  const data = typeof signed === "string" ? instagram.parseSignedRequest(signed) : null;
  if (!data) return NextResponse.json({ error: "invalid signed_request" }, { status: 400 });

  // Same soft-delete as a manual disconnect: keep post history, drop tokens.
  await db
    .update(accounts)
    .set({ isActive: false, accessToken: "", refreshToken: null, tokenExpiry: null })
    .where(and(eq(accounts.platform, "instagram"), eq(accounts.platformUserId, data.user_id)));

  return NextResponse.json({ ok: true });
}
