import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { autoResponses, accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({ ar: autoResponses, account: accounts })
    .from(autoResponses)
    .innerJoin(accounts, and(eq(autoResponses.accountId, accounts.id), eq(accounts.userId, session.userId)))
    .orderBy(autoResponses.createdAt);

  return NextResponse.json(
    rows.map(({ ar, account }) => ({
      ...ar,
      account: { username: account.username, platform: account.platform },
    }))
  );
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { accountId, triggerKeyword, responseTemplate, respondToComments, respondToLikes } = await req.json();
  if (!accountId || !responseTemplate?.trim())
    return NextResponse.json({ error: "accountId and responseTemplate are required" }, { status: 400 });

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, session.userId)))
    .limit(1);
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const [row] = await db
    .insert(autoResponses)
    .values({ accountId, triggerKeyword: triggerKeyword || null, responseTemplate, respondToComments, respondToLikes })
    .returning();

  return NextResponse.json({ ...row, account: { username: account.username, platform: account.platform } });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json();

  // Verify the rule belongs to this user before deleting
  const [rule] = await db
    .select({ id: autoResponses.id })
    .from(autoResponses)
    .innerJoin(accounts, eq(autoResponses.accountId, accounts.id))
    .where(and(eq(autoResponses.id, id), eq(accounts.userId, session.userId)))
    .limit(1);
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.delete(autoResponses).where(eq(autoResponses.id, id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, ...updates } = await req.json();

  // Verify the rule belongs to this user before updating
  const [rule] = await db
    .select({ id: autoResponses.id })
    .from(autoResponses)
    .innerJoin(accounts, eq(autoResponses.accountId, accounts.id))
    .where(and(eq(autoResponses.id, id), eq(accounts.userId, session.userId)))
    .limit(1);
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.update(autoResponses).set(updates).where(eq(autoResponses.id, id));
  return NextResponse.json({ ok: true });
}
