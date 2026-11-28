import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { autoResponses, accounts } from "@/lib/schema";
import { eq, and } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import { AUTO_REPLY_PLATFORMS, MAX_TEMPLATE_LENGTH, parseKeywords, splitVariants, joinVariants } from "@/lib/auto-reply";

type RuleInput = { triggerKeyword?: unknown; responseTemplate?: unknown; respondToComments?: unknown; isActive?: unknown };

/** Validate the editable fields. Only these can ever be written by a client. */
function parseRule(b: RuleInput, partial: boolean):
  { ok: true; value: Partial<{ triggerKeyword: string | null; responseTemplate: string; respondToComments: boolean; isActive: boolean }> } | { ok: false; error: string } {
  const out: Partial<{ triggerKeyword: string | null; responseTemplate: string; respondToComments: boolean; isActive: boolean }> = {};
  if (b.responseTemplate !== undefined || !partial) {
    const variants = splitVariants(typeof b.responseTemplate === "string" ? b.responseTemplate : "");
    if (variants.length === 0) return { ok: false, error: "Write at least one reply." };
    if (variants.length > 10) return { ok: false, error: "Up to 10 reply variations." };
    if (variants.some((v) => v.length > MAX_TEMPLATE_LENGTH)) return { ok: false, error: `Each reply must be ${MAX_TEMPLATE_LENGTH} characters or less.` };
    out.responseTemplate = joinVariants(variants);
  }
  if (b.triggerKeyword !== undefined) {
    const kws = parseKeywords(typeof b.triggerKeyword === "string" ? b.triggerKeyword : "");
    if (kws.length > 20) return { ok: false, error: "Up to 20 keywords per rule." };
    out.triggerKeyword = kws.length ? kws.join(", ") : null;
  }
  if (b.respondToComments !== undefined) out.respondToComments = b.respondToComments === true;
  if (b.isActive !== undefined) out.isActive = b.isActive === true;
  return { ok: true, value: out };
}

async function ownRule(userId: number, id: unknown) {
  const ruleId = Number(id);
  if (!Number.isInteger(ruleId)) return null;
  const [row] = await db
    .select({ rule: autoResponses })
    .from(autoResponses)
    .innerJoin(accounts, eq(autoResponses.accountId, accounts.id))
    .where(and(eq(autoResponses.id, ruleId), eq(accounts.userId, userId)))
    .limit(1);
  return row?.rule ?? null;
}

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
      account: { username: account.username, platform: account.platform, isActive: account.isActive },
    }))
  );
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  if (!Number.isInteger(accountId)) return NextResponse.json({ error: "Pick an account." }, { status: 400 });
  const parsed = parseRule(body, false);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, session.userId)))
    .limit(1);
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (!(AUTO_REPLY_PLATFORMS as readonly string[]).includes(account.platform)) {
    return NextResponse.json({ error: "Auto-replies work on YouTube and Instagram for now." }, { status: 400 });
  }

  const [row] = await db
    .insert(autoResponses)
    .values({
      accountId,
      triggerKeyword: parsed.value.triggerKeyword ?? null,
      responseTemplate: parsed.value.responseTemplate!,
      respondToComments: parsed.value.respondToComments ?? true,
      // Start the cursor now: only comments posted after the rule exists get a reply.
      lastCheckedAt: new Date().toISOString(),
    })
    .returning();

  return NextResponse.json({ ...row, account: { username: account.username, platform: account.platform, isActive: account.isActive } });
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json().catch(() => ({}));
  const rule = await ownRule(session.userId, id);
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.delete(autoResponses).where(eq(autoResponses.id, rule.id));
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const rule = await ownRule(session.userId, body.id);
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = parseRule(body, true);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const updates: Partial<typeof autoResponses.$inferInsert> = { ...parsed.value };
  // Resuming a paused rule shouldn't answer the backlog that piled up meanwhile.
  if (parsed.value.isActive === true && !rule.isActive) {
    updates.lastCheckedAt = new Date().toISOString();
    updates.lastError = null;
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const [row] = await db.update(autoResponses).set(updates).where(eq(autoResponses.id, rule.id)).returning();
  return NextResponse.json(row);
}
