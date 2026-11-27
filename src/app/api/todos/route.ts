import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { todos } from "@/lib/schema";
import { eq, and, desc } from "drizzle-orm";
import { getServerSession } from "@/lib/auth";

async function auth() {
  const session = await getServerSession();
  return session ?? null;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select()
    .from(todos)
    .where(eq(todos.userId, session.userId))
    .orderBy(desc(todos.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { title = "", url = "", note = "" } = await req.json();
  if (!String(title).trim() && !String(url).trim() && !String(note).trim()) {
    return NextResponse.json({ error: "Empty to-do" }, { status: 400 });
  }

  const [row] = await db
    .insert(todos)
    .values({
      userId: session.userId,
      title: String(title).trim() || null,
      url: String(url).trim() || null,
      note: String(note).trim() || null,
      done: false,
    })
    .returning();
  return NextResponse.json(row);
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, ...patch } = await req.json();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const fields: Partial<{ title: string | null; url: string | null; note: string | null; done: boolean }> = {};
  if ("title" in patch) fields.title = String(patch.title ?? "").trim() || null;
  if ("url"   in patch) fields.url   = String(patch.url   ?? "").trim() || null;
  if ("note"  in patch) fields.note  = String(patch.note  ?? "").trim() || null;
  if ("done"  in patch) fields.done  = !!patch.done;

  await db
    .update(todos)
    .set(fields)
    .where(and(eq(todos.id, id), eq(todos.userId, session.userId)));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json();
  await db.delete(todos).where(and(eq(todos.id, id), eq(todos.userId, session.userId)));
  return NextResponse.json({ ok: true });
}
