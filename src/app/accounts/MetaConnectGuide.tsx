"use client";
import { useState } from "react";
import { X, ArrowRight, AlertTriangle, CheckCircle2, Circle, ChevronDown, Lightbulb } from "lucide-react";
import { BrandIcon } from "@/components/BrandIcon";

// Step-by-step help for connecting Instagram through Meta's login dialog —
// the flow where most connection attempts fail (personal accounts, unticked
// permissions, wrong account logged in, missing Facebook Page link).

type Step = { title: string; body: string; how?: string[] };

const STEPS: Step[] = [
  {
    title: "Switch to a Business or Creator account",
    body: "Meta only lets apps post to professional Instagram accounts. Personal accounts can't be connected. Switching is free and you can switch back later.",
    how: [
      "Open the Instagram app → your profile → ☰ menu",
      "Settings and activity → Account type and tools",
      "Tap Switch to professional account → pick Creator or Business",
    ],
  },
  {
    title: "Log in to the right Instagram account in this browser",
    body: "Meta uses whatever account is already signed in. If you manage several, open instagram.com in this browser first and make sure the account you want to connect is the active one.",
  },
  {
    title: "Using Facebook? Link your Instagram to a Facebook Page",
    body: "Only needed if you pick \"Continue with Facebook\" in the Meta dialog. With \"Continue with Instagram\" you can skip this.",
    how: [
      "Instagram app → Settings → Accounts Center → Accounts → Add accounts",
      "Or in Facebook: your Page → Settings → Linked accounts → Instagram → Connect",
    ],
  },
  {
    title: "Accept every permission in the Meta dialog",
    body: "When Meta asks what Vybe can access, keep everything switched on and make sure your Instagram account (and Page, if asked) is ticked. Unticking an item is the #1 reason a connection \"succeeds\" but no account shows up.",
  },
];

const TROUBLESHOOT: { match: RegExp; title: string; fix: string }[] = [
  { match: /no instagram professional account was shared|no .*account.*shared/i, title: "No account was shared", fix: "In the Meta dialog you didn't select your Instagram account. Click Connect again, choose \"Edit access\" or \"Edit settings\" if shown, and tick your Instagram account." },
  { match: /business or creator|professional account/i, title: "Personal account", fix: "Your account is still a personal account. Do step 1, wait a minute, then connect again." },
  { match: /access_denied|user denied|cancel|permissions? error/i, title: "Permission declined", fix: "The dialog was closed or a permission was declined. Connect again and accept all permissions — you can remove access any time from Instagram settings." },
  { match: /different vybe account|invalid_state/i, title: "Session mismatch", fix: "The link expired or was opened in another tab/account. Refresh this page and click Connect once." },
  { match: /expired|session has been invalidated|code has been used|OAuthException/i, title: "Login expired", fix: "Meta's login code expired. Close other Meta tabs, refresh this page and connect again in one go." },
  { match: /not configured/i, title: "Server not configured", fix: "Instagram isn't set up on this server yet. Please contact support." },
];

const FAQ = [
  { q: "I connected but I don't see my account", a: "Usually a permission or the account was unticked in the Meta dialog. Reconnect and make sure your Instagram account is selected." },
  { q: "It logs me into the wrong account", a: "Log out of instagram.com / facebook.com in this browser (or use a private window), log in with the right account, then connect." },
  { q: "Will Vybe post without asking?", a: "No. Vybe only publishes what you schedule or post yourself. You can disconnect any time from this page or from Instagram → Settings → Apps and websites." },
];

export function matchMetaError(detail: string | null) {
  if (!detail) return null;
  return TROUBLESHOOT.find((t) => t.match.test(detail)) ?? null;
}

export default function MetaConnectGuide({ authUrl, errorDetail, onClose }: {
  authUrl: string;
  errorDetail?: string | null;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<boolean[]>(() => STEPS.map(() => false));
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const known = matchMetaError(errorDetail ?? null);
  const done = checked.filter(Boolean).length;
  // Step 3 is conditional, so it isn't required to continue.
  const ready = checked.every((c, i) => c || i === 2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Connect Instagram"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl max-h-[92vh] overflow-y-auto bg-d12 border border-white/[0.08] rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <BrandIcon platform="instagram" size={18} />
            <h2 className="text-sm font-semibold text-white/80">Connect Instagram — before you start</h2>
          </div>
          <button type="button" onClick={onClose} className="text-white/30 hover:text-white/70" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {errorDetail && (
            <div className="flex gap-2.5 px-3.5 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertTriangle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs space-y-1">
                <p className="font-semibold text-red-300">{known ? known.title : "Last attempt failed"}</p>
                <p className="text-red-200/70">{known ? known.fix : "Go through the checklist below, then try again."}</p>
              </div>
            </div>
          )}

          <p className="text-xs text-white/45 leading-relaxed">
            Instagram connects through Meta&apos;s login screen. It takes about a minute — tick each step as you go so the connection works on the first try.
          </p>

          <ol className="space-y-2">
            {STEPS.map((s, i) => (
              <li key={i} className={`rounded-xl border transition-colors ${checked[i] ? "border-emerald-500/25 bg-emerald-500/[0.05]" : "border-white/[0.06] bg-white/[0.02]"}`}>
                <button type="button" onClick={() => setChecked((c) => c.map((v, j) => (j === i ? !v : v)))}
                  className="w-full flex items-start gap-3 p-3.5 text-left" aria-pressed={checked[i]}>
                  {checked[i]
                    ? <CheckCircle2 size={17} className="text-emerald-400 flex-shrink-0 mt-px" />
                    : <Circle size={17} className="text-white/20 flex-shrink-0 mt-px" />}
                  <div className="min-w-0 space-y-1">
                    <p className="text-[13px] font-semibold text-white/80">
                      <span className="text-white/30 tabular-nums mr-1.5">{i + 1}.</span>{s.title}
                    </p>
                    <p className="text-xs text-white/45 leading-relaxed">{s.body}</p>
                    {s.how && (
                      <ul className="pt-1 space-y-0.5">
                        {s.how.map((h) => (
                          <li key={h} className="text-[11px] text-white/35 flex gap-1.5"><span className="text-violet-400/60">›</span>{h}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ol>

          <div className="flex gap-2.5 px-3.5 py-3 rounded-xl bg-violet-500/[0.07] border border-violet-500/20">
            <Lightbulb size={15} className="text-violet-300 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-white/55 leading-relaxed">
              In the Meta window, <span className="text-white/80 font-medium">&quot;Continue with Instagram&quot;</span> is the simplest path — no Facebook Page needed.
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-white/30 font-semibold px-1">Common problems</p>
            {FAQ.map((f, i) => (
              <div key={i} className="border-b border-white/[0.04] last:border-0">
                <button type="button" onClick={() => setOpenFaq(openFaq === i ? null : i)} aria-expanded={openFaq === i}
                  className="w-full flex items-center justify-between gap-3 px-1 py-2.5 text-left text-xs text-white/60 hover:text-white/80">
                  {f.q}
                  <ChevronDown size={13} className={`flex-shrink-0 transition-transform ${openFaq === i ? "rotate-180" : ""}`} />
                </button>
                {openFaq === i && <p className="px-1 pb-3 text-xs text-white/40 leading-relaxed">{f.a}</p>}
              </div>
            ))}
          </div>
        </div>

        <div className="sticky bottom-0 flex items-center justify-between gap-3 px-5 py-4 border-t border-white/[0.06] bg-d12">
          <span className="text-[11px] text-white/30 tabular-nums">{done}/{STEPS.length} checked</span>
          <a href={authUrl}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
              ready ? "bg-violet-600 hover:bg-violet-500 text-white" : "bg-white/[0.06] text-white/55 hover:bg-white/[0.1]"}`}>
            {ready ? "I'm ready — continue to Meta" : "Continue anyway"} <ArrowRight size={13} />
          </a>
        </div>
      </div>
    </div>
  );
}
