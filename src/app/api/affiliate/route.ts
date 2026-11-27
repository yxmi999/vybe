import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth";
import { isDesktop } from "@/lib/desktop";
import { getAffiliateSummary, isPayoutMethod, requestPayout, setPayoutDetails } from "@/lib/affiliate";
import { recordSignals, requestCountry, savePayoutProfile } from "@/lib/affiliate-safety";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// GET    → the signed-in user's affiliate dashboard (creates their code on first visit)
// PUT    → { method, details } save payout details
//          { profile: { legalName, country, address, usPerson, acceptTerms } } save payout identity
// POST   → request a payout of the available balance
async function guard() {
  if (isDesktop()) return { error: NextResponse.json({ error: "The affiliate program is only on the Vybe website." }, { status: 404 }) };
  const session = await getServerSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { session };
}

export async function GET(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  // Long-lived sessions rarely hit /login, so the dashboard also records signals.
  await recordSignals(g.session.userId, req, "login");
  try {
    return NextResponse.json(await getAffiliateSummary(g.session.userId));
  } catch (err) {
    console.error("[affiliate]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't load your affiliate dashboard." }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => ({}));

  if (body?.profile !== undefined) {
    const limit = await rateLimit(`affiliate:profile:${g.session.userId}`, 10, 3600);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSec);
    const result = await savePayoutProfile(g.session.userId, body.profile);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  const details = typeof body?.details === "string" ? body.details.trim() : "";
  if (!isPayoutMethod(body?.method)) return NextResponse.json({ error: "Pick a payout method." }, { status: 400 });
  if (details.length < 4 || details.length > 200) {
    return NextResponse.json({ error: "Enter your PayPal email, wallet address or Wise email." }, { status: 400 });
  }
  if ((body.method === "paypal" || body.method === "wise") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (body.method === "crypto" && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(details)) {
    return NextResponse.json({ error: "Enter a valid USDT TRC-20 address (starts with T, 34 characters)." }, { status: 400 });
  }
  await setPayoutDetails(g.session.userId, body.method, details);
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  await recordSignals(g.session.userId, req, "payout");
  const result = await requestPayout(g.session.userId, { requestCountry: requestCountry(req) });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
