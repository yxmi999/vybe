"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Loader2, Sparkles, Zap, Rocket, Bitcoin, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { priceFor, brandedSavingsPct, BETA, FULL_PRICING, type PaidPlan, type Interval } from "@/lib/pricing";

type Plan = "free" | "creator" | "pro";
type Method = "crypto" | "card";
type Billing = {
  plan: Plan;
  provider: string | null;
  status: string | null;
  currentPeriodEnd: string | null;
  hasCardBilling: boolean;
  keepWatermark: boolean;
  cardProvider: "polar" | "paddle" | null;
  methods: { crypto: boolean; card: boolean; cardBranded: boolean };
};

const isCardSub = (provider: string | null | undefined) => provider === "paddle" || provider === "polar";

const RANK: Record<Plan, number> = { free: 0, creator: 1, pro: 2 };

const FEATURES = {
  free: ["10 clips / month", "3 connected accounts", "720p exports", "Vybe watermark", "Clips expire after 7 days"],
  creator: ["Unlimited clips", "6 connected accounts", "1080p exports", "No watermark", "1 Auto-Pilot schedule", "100 auto-clips / month"],
  pro: ["Everything in Creator", "15 connected accounts", "4K exports", "5 Auto-Pilot schedules", "500 auto-clips / month", "Up to 15 clips per run"],
} as const;

const ICON = { free: Sparkles, creator: Zap, pro: Rocket } as const;

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="px-6 py-10 text-center text-white/40">Loading…</div>}>
      <BillingContent />
    </Suspense>
  );
}

function BillingContent() {
  const params = useSearchParams();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [interval, setInterval] = useState<Interval>("monthly");
  const [busy, setBusy] = useState<string | null>(null);
  // Discounted plans that keep the Vybe watermark on exports.
  const [branded, setBranded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusParam = params.get("status");

  useEffect(() => {
    fetch("/api/billing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.plan) setBilling(d); })
      .catch(() => {});
  }, []);

  async function pay(plan: PaidPlan, method: Method) {
    setError(null);
    setBusy(`${plan}:${method}`);
    try {
      const path = method === "crypto"
        ? "/api/billing/crypto/checkout"
        : `/api/billing/${billing?.cardProvider ?? "paddle"}/checkout`;
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, interval, branded }),
      });
      const data = await res.json();
      if (res.ok && data.url) { window.location.href = data.url; return; }
      setError(data.error ?? "Could not start checkout.");
    } catch {
      setError("Could not start checkout.");
    } finally {
      setBusy(null);
    }
  }

  async function manage() {
    setError(null);
    setBusy("portal");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.url) { window.location.href = data.url; return; }
      setError(data.error ?? "Could not open billing portal.");
    } catch {
      setError("Could not open billing portal.");
    } finally {
      setBusy(null);
    }
  }

  const current = billing?.plan ?? "free";
  const methods = billing?.methods ?? { crypto: false, card: false, cardBranded: false };
  // Card checkout for the watermark plans needs its own card-provider prices.
  const cardAvailable = methods.card && (!branded || methods.cardBranded);
  const noMethods = !methods.crypto && !methods.card;
  const plans: Plan[] = ["free", "creator", "pro"];

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="text-center">
        <p className="cue text-violet-400/90 mb-2.5">Plans &amp; billing</p>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-white">Pick your plan</h1>
        <p className="mt-3 text-white/45">{BETA ? "Public beta — subscribe now and keep the beta price after launch." : "Pay by card or crypto — unlock unlimited clips and Auto-Pilot."}</p>
      </div>

      {statusParam === "success" && (
        <div className="mt-6 mx-auto max-w-lg rounded-lg bg-emerald-500/10 border border-emerald-500/25 px-4 py-3 text-sm text-emerald-300 text-center">
          Payment received — your plan updates once the payment confirms (crypto can take a few minutes).
        </div>
      )}
      {statusParam === "cancelled" && (
        <div className="mt-6 mx-auto max-w-lg rounded-lg bg-white/[0.04] border border-white/10 px-4 py-3 text-sm text-white/55 text-center">
          Checkout cancelled — no charge was made.
        </div>
      )}
      {error && (
        <div className="mt-6 mx-auto max-w-lg rounded-lg bg-red-500/10 border border-red-500/25 px-4 py-3 text-sm text-red-300 text-center">
          {error}
        </div>
      )}
      {noMethods && billing && (
        <div className="mt-6 mx-auto max-w-lg rounded-lg bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-sm text-amber-300 text-center">
          No payment method is configured yet. Add NOWPayments (crypto) or Polar/Paddle (card) keys to enable checkout.
        </div>
      )}

      {/* Billing interval toggle */}
      <div className="mt-8 flex items-center justify-center gap-3">
        <div className="inline-flex rounded-full bg-white/[0.05] border border-white/10 p-1">
          {(["monthly", "yearly"] as Interval[]).map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={cn(
                "px-4 py-1.5 text-sm rounded-full transition-colors capitalize",
                interval === iv ? "bg-violet-600 text-white" : "text-white/50 hover:text-white/80"
              )}
            >
              {iv}
              {iv === "yearly" && <span className="ml-1.5 text-[11px] text-emerald-400">2 months free</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Keep-the-watermark discount — retired for new customers; only shown to
          people already on a watermark plan so they can still see/switch it. */}
      {billing?.keepWatermark && <div className="mt-4 flex justify-center">
        <button
          type="button"
          role="switch"
          aria-checked={branded}
          onClick={() => setBranded((b) => !b)}
          className={cn(
            "inline-flex items-center gap-3 rounded-full border px-4 py-2 text-sm transition-colors",
            branded ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-white/10 bg-white/[0.03] text-white/60 hover:text-white/80"
          )}
        >
          <span className={cn("relative w-8 h-[18px] rounded-full transition-colors", branded ? "bg-emerald-500" : "bg-white/15")}>
            <span className={cn("absolute top-[3px] w-3 h-3 rounded-full bg-white transition-all", branded ? "left-[17px]" : "left-[3px]")} />
          </span>
          Keep the Vybe watermark
          <span className="text-[11px] font-semibold text-emerald-400">save up to {Math.max(brandedSavingsPct("creator"), brandedSavingsPct("pro"))}%</span>
        </button>
      </div>}

      <div className="mt-8 grid gap-5 md:grid-cols-3">
        {plans.map((plan) => {
          const Icon = ICON[plan];
          const isPaid = plan !== "free";
          // Same plan bought with/without the watermark counts as a different option.
          const isCurrent = plan === current && (!isPaid || branded === (billing?.keepWatermark ?? false));
          const sameTierOtherVariant = isPaid && plan === current && !isCurrent;
          const price = isPaid ? priceFor(plan as PaidPlan, interval, branded) : 0;
          const fullPrice = isPaid ? priceFor(plan as PaidPlan, interval) : 0;
          const features = isPaid && branded
            ? FEATURES[plan].map((f) => (f === "No watermark" ? "Vybe watermark on exports" : f))
            : FEATURES[plan];
          const highlight = plan === "creator";

          return (
            <div
              key={plan}
              className={cn(
                "relative rounded-2xl border p-6 flex flex-col",
                highlight ? "border-violet-500/40 bg-violet-600/[0.06]" : "border-white/10 bg-white/[0.02]"
              )}
            >
              {highlight && (
                <span className="absolute -top-2.5 left-6 rounded-full bg-violet-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                  Most popular
                </span>
              )}

              <div className="flex items-center gap-2">
                <Icon size={18} className={highlight ? "text-violet-400" : "text-white/50"} />
                <h2 className="text-lg font-semibold text-white capitalize">{plan}</h2>
              </div>

              <div className="mt-4 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold text-white">${price}</span>
                {isPaid && <span className="text-sm text-white/40">/{interval === "monthly" ? "mo" : "yr"}</span>}
                {isPaid && branded && (
                  <span className="text-sm text-white/30 line-through decoration-white/40">${fullPrice}</span>
                )}
              </div>
              {isPaid && branded && (
                <p className="mt-1 text-[11px] text-emerald-400/90">Watermark kept · save {brandedSavingsPct(plan as PaidPlan, interval)}%</p>
              )}
              {isPaid && !branded && BETA && (
                <p className="mt-1 text-[12px] text-emerald-300/90">
                  Beta price · <span className="line-through text-white/35">${FULL_PRICING[plan as PaidPlan][interval]}</span> after launch, locked in while you stay subscribed
                </p>
              )}

              <ul className="mt-5 space-y-2.5 flex-1">
                {features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-white/65">
                    <Check size={15} className="mt-0.5 text-violet-400 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>

              <div className="mt-6 space-y-2">
                {isCurrent ? (
                  <div className="w-full text-center py-2.5 rounded-lg bg-white/[0.05] text-sm text-white/50 border border-white/10">
                    Current plan
                  </div>
                ) : sameTierOtherVariant && isCardSub(billing?.provider) ? (
                  // Switching variants on a card sub happens in the portal, not a 2nd checkout.
                  <button
                    onClick={manage}
                    disabled={busy !== null}
                    className="w-full py-2.5 rounded-lg text-sm font-semibold bg-white/10 hover:bg-white/15 text-white disabled:opacity-50"
                  >
                    {branded ? "Switch to watermark plan" : "Remove watermark"} in billing portal
                  </button>
                ) : plan === "free" ? (
                  <div className="w-full text-center py-2.5 rounded-lg text-sm text-white/30">
                    {RANK[current] > 0 ? "Manage your plan below" : "—"}
                  </div>
                ) : (
                  <>
                    {cardAvailable && (
                      <button
                        onClick={() => pay(plan as PaidPlan, "card")}
                        disabled={busy !== null}
                        className={cn(
                          "w-full py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50",
                          highlight ? "bg-violet-600 hover:bg-violet-500 text-white" : "bg-white/10 hover:bg-white/15 text-white"
                        )}
                      >
                        {busy === `${plan}:card` ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />}
                        Pay by card
                      </button>
                    )}
                    {methods.crypto && (
                      <button
                        onClick={() => pay(plan as PaidPlan, "crypto")}
                        disabled={busy !== null}
                        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-50 bg-white/10 hover:bg-white/15 text-white border border-amber-500/30"
                      >
                        {busy === `${plan}:crypto` ? <Loader2 size={15} className="animate-spin" /> : <Bitcoin size={15} className="text-amber-400" />}
                        Pay with crypto
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Method explainer */}
      {(methods.card || methods.crypto) && (
        <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-1 text-xs text-white/35">
          {methods.card && <span><CreditCard size={11} className="inline mb-0.5 mr-1" />Card auto-renews — cancel anytime</span>}
          {methods.crypto && <span><Bitcoin size={11} className="inline mb-0.5 mr-1 text-amber-400/70" />Crypto is a one-time payment — renew when it expires</span>}
        </div>
      )}

      {billing && billing.plan !== "free" && (
        <div className="mt-8 text-center space-y-2">
          {billing.hasCardBilling && isCardSub(billing.provider) && (
            <div>
              <button
                onClick={manage}
                disabled={busy !== null}
                className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white underline underline-offset-4 disabled:opacity-50"
              >
                {busy === "portal" && <Loader2 size={14} className="animate-spin" />}
                Manage billing, change plan, or cancel
              </button>
            </div>
          )}
          {billing.currentPeriodEnd && (
            <p className="text-xs text-white/30">
              {billing.provider === "crypto"
                ? "Plan active until"
                : billing.status === "trialing"
                ? "Trial ends"
                : "Renews"}{" "}
              {new Date(billing.currentPeriodEnd).toLocaleDateString()}
            </p>
          )}
        </div>
      )}
      <p className="mt-10 text-center text-[12px] text-white/30 leading-relaxed">
        Subscriptions renew automatically until cancelled. By subscribing you agree to our{" "}
        <a href="/terms" className="text-white/55 hover:text-white underline underline-offset-2">Terms</a> and{" "}
        <a href="/refunds" className="text-white/55 hover:text-white underline underline-offset-2">Refund Policy</a>
        {" "}— first payments come with a 14-day money-back guarantee.
      </p>
    </div>
  );
}
