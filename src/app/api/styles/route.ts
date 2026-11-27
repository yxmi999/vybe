import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { clipStyles } from "@/lib/schema";
import { builtinStyles, ensureStylesTable, listUserStyles, parseInlineStyle } from "@/lib/style-store";

const MAX_STYLES = 50;

// GET  → built-in presets + the user's saved styles.
// POST → save a (usually freshly analyzed) style: { name?, style, source? }.
export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ builtin: builtinStyles(), saved: await listUserStyles(session.userId) });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { name?: string; style?: unknown; source?: string };
  const style = parseInlineStyle(body.style);
  if (!style) return NextResponse.json({ error: "Invalid style." }, { status: 400 });
  const name = (body.name?.trim() || style.name).slice(0, 40);

  const existing = await listUserStyles(session.userId);
  if (existing.length >= MAX_STYLES) {
    return NextResponse.json({ error: `You can save up to ${MAX_STYLES} styles — delete one first.` }, { status: 400 });
  }

  await ensureStylesTable();
  const [row] = await db.insert(clipStyles).values({
    userId: session.userId,
    name,
    style: JSON.stringify({ ...style, name }),
    source: body.source?.slice(0, 300) ?? null,
  }).returning();

  return NextResponse.json({
    ref: `user:${row.id}`, id: row.id, name, style: { ...style, name }, source: row.source, builtin: false,
  });
}
