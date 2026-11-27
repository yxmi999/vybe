import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { clipStyles } from "@/lib/schema";
import { ensureStylesTable, parseInlineStyle } from "@/lib/style-store";

async function own(userId: number, idParam: string) {
  const id = Number(idParam);
  if (!Number.isInteger(id)) return null;
  await ensureStylesTable();
  const [row] = await db.select().from(clipStyles)
    .where(and(eq(clipStyles.id, id), eq(clipStyles.userId, userId))).limit(1);
  return row ?? null;
}

// PATCH → rename and/or replace the recipe: { name?, style? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await own(session.userId, (await params).id);
  if (!row) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as { name?: string; style?: unknown };
  const name = body.name?.trim().slice(0, 40) || row.name;
  const style = body.style !== undefined ? parseInlineStyle(body.style) : parseInlineStyle(JSON.parse(row.style));
  if (!style) return NextResponse.json({ error: "Invalid style." }, { status: 400 });

  await db.update(clipStyles)
    .set({ name, style: JSON.stringify({ ...style, name }) })
    .where(eq(clipStyles.id, row.id));
  return NextResponse.json({ ref: `user:${row.id}`, id: row.id, name, style: { ...style, name }, source: row.source, builtin: false });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await own(session.userId, (await params).id);
  if (!row) return NextResponse.json({ error: "Style not found" }, { status: 404 });
  await db.delete(clipStyles).where(eq(clipStyles.id, row.id));
  return NextResponse.json({ ok: true });
}
