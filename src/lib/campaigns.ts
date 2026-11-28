import { normalizeMetricGoals } from "./performance";

// Campaign revenue math, shared by the API and the analytics UI so both
// always agree. Pure functions only — safe to import client-side.

export type CampaignLike = {
  id: number;
  name: string;
  cpm: number;                // payout per 1,000 views
  currency: string;
  maxPayout: number | null;   // per-video cap; null = uncapped
  minPayout?: number | null;  // per-video qualifying minimum; below it the video earns 0
  isDefault: boolean | null;
  goals?: string | null;      // JSON metric targets for this campaign's videos (see lib/performance)
};

// The campaign a video earns from: its own assignment, else the default.
// `assignedId` pointing at a deleted campaign also falls back to the default.
export function effectiveCampaign<C extends CampaignLike>(assignedId: number | null | undefined, campaigns: C[]): C | null {
  if (assignedId != null) {
    const own = campaigns.find((c) => c.id === assignedId);
    if (own) return own;
  }
  return campaigns.find((c) => c.isDefault) ?? null;
}

// Estimated earnings for one video: views / 1000 × CPM, capped per video.
// Below the campaign's minimum payout the video doesn't qualify and earns 0.
export function videoRevenue(views: number, campaign: CampaignLike | null): number {
  if (!campaign || !(views > 0) || !(campaign.cpm > 0)) return 0;
  const raw = (views / 1000) * campaign.cpm;
  if (campaign.minPayout != null && campaign.minPayout > 0 && raw < campaign.minPayout) return 0;
  return campaign.maxPayout != null && campaign.maxPayout > 0 ? Math.min(raw, campaign.maxPayout) : raw;
}

// Views a video needs to reach the campaign's minimum payout (null = no minimum).
export function viewsToQualify(campaign: CampaignLike | null): number | null {
  if (!campaign?.minPayout || !(campaign.cpm > 0)) return null;
  return Math.ceil((campaign.minPayout / campaign.cpm) * 1000);
}

export function formatMoney(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency,
      maximumFractionDigits: amount > 0 && amount < 10 ? 2 : amount < 1000 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "MAD", "BRL", "INR"] as const;

// Validate a create/update body. Returns the clean fields or an error string.
export function parseCampaignInput(raw: unknown, partial = false):
  { ok: true; value: Partial<{ name: string; cpm: number; currency: string; maxPayout: number | null; minPayout: number | null; isDefault: boolean; goals: string | null }> } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const out: Partial<{ name: string; cpm: number; currency: string; maxPayout: number | null; minPayout: number | null; isDefault: boolean; goals: string | null }> = {};
  // Accept "1,50" as well as "1.50" (decimal comma locales).
  const Number = (v: unknown) => globalThis.Number(typeof v === "string" ? v.trim().replace(",", ".") : v);

  if (b.name !== undefined || !partial) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) return { ok: false, error: "Give the campaign a name." };
    if (name.length > 80) return { ok: false, error: "Campaign name is too long (80 max)." };
    out.name = name;
  }
  if (b.cpm !== undefined || !partial) {
    const cpm = Number(b.cpm);
    if (!isFinite(cpm) || cpm < 0 || cpm > 10000) return { ok: false, error: "CPM must be a number between 0 and 10,000." };
    out.cpm = Math.round(cpm * 10000) / 10000;
  }
  if (b.currency !== undefined) {
    const c = String(b.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) return { ok: false, error: "Currency must be a 3-letter code like USD." };
    out.currency = c;
  }
  if (b.maxPayout !== undefined) {
    if (b.maxPayout === null || b.maxPayout === "") out.maxPayout = null;
    else {
      const m = Number(b.maxPayout);
      if (!isFinite(m) || m <= 0 || m > 10_000_000) return { ok: false, error: "Max payout must be a positive number (or empty for no cap)." };
      out.maxPayout = Math.round(m * 100) / 100;
    }
  }
  if (b.minPayout !== undefined) {
    if (b.minPayout === null || b.minPayout === "") out.minPayout = null;
    else {
      const m = Number(b.minPayout);
      if (!isFinite(m) || m < 0 || m > 10_000_000) return { ok: false, error: "Min payout must be a positive number (or empty for none)." };
      out.minPayout = m > 0 ? Math.round(m * 100) / 100 : null;
    }
  }
  // Only reject when both are present in this request; a partial edit can't see the stored values.
  if (out.minPayout != null && out.maxPayout != null && out.minPayout > out.maxPayout) {
    return { ok: false, error: "Min payout can't be higher than the max per video." };
  }
  if (b.isDefault !== undefined) out.isDefault = b.isDefault === true;
  if (b.goals !== undefined) {
    const g = normalizeMetricGoals(b.goals, true);
    out.goals = Object.keys(g).length ? JSON.stringify(g) : null;
  }
  return { ok: true, value: out };
}
