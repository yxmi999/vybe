"use client";
// Affiliate dashboard: your share link, what it has earned, payout details,
// and the history behind the numbers. Logic lives in lib/affiliate.ts.
import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Loader2, Users, Wallet, Clock, BadgeDollarSign, Link2, ArrowUpRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { cn } from "@/lib/utils";

type Summary = {
  code: string;
  config: { commissionPct: number; durationMonths: number; holdDays: number; minPayoutCents: number };
  stats: { signups: number; paying: number };
  balance: { pendingCents: number; availableCents: number; requestedCents: number; paidCents: number; lifetimeCents: number };
  payout: { method: "paypal" | "crypto" | "wise" | null; details: string | null };
  identity: {
    profile: { legalName: string; country: string; address: string; usPerson: boolean; termsAccepted: boolean };
    termsVersion: string;
    complete: boolean;
    idStatus: "none" | "pending" | "verified" | "rejected";
    idCheckNeeded: boolean;
    idReasons: string[];
    blockedCountries: string[];
  };
  referrals: { who: string; plan: string; joinedAt: string; earnedCents: number }[];
  commissions: { id: number; who: string; kind: string; amountCents: number; createdAt: string; availableAt: string; state: "pending" | "available" | "requested" | "paid" }[];
  payouts: { id: number; amountCents: number; status: string; method: string | null; createdAt: string; settledAt: string | null; note: string | null }[];
};

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

const METHODS = [
  { key: "paypal", label: "PayPal", placeholder: "you@example.com" },
  { key: "wise", label: "Wise", placeholder: "you@example.com" },
  { key: "crypto", label: "USDT (TRC-20)", placeholder: "Wallet address" },
] as const;

const card = "rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 sm:p-6";

export default function AffiliatePage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");

  const load = useCallback(() => {
    fetch("/api/affiliate")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Couldn't load your affiliate dashboard.");
        setOrigin(window.location.origin);
        setData(d);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Something went wrong"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const link = data ? `${origin}/?ref=${data.code}` : "";

  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* ignore */ }
  }

  const c = data?.config;
  const duration = c ? (c.durationMonths > 0 ? `for their first ${c.durationMonths} months` : "for as long as they stay subscribed") : "";

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <PageHeader
        eyebrow="Grow"
        title="Earn with Vybe"
        description={c
          ? `Share your link. When someone subscribes through it, you get ${c.commissionPct}% of every payment they make ${duration}.`
          : "Share your link and earn a cut of every subscription it brings in."}
      />

      {error && <p className="mb-4 text-[13px] text-red-300">{error}</p>}

      {/* Share link */}
      <section className={cn(card, "mb-4 bg-gradient-to-br from-violet-500/[0.08] to-transparent border-violet-500/20")}>
        <div className="flex items-center gap-2 mb-3">
          <Link2 size={15} className="text-violet-300" />
          <h2 className="text-[15px] font-semibold text-white/90">Your referral link</h2>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 min-w-0 h-11 px-4 flex items-center rounded-xl bg-black/30 border border-white/[0.08] font-mono text-[13px] text-white/80 overflow-hidden">
            <span className="truncate">{link || "Loading…"}</span>
          </div>
          <button type="button" onClick={copy} disabled={!link}
            className="h-11 px-5 rounded-xl text-[13px] font-semibold text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 flex-shrink-0">
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <p className="mt-3 text-[12px] text-white/40 leading-relaxed">
          Code <span className="font-mono text-white/70">{data?.code ?? "…"}</span> · the link works on any Vybe page and is remembered for 30 days,
          so they can sign up later. Tip: put it in your video descriptions and your bio. Your watermarked clips already advertise Vybe.
        </p>
      </section>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat icon={Users} label="Sign-ups" value={data ? String(data.stats.signups) : "—"} sub={data ? `${data.stats.paying} paying` : ""} />
        <Stat icon={Clock} label="Pending" value={data ? usd(data.balance.pendingCents) : "—"} sub={c ? `held ${c.holdDays} days for refunds` : ""} />
        <Stat icon={Wallet} label="Available" value={data ? usd(Math.max(0, data.balance.availableCents)) : "—"} sub={c ? `min. payout ${usd(c.minPayoutCents)}` : ""} accent />
        <Stat icon={BadgeDollarSign} label="Paid out" value={data ? usd(data.balance.paidCents) : "—"} sub={data ? `${usd(data.balance.lifetimeCents)} earned all-time` : ""} />
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-4 mb-4">
        <HowItWorks config={c} />
        {data && (
          <div className="space-y-4">
            <PayoutPanel data={data} onChange={load} />
            <ProfilePanel data={data} onChange={load} />
          </div>
        )}
      </div>

      {/* Referrals */}
      <section className={cn(card, "mb-4")}>
        <h2 className="text-[15px] font-semibold text-white/90 mb-3">People you referred</h2>
        {!data ? <Loading /> : data.referrals.length === 0 ? (
          <Empty text="No sign-ups yet. Share your link to get your first referral." />
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-white/35 text-[11px] uppercase tracking-wider">
                  <th className="font-medium px-1 pb-2">User</th>
                  <th className="font-medium px-1 pb-2">Plan</th>
                  <th className="font-medium px-1 pb-2">Joined</th>
                  <th className="font-medium px-1 pb-2 text-right">You earned</th>
                </tr>
              </thead>
              <tbody>
                {data.referrals.map((r, i) => (
                  <tr key={i} className="border-t border-white/[0.05]">
                    <td className="px-1 py-2.5 text-white/75 font-mono text-[12px]">{r.who}</td>
                    <td className="px-1 py-2.5"><PlanPill plan={r.plan} /></td>
                    <td className="px-1 py-2.5 text-white/45">{day(r.joinedAt)}</td>
                    <td className="px-1 py-2.5 text-right text-white/80 tabular-nums">{usd(r.earnedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Activity */}
      <div className="grid lg:grid-cols-2 gap-4">
        <section className={card}>
          <h2 className="text-[15px] font-semibold text-white/90 mb-3">Commission activity</h2>
          {!data ? <Loading /> : data.commissions.length === 0 ? (
            <Empty text="Commissions show up here when a referral pays." />
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {data.commissions.map((x) => (
                <li key={x.id} className="py-2.5 flex items-center gap-3 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p className="text-white/75 truncate">{x.kind === "reversal" ? "Refund reversal" : "Commission"} · <span className="font-mono text-[12px] text-white/50">{x.who}</span></p>
                    <p className="text-[11px] text-white/35">
                      {day(x.createdAt)}{x.state === "pending" && ` · available ${day(x.availableAt)}`}
                    </p>
                  </div>
                  <StatePill state={x.state} />
                  <span className={cn("tabular-nums w-20 text-right", x.amountCents < 0 ? "text-red-300" : "text-white/85")}>{usd(x.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={card}>
          <h2 className="text-[15px] font-semibold text-white/90 mb-3">Payouts</h2>
          {!data ? <Loading /> : data.payouts.length === 0 ? (
            <Empty text="No payouts yet." />
          ) : (
            <ul className="divide-y divide-white/[0.05]">
              {data.payouts.map((p) => (
                <li key={p.id} className="py-2.5 flex items-center gap-3 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p className="text-white/75">{usd(p.amountCents)} <span className="text-white/35">via {methodLabel(p.method)}</span></p>
                    <p className="text-[11px] text-white/35">
                      Requested {day(p.createdAt)}{p.settledAt && ` · ${p.status} ${day(p.settledAt)}`}{p.note && ` · ${p.note}`}
                    </p>
                  </div>
                  <StatePill state={p.status === "paid" ? "paid" : p.status === "requested" ? "requested" : "rejected"} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function methodLabel(m: string | null) {
  return METHODS.find((x) => x.key === m)?.label ?? m ?? "—";
}

function Stat({ icon: Icon, label, value, sub, accent }: {
  icon: React.ComponentType<{ size?: number; className?: string }>; label: string; value: string; sub?: string; accent?: boolean;
}) {
  return (
    <div className={cn("rounded-2xl border p-4", accent ? "border-emerald-500/25 bg-emerald-500/[0.05]" : "border-white/[0.07] bg-white/[0.02]")}>
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-white/40 font-medium">
        <Icon size={13} className={accent ? "text-emerald-300" : "text-white/40"} /> {label}
      </p>
      <p className="mt-2 text-xl sm:text-2xl font-bold text-white tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-white/35">{sub}</p>}
    </div>
  );
}

function HowItWorks({ config }: { config: Summary["config"] | undefined }) {
  const steps = [
    { t: "Share your link", d: "In your bio, video descriptions, Discord, wherever your audience is." },
    { t: "They subscribe", d: config ? `You earn ${config.commissionPct}% of each payment: the first one and every renewal${config.durationMonths > 0 ? `, for ${config.durationMonths} months` : ""}.` : "You earn a share of each payment." },
    { t: "Refund hold", d: config ? `Each commission is held ${config.holdDays} days. If the payment is refunded, the commission is cancelled.` : "Commissions are held briefly in case of refunds." },
    { t: "Get paid", d: config ? `Once you have ${usd(config.minPayoutCents)} available, request a payout to PayPal, Wise or USDT.` : "Request a payout once you pass the minimum." },
  ];
  return (
    <section className={card}>
      <h2 className="text-[15px] font-semibold text-white/90 mb-4">How it works</h2>
      <ol className="grid sm:grid-cols-2 gap-4">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="w-6 h-6 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-200 text-[12px] font-bold flex items-center justify-center flex-shrink-0">{i + 1}</span>
            <div>
              <p className="text-[13px] font-semibold text-white/85">{s.t}</p>
              <p className="text-[12px] text-white/45 leading-relaxed mt-0.5">{s.d}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-[11px] text-white/30 leading-relaxed">
        Self-referrals and fake accounts aren’t allowed and void their commissions.
      </p>
    </section>
  );
}

function PayoutPanel({ data, onChange }: { data: Summary; onChange: () => void }) {
  const [method, setMethod] = useState<"paypal" | "crypto" | "wise">(data.payout.method ?? "paypal");
  const [details, setDetails] = useState(data.payout.details ?? "");
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const saved = data.payout.method === method && (data.payout.details ?? "") === details.trim() && !!data.payout.details;
  const available = data.balance.availableCents;
  const inProgress = data.payouts.some((p) => p.status === "requested");
  const profileDone = data.identity.complete;
  const canRequest = saved && profileDone && data.identity.idStatus !== "rejected" && available >= data.config.minPayoutCents && !inProgress;

  async function save() {
    setSaving(true); setMsg(null);
    const r = await fetch("/api/affiliate", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, details }) });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) { setMsg({ ok: false, text: d.error ?? "Couldn't save." }); return; }
    setMsg({ ok: true, text: "Payout details saved." });
    onChange();
  }

  async function request() {
    setRequesting(true); setMsg(null);
    const r = await fetch("/api/affiliate", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setRequesting(false);
    if (!r.ok) { setMsg({ ok: false, text: d.error ?? "Couldn't request a payout." }); return; }
    setMsg({ ok: true, text: `Payout of ${usd(d.amountCents)} requested.` });
    onChange();
  }

  const placeholder = METHODS.find((m) => m.key === method)?.placeholder ?? "";

  return (
    <section className={card}>
      <h2 className="text-[15px] font-semibold text-white/90 mb-3">Payout</h2>
      <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-black/30 border border-white/[0.06] mb-3">
        {METHODS.map((m) => (
          <button key={m.key} type="button" onClick={() => setMethod(m.key)}
            className={cn("h-8 rounded-lg text-[12px] font-medium transition-colors",
              method === m.key ? "bg-white/[0.1] text-white" : "text-white/45 hover:text-white/75")}>
            {m.label}
          </button>
        ))}
      </div>
      <input value={details} onChange={(e) => setDetails(e.target.value)} placeholder={placeholder} spellCheck={false}
        className="w-full h-10 px-3 rounded-xl bg-black/30 border border-white/[0.08] text-[13px] text-white placeholder:text-white/25 focus:outline-none focus:border-violet-500/50" />
      <button type="button" onClick={save} disabled={saving || saved || details.trim().length < 4}
        className="mt-2 w-full h-9 rounded-xl text-[12px] font-semibold text-white/80 bg-white/[0.05] border border-white/[0.1] hover:bg-white/[0.09] disabled:opacity-40 transition-colors flex items-center justify-center gap-2">
        {saving && <Loader2 size={13} className="animate-spin" />} {saved ? "Saved" : "Save details"}
      </button>

      <div className="mt-4 pt-4 border-t border-white/[0.06]">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] text-white/45">Available now</span>
          <span className="text-lg font-bold text-white tabular-nums">{usd(Math.max(0, available))}</span>
        </div>
        {available < 0 && (
          <p className="mt-1 text-[11px] text-amber-300/80">A refund reversed {usd(-available)} of paid-out commission; it’s netted from your next earnings.</p>
        )}
        <button type="button" onClick={request} disabled={!canRequest || requesting}
          className="mt-3 w-full h-10 rounded-xl text-[13px] font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/[0.06] disabled:text-white/35 transition-colors flex items-center justify-center gap-2">
          {requesting ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpRight size={14} />}
          {inProgress ? "Payout in progress" : "Request payout"}
        </button>
        {!inProgress && !canRequest && (
          <p className="mt-2 text-[11px] text-white/35 text-center">
            {!saved ? "Save your payout details first."
              : !profileDone ? "Complete your payout profile below first."
              : data.identity.idStatus === "rejected" ? "Your identity check didn't pass — contact support."
              : `Reach ${usd(data.config.minPayoutCents)} available to request a payout.`}
          </p>
        )}
      </div>
      {data.identity.idCheckNeeded && (
        <p className="mt-3 flex gap-2 text-[11px] leading-relaxed text-amber-200/80">
          <ShieldCheck size={13} className="flex-shrink-0 mt-px" />
          <span>
            {data.identity.idStatus === "pending"
              ? "Your identity check is in progress — we'll send the payout once it's done."
              : `We'll ask you to verify your identity before this payout (${data.identity.idReasons.join(", ")}). It takes a couple of minutes — we'll email you a link.`}
          </span>
        </p>
      )}
      {msg && <p className={cn("mt-3 text-[12px]", msg.ok ? "text-emerald-300" : "text-red-300")}>{msg.text}</p>}
    </section>
  );
}

// ISO 3166-1 alpha-2 codes; names come from the browser's Intl.DisplayNames.
const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CV CW CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT " +
  "JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

function ProfilePanel({ data, onChange }: { data: Summary; onChange: () => void }) {
  const p = data.identity.profile;
  const [legalName, setLegalName] = useState(p.legalName);
  const [country, setCountry] = useState(p.country);
  const [address, setAddress] = useState(p.address);
  const [usPerson, setUsPerson] = useState(p.usPerson);
  const [accept, setAccept] = useState(p.termsAccepted);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(!data.identity.complete);

  const countries = (() => {
    let dn: Intl.DisplayNames | null = null;
    try { dn = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* old browser */ }
    return COUNTRY_CODES
      .filter((c) => !data.identity.blockedCountries.includes(c))
      .map((c) => ({ code: c, name: dn?.of(c) ?? c }))
      .sort((a, b) => a.name.localeCompare(b.name));
  })();

  async function save() {
    setSaving(true); setMsg(null);
    const r = await fetch("/api/affiliate", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: { legalName, country, address, usPerson: usPerson || country === "US", acceptTerms: accept } }),
    });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (!r.ok) { setMsg({ ok: false, text: d.error ?? "Couldn't save." }); return; }
    setMsg({ ok: true, text: "Payout profile saved." });
    setOpen(false);
    onChange();
  }

  const field = "w-full h-10 px-3 rounded-xl bg-black/30 border border-white/[0.08] text-[13px] text-white placeholder:text-white/25 focus:outline-none focus:border-violet-500/50";

  return (
    <section className={card}>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[15px] font-semibold text-white/90 flex items-center gap-2">
          <ShieldCheck size={15} className={data.identity.complete ? "text-emerald-300" : "text-white/40"} /> Payout profile
        </h2>
        {data.identity.complete && !open && (
          <button type="button" onClick={() => setOpen(true)} className="text-[12px] text-violet-300 hover:text-violet-200">Edit</button>
        )}
      </div>
      {!open ? (
        <p className="text-[12px] text-white/50">
          {p.legalName} · {p.country}
          {data.identity.idStatus === "verified" && <span className="ml-1.5 text-emerald-300/80">· ID verified</span>}
        </p>
      ) : (
        <div className="space-y-2 mt-2">
          <p className="text-[11px] text-white/40 leading-relaxed">Needed before your first payout — we have to know who we’re paying for tax and anti-fraud rules. Not shared publicly.</p>
          <input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Full legal name" autoComplete="name" className={field} />
          <select value={country} onChange={(e) => setCountry(e.target.value)} className={cn(field, "appearance-none", !country && "text-white/25")}>
            <option value="">Country of residence</option>
            {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          <textarea value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Postal address" rows={2} autoComplete="street-address"
            className={cn(field, "h-auto py-2 resize-none")} />
          {country !== "US" && (
            <label className="flex items-start gap-2 text-[12px] text-white/55">
              <input type="checkbox" checked={usPerson} onChange={(e) => setUsPerson(e.target.checked)} className="mt-0.5 accent-violet-500" />
              I’m a US citizen or US tax resident
            </label>
          )}
          <label className="flex items-start gap-2 text-[12px] text-white/55">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 accent-violet-500" />
            <span>I agree to the <Link href="/affiliate-terms" target="_blank" className="text-violet-300 hover:text-violet-200 underline-offset-2 hover:underline">Affiliate Program Terms</Link></span>
          </label>
          <button type="button" onClick={save} disabled={saving || !accept || legalName.trim().length < 3 || !country || address.trim().length < 8}
            className="w-full h-9 rounded-xl text-[12px] font-semibold text-white bg-violet-600 hover:bg-violet-500 disabled:bg-white/[0.06] disabled:text-white/35 transition-colors flex items-center justify-center gap-2">
            {saving && <Loader2 size={13} className="animate-spin" />} Save profile
          </button>
        </div>
      )}
      {msg && <p className={cn("mt-2 text-[12px]", msg.ok ? "text-emerald-300" : "text-red-300")}>{msg.text}</p>}
    </section>
  );
}

function PlanPill({ plan }: { plan: string }) {
  const paid = plan !== "free";
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded-md text-[11px] font-medium capitalize border",
      paid ? "text-violet-200 bg-violet-500/10 border-violet-500/25" : "text-white/45 bg-white/[0.03] border-white/[0.08]")}>
      {plan}
    </span>
  );
}

function StatePill({ state }: { state: "pending" | "available" | "requested" | "paid" | "rejected" }) {
  const styles: Record<typeof state, string> = {
    pending: "text-amber-200 bg-amber-500/10 border-amber-500/25",
    available: "text-emerald-200 bg-emerald-500/10 border-emerald-500/25",
    requested: "text-sky-200 bg-sky-500/10 border-sky-500/25",
    paid: "text-white/60 bg-white/[0.04] border-white/[0.1]",
    rejected: "text-red-200 bg-red-500/10 border-red-500/25",
  };
  return <span className={cn("px-2 py-0.5 rounded-md text-[11px] font-medium capitalize border flex-shrink-0", styles[state])}>{state}</span>;
}

function Loading() {
  return <div className="py-6 flex justify-center"><Loader2 size={16} className="animate-spin text-white/30" /></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-[13px] text-white/35">{text}</p>;
}
