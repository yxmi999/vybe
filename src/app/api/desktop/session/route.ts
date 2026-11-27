// Desktop app only: the Electron shell calls this at startup to sign the
// window in as the single local user — the desktop app has no accounts of its
// own, so there's no login screen. Guarded by the shell's per-launch secret
// (x-vybe-desktop header); 404 everywhere else, including the cloud build.
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { migrate } from "@/lib/migrate";
import { signToken } from "@/lib/auth";
import { isDesktopControlRequest } from "@/lib/desktop";

const LOCAL_EMAIL = "local@vybe.desktop";

export async function POST(req: NextRequest) {
  if (!isDesktopControlRequest(req)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await migrate();
  // The first user in this local DB is "you". A fresh install creates it.
  let [user] = await db.select().from(users).orderBy(asc(users.id)).limit(1);
  if (!user) {
    // Never used to sign in (there's no login screen), but the column is required.
    const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), 10);
    [user] = await db.insert(users).values({ email: LOCAL_EMAIL, name: "You", passwordHash, plan: "free" }).returning();
  }
  const token = await signToken({ userId: user.id, email: user.email, name: user.name ?? "You" });
  return NextResponse.json({ token, userId: user.id });
}
