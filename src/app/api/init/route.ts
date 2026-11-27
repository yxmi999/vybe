import { NextResponse } from "next/server";
import { migrate } from "@/lib/migrate";

let initialized = false;

export async function GET() {
  if (!initialized) {
    await migrate();
    initialized = true;
  }
  return NextResponse.json({ ok: true });
}
