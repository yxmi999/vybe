"use client";
// Admin: affiliate payout requests. Send the money (PayPal / Wise / USDT)
// outside Vybe, then mark it paid here. Rejecting releases the commissions back
// to the affiliate's available balance. API is gated by ADMIN_EMAILS.
//
// Each open request shows a live risk assessment (lib/affiliate-safety.ts):
// "Mark paid" is refused server-side for blocked countries, incomplete
// profiles and missing ID checks, and needs a review note when high-risk
// flags are present.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { cn } from "@/lib/utils";

type Flag = { level: "high" | "medium" | "low"; code: string; message: string };
type Risk = {
  flags: Flag[]; blocked: string | null; idCheckRequired: boolean; idReasons: string[]; profileComplete: boolean;
  profile: {
    legalName: string; country: string; address: string; usPerson: boolean;
    idStatus: "none" | "pending" | "verified" | "rejected"; idNote: string | null; taxFormOnFile: boolean;
  };
};
type Payout = {
  id: number; userId: number; amountCents: number; method: string | null; details: string | null;
  status: string; note: string | null; createdAt: string; settledAt: string | null; email: string; name: string | null;
  requestCountry: string | null; risk: Risk | null;
};

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const LEVEL_STYLE: Record<Flag["level"], string> = {
  high: "text-red-200 bg-red-500/10 border-red-500/25",
  medium: "text-amber-200 bg-amber-500/10 border-amber-500/25",
  low: "text-white/60 bg-white/[0.04] border-white/[0.08]",
};

export default function AdminPayoutsPage() {
  const [status, setStatus] = useState<"requested" | "paid" | "rejected">("requested");
  const [result, setResult] = useState<{ status: string; rows: Payout[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  const load = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/payouts?status=${status}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(r.status === 404 ? "Not available." : d.error ?? "Failed to load");
        if (alive) { setResult({ status, rows: d.payouts }); setError(""); }
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Failed to load"); });
    return () => { alive = false; };
  }, [status, reloads]);

  const rows = result?.status === status ? result.rows : null;

  async function post(body: Record<string, unknown>, busyId: number) {
    setBusy(busyId); setError("");
    const r = await fetch("/api/admin/payouts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error ?? "Failed"); }
    load();
  }

  function settle(p: Payout, action: "paid" | "rejected") {
    const high = p.risk?.flags.some((f) => f.level === "high");
    const prompt = action === "rejected" ? "Reason for rejecting:"
      : high ? "High-risk flags — explain why it's OK to pay (required), plus the payment reference:"
      : "Reference (e.g. PayPal transaction id), optional:";
    const note = window.prompt(prompt) ?? undefined;
    if (note === undefined && (action === "rejected" || high)) return;
    void post({ id: p.id, action, note }, p.id);
  }

  function setId(p: Payout, idStatus: Risk["profile"]["idStatus"]) {
    const note = window.prompt(
      idStatus === "verified" ? "Verification reference (provider + check id):"
        : idStatus === "rejected" ? "Why did the check fail?"
        : "Note (e.g. 'link sent 2026-11-25'):",
    );
    if (note === null) return;
    void post({ userId: p.userId, action: "id_status", idStatus, note }, p.id);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <PageHeader eyebrow="Admin" title="Affiliate payouts" description="Check the flags, verify identity when asked, send the payment yourself, then mark it paid." />
      <div className="inline-grid grid-cols-3 gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.07] mb-4">
        {(["requested", "paid", "rejected"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)}
            className={cn("h-8 px-4 rounded-lg text-[13px] font-medium capitalize", status === s ? "bg-white/[0.1] text-white" : "text-white/50 hover:text-white/80")}>
            {s}
          </button>
        ))}
      </div>
      {error && <p className="mb-4 text-[13px] text-red-300">{error}</p>}
      {!rows ? (!error && <Loader2 size={16} className="animate-spin text-white/30" />) : rows.length === 0 ? (
        <p className="text-[13px] text-white/40">Nothing here.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((p) => {
            const r = p.risk;
            const cantPay = !!r && (!!r.blocked || !r.profileComplete || r.idCheckRequired);
            return (
              <li key={p.id} className={cn("rounded-2xl border bg-white/[0.02] p-4", r?.blocked ? "border-red-500/40" : "border-white/[0.07]")}>
                <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-bold text-white">{usd(p.amountCents)} <span className="text-[12px] font-medium text-white/40 uppercase">{p.method}</span></p>
                    <p className="text-[12px] text-white/55 truncate">{p.name ? `${p.name} · ` : ""}{p.email} · #{p.userId}</p>
                    <button type="button" onClick={() => p.details && navigator.clipboard.writeText(p.details).catch(() => {})}
                      className="mt-1 max-w-full text-left font-mono text-[12px] text-violet-200 hover:text-violet-100 flex items-center gap-1.5">
                      <Copy size={11} className="flex-shrink-0" /><span className="truncate">{p.details}</span>
                    </button>
                    <p className="text-[11px] text-white/30 mt-1">
                      Requested {new Date(p.createdAt).toLocaleString()}{p.requestCountry && ` from ${p.requestCountry}`}{p.note && ` · ${p.note}`}
                    </p>
                  </div>
                  {p.status === "requested" && (
                    <div className="flex gap-2 flex-shrink-0">
                      <button type="button" disabled={busy === p.id} onClick={() => settle(p, "rejected")}
                        className="h-9 px-3 rounded-lg text-[12px] font-semibold text-red-200 bg-red-500/10 border border-red-500/25 hover:bg-red-500/20 disabled:opacity-50">Reject</button>
                      <button type="button" disabled={busy === p.id || cantPay} onClick={() => settle(p, "paid")}
                        title={cantPay ? "Resolve the blockers below first" : undefined}
                        className="h-9 px-3 rounded-lg text-[12px] font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/[0.06] disabled:text-white/35">Mark paid</button>
                    </div>
                  )}
                </div>

                {r && (
                  <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2.5">
                    {r.blocked && (
                      <p className="flex gap-2 text-[12px] text-red-200"><ShieldAlert size={14} className="flex-shrink-0 mt-px" />{r.blocked} Do not pay — reject.</p>
                    )}

                    {/* Identity */}
                    <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                      <p className="text-white/45">Legal name <span className="text-white/85">{r.profile.legalName || "—"}</span></p>
                      <p className="text-white/45">Country <span className="text-white/85">{r.profile.country || "—"}</span>{r.profile.usPerson && <span className="text-white/60"> · US person (W-9)</span>}</p>
                      <p className="text-white/45 sm:col-span-2 truncate">Address <span className="text-white/85">{r.profile.address || "—"}</span></p>
                    </div>
                    {!r.profileComplete && <p className="text-[12px] text-amber-200">Payout profile incomplete or terms not accepted.</p>}

                    <div className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className={cn("inline-flex items-center gap-1 h-6 px-2 rounded-md border",
                        r.profile.idStatus === "verified" ? "text-emerald-200 bg-emerald-500/10 border-emerald-500/25"
                          : r.idCheckRequired ? "text-amber-200 bg-amber-500/10 border-amber-500/25"
                          : "text-white/55 bg-white/[0.04] border-white/[0.08]")}>
                        <ShieldCheck size={12} /> ID: {r.profile.idStatus}{r.idCheckRequired && ` — required (${r.idReasons.join(", ")})`}
                      </span>
                      {(["pending", "verified", "rejected"] as const).filter((s) => s !== r.profile.idStatus).map((s) => (
                        <button key={s} type="button" disabled={busy === p.id} onClick={() => setId(p, s)}
                          className="h-6 px-2 rounded-md text-[11px] font-medium text-white/70 bg-white/[0.05] border border-white/[0.1] hover:bg-white/[0.09] capitalize">
                          Mark {s}
                        </button>
                      ))}
                      <label className="inline-flex items-center gap-1.5 text-white/60 ml-1">
                        <input type="checkbox" checked={r.profile.taxFormOnFile} disabled={busy === p.id}
                          onChange={(e) => void post({ userId: p.userId, action: "tax_form", onFile: e.target.checked }, p.id)}
                          className="accent-violet-500" />
                        {r.profile.usPerson ? "W-9" : "W-8BEN"} on file
                      </label>
                    </div>
                    {r.profile.idNote && <p className="text-[11px] text-white/35">ID note: {r.profile.idNote}</p>}

                    {/* Fraud signals */}
                    {r.flags.length === 0 ? (
                      <p className="text-[12px] text-emerald-300/70">No fraud signals.</p>
                    ) : (
                      <ul className="space-y-1">
                        {r.flags.map((f) => (
                          <li key={f.code} className={cn("flex gap-2 text-[12px] rounded-lg border px-2.5 py-1.5", LEVEL_STYLE[f.level])}>
                            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                            <span><span className="font-semibold uppercase text-[10px] tracking-wide mr-1.5">{f.level}</span>{f.message}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
