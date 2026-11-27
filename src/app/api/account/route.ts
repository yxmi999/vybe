import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { client } from "@/lib/db";
import { deleteUserAccount } from "@/lib/account";
import { isDesktop } from "@/lib/desktop";

export const runtime = "nodejs";
export const maxDuration = 120;

// Permanently deletes the signed-in user's account and everything in it.
// Body: { confirm: "<the account's email>" } — typed by the user as a guard.
export async function DELETE(req: NextRequest) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isDesktop()) {
    return NextResponse.json({ error: "The desktop app keeps your data on this computer — uninstall it to remove everything." }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim().toLowerCase() : "";

  const res = await client.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [session.userId] });
  const email = String((res.rows[0] as { email?: string } | undefined)?.email ?? "").toLowerCase();
  if (!email) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (confirm !== email) {
    return NextResponse.json({ error: "Type your account email exactly to confirm." }, { status: 400 });
  }

  try {
    await deleteUserAccount(session.userId);
  } catch (err) {
    console.error("[account/delete]", err instanceof Error ? err.message : err);
    return NextResponse.json({
      error: "We couldn't cancel your subscription automatically, so nothing was deleted. Cancel it from the Billing page, then try again.",
    }, { status: 502 });
  }

  const out = NextResponse.json({ ok: true });
  out.cookies.set("vybe_token", "", { maxAge: 0, path: "/" });
  return out;
}
