"use client";
// Pricing cards with a monthly / yearly switch. Numbers come from lib/pricing
// so they always match checkout.
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { PLAN_PRICING, FULL_PRICING, BETA, type Interval } from "@/lib/pricing";

const PLANS = [
  {
    key: "free" as const,
    name: "Free",
    blurb: "Everything you need to start clipping.",
    features: ["10 clips / month", "Every AI editing tool", "3 connected accounts", "720p exports · Vybe watermark", "Clips kept for 7 days"],
    cta: "Start free",
  },
  {
    key: "creator" as const,
    name: "Creator",
    blurb: "For creators posting every week.",
    features: ["Unlimited clips", "1080p · no watermark", "6 connected accounts", "1 Auto-Pilot · 100 auto-clips / mo", "Clips never expire"],
    cta: "Go Creator",
    highlight: true,
  },
  {
    key: "pro" as const,
    name: "Pro",
    blurb: "For clippers, agencies and full-time creators.",
    features: ["Everything in Creator", "4K exports", "15 connected accounts", "5 Auto-Pilots · 500 auto-clips / mo", "Up to 15 clips per video"],
    cta: "Go Pro",
  },
];

export default function Pricing() {
  const [interval, setIv] = useState<Interval>("monthly");

  return (
    <>
      <div className="flex justify-center mb-10">
        <div role="radiogroup" aria-label="Billing interval"
          className="inline-flex p-1 rounded-xl bg-white/[0.04] border border-white/[0.08]">
          {(["monthly", "yearly"] as const).map((iv) => (
            <button key={iv} type="button" role="radio" aria-checked={interval === iv} onClick={() => setIv(iv)}
              className={`relative px-4 sm:px-5 h-9 rounded-lg text-sm font-medium transition-colors ${
                interval === iv ? "bg-white text-black" : "text-white/55 hover:text-white/80"
              }`}>
              {iv === "monthly" ? "Monthly" : "Yearly"}
              {iv === "yearly" && (
                <span className={`ml-1.5 text-[11px] font-semibold ${interval === iv ? "text-emerald-700" : "text-emerald-400"}`}>2 mo free</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-3 gap-4 md:gap-5 items-stretch">
        {PLANS.map((p) => {
          const price = p.key === "free" ? 0 : PLAN_PRICING[p.key][interval];
          const perMonth = p.key !== "free" && interval === "yearly" ? (PLAN_PRICING[p.key].yearly / 12) : null;
          const later = BETA && p.key !== "free" ? FULL_PRICING[p.key][interval] : null;
          return (
            <div key={p.name}
              className={`relative rounded-2xl border p-6 flex flex-col ${
                p.highlight ? "border-violet-500/45 bg-gradient-to-b from-violet-600/[0.12] to-violet-600/[0.03] shadow-[0_0_60px_rgba(51,92,186,0.15)]" : "border-white/[0.07] bg-white/[0.02]"
              }`}>
              {p.highlight && (
                <span className="absolute -top-3 left-6 rounded-full bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white shadow-lg">
                  Most popular
                </span>
              )}
              <h3 className="text-base font-semibold text-white/90">{p.name}</h3>
              <p className="mt-1 text-[13px] text-white/45 leading-relaxed">{p.blurb}</p>
              <div className="mt-5 flex items-baseline gap-1.5">
                <span className="font-display text-[42px] leading-none font-extrabold text-white tracking-tight tabular-nums">${price}</span>
                <span className="text-sm text-white/40">{p.key === "free" ? "forever" : interval === "monthly" ? "/ month" : "/ year"}</span>
                {later != null && (
                  <span className="ml-1 text-[15px] font-semibold text-white/30 line-through decoration-white/40 tabular-nums">${later}</span>
                )}
              </div>
              <p className="mt-2 min-h-4 text-[12px] leading-snug">
                {later != null
                  ? <span className="text-emerald-300/90 font-medium">Beta price · locked in while you stay subscribed</span>
                  : <span className="text-white/35">{p.key === "free" ? "No card needed" : ""}</span>}
                {perMonth != null && <span className="block text-white/35 font-normal">≈ ${perMonth.toFixed(2)} / month, billed yearly</span>}
              </p>

              <ul className="mt-5 space-y-3 flex-1">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-white/70">
                    <Check size={16} className="mt-0.5 text-violet-400 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>

              <Link href="/register"
                className={`mt-7 flex items-center justify-center gap-2 h-11 rounded-xl text-sm font-semibold transition-all duration-200 ${
                  p.highlight
                    ? "bg-violet-600 hover:bg-violet-500 text-white shadow-[0_0_22px_rgba(51,92,186,0.35)]"
                    : "bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.09] text-white/80"
                }`}>
                {p.cta} <ArrowRight size={14} />
              </Link>
            </div>
          );
        })}
      </div>

      <p className="mt-6 text-center text-[13px] text-white/40 leading-relaxed">
        {BETA
          ? <>Vybe is in public beta — subscribe now and keep the beta price after launch. Pay by card or crypto · cancel anytime.</>
          : <>Pay by card or crypto · cancel anytime.</>}
      </p>
    </>
  );
}
