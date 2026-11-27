// Meta's "Data deletion request URL". Called (POST, form field
// `signed_request`) when a user asks Meta to have Vybe delete their Instagram
// data. Must reply with a status URL and a confirmation code.
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { accounts } from "@/lib/schema";
import { and, eq } from "drizzle-orm";
import * as instagram from "@/lib/platforms/instagram";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const signed = form?.get("signed_request");
  const data = typeof signed === "string" ? instagram.parseSignedRequest(signed) : null;
  if (!data) return NextResponse.json({ error: "invalid signed_request" }, { status: 400 });

  // Remove the stored Instagram profile + tokens entirely.
  await db
    .delete(accounts)
    .where(and(eq(accounts.platform, "instagram"), eq(accounts.platformUserId, data.user_id)));

  const code = crypto.randomBytes(8).toString("hex");
  return NextResponse.json({
    url: `${APP_URL}/privacy?instagram_deletion=${code}`,
    confirmation_code: code,
  });
}
