import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { client } from "@/lib/db";
import { isAdminEmail, listPayoutRequests, settlePayout } from "@/lib/affiliate";
import { setIdentityStatus, setTaxFormOnFile, type IdStatus } from "@/lib/affiliate-safety";

export const runtime = "nodejs";

// Admin-only (ADMIN_EMAILS): list affiliate payout requests (with live risk
// assessment), settle them, and record identity / tax-form checks.
// The email is re-read from the DB rather than trusted from the JWT.
async function requireAdmin() {
  const session = await getServerSession();
  if (!session) return null;
  const res = await client.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [session.userId] });
  const email = (res.rows[0] as { email?: string } | undefined)?.email;
  return isAdminEmail(email) ? session : null;
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const s = req.nextUrl.searchParams.get("status");
  const status = s === "paid" || s === "rejected" ? s : "requested";
  return NextResponse.json({ payouts: await listPayoutRequests(status) });
}

const ID_STATUSES: IdStatus[] = ["none", "pending", "verified", "rejected"];

// Body:
//   { id, action: 'paid' | 'rejected', note? }                  settle a payout
//   { userId, action: 'id_status', idStatus, note? }            record an ID check result
//   { userId, action: 'tax_form', onFile: boolean }             W-9 / W-8BEN received
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const note = typeof body?.note === "string" ? body.note : undefined;

  if (action === "id_status" || action === "tax_form") {
    const userId = Number(body?.userId);
    if (!Number.isInteger(userId) || userId <= 0) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    if (action === "id_status") {
      if (!ID_STATUSES.includes(body?.idStatus)) return NextResponse.json({ error: "Bad status" }, { status: 400 });
      await setIdentityStatus(userId, body.idStatus, note);
    } else {
      await setTaxFormOnFile(userId, body?.onFile === true);
    }
    return NextResponse.json({ ok: true });
  }

  const id = Number(body?.id);
  if (!Number.isInteger(id) || (action !== "paid" && action !== "rejected")) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const result = await settlePayout(id, action, note);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
