import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accounts, publicAccountColumns } from "@/lib/schema";
import { eq, and, ne } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import * as tiktok from "@/lib/platforms/tiktok";

async function auth() {
  const session = await getServerSession();
  if (!session) return null;
  return session;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select(publicAccountColumns)
    .from(accounts)
    .where(and(eq(accounts.userId, session.userId), ne(accounts.isActive, false)))
    .orderBy(accounts.createdAt);
  return NextResponse.json(rows);
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json();
  const [acct] = await db
    .select({ platform: accounts.platform, accessToken: accounts.accessToken })
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, session.userId)))
    .limit(1);
  if (!acct) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (acct.platform === "tiktok" && acct.accessToken) {
    await tiktok.revokeAccess(acct.accessToken).catch((err) => console.error("[accounts] tiktok revoke failed:", err?.message));
  }
  // Soft-delete keeps posts/analytics history, but the OAuth tokens are wiped so
  // Vybe can no longer act on the platform account. Reconnecting stores new ones.
  await db
    .update(accounts)
    .set({ isActive: false, accessToken: "", refreshToken: null, tokenExpiry: null })
    .where(and(eq(accounts.id, id), eq(accounts.userId, session.userId)));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, isActive } = await req.json();
  // A disconnected account has no tokens; it can only come back by reconnecting.
  const where = isActive
    ? and(eq(accounts.id, id), eq(accounts.userId, session.userId), ne(accounts.accessToken, ""))
    : and(eq(accounts.id, id), eq(accounts.userId, session.userId));
  await db.update(accounts).set({ isActive: !!isActive }).where(where);
  return NextResponse.json({ ok: true });
}
