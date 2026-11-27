"use client";
// Paddle's "default payment link" target. Paddle sends buyers here with
// ?_ptxn=txn_… (new checkouts from /api/billing/paddle/checkout, and the
// payment-method-update links Paddle emails to subscribers). Loading Paddle.js
// with our client-side token makes it open the checkout for that transaction
// automatically, as an overlay on this page.
//
// Public (see proxy.ts + AppShell): payment-update emails can be opened while
// signed out. Nothing here grants access — plans change only via the webhook.
import Script from "next/script";
import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, ShieldCheck } from "lucide-react";

type PaddleEvent = { name?: string };
type PaddleGlobal = {
  Environment: { set: (env: string) => void };
  Initialize: (opts: {
    token: string;
    pwCustomer?: { id: string };
    eventCallback?: (e: PaddleEvent) => void;
    checkout?: { settings?: Record<string, unknown> };
  }) => void;
};

const TOKEN = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "";
const ENV = process.env.NEXT_PUBLIC_PADDLE_ENV === "production" ? "production" : "sandbox";

function PayInner() {
  const params = useSearchParams();
  const txn = params.get("_ptxn");
  const [state, setState] = useState<"loading" | "open" | "done" | "closed" | "error">("loading");
  const [error, setError] = useState("");
  const started = useRef(false);

  async function start() {
    if (started.current) return;
    const Paddle = (window as unknown as { Paddle?: PaddleGlobal }).Paddle;
    if (!Paddle) { setState("error"); setError("The payment form couldn't load. Disable any blocker for this page and refresh."); return; }
    if (!TOKEN) { setState("error"); setError("Card payments aren't configured yet."); return; }
    started.current = true;
    if (ENV === "sandbox") Paddle.Environment.set("sandbox");
    // Paddle Retain: identify the signed-in buyer by their PADDLE customer id
    // (ctm_…), never our user id or email. Signed-out visitors (e.g. a card-
    // update email) simply open checkout without it.
    let pwCustomer: { id: string } | undefined;
    try {
      const r = await fetch("/api/billing", { signal: AbortSignal.timeout(4000) });
      const d = r.ok ? await r.json() : null;
      if (typeof d?.paddleCustomerId === "string" && d.paddleCustomerId.startsWith("ctm_")) pwCustomer = { id: d.paddleCustomerId };
    } catch { /* not signed in / slow — checkout still opens */ }
    Paddle.Initialize({
      token: TOKEN,
      ...(pwCustomer ? { pwCustomer } : {}),
      checkout: {
        settings: {
          displayMode: "overlay",
          theme: "dark",
          locale: "en",
          successUrl: `${window.location.origin}/billing?status=success`,
        },
      },
      eventCallback: (e) => {
        if (e.name === "checkout.loaded") setState("open");
        else if (e.name === "checkout.completed") setState("done");
        else if (e.name === "checkout.closed") setState((s) => (s === "done" ? s : "closed"));
        else if (e.name === "checkout.error") { setState("error"); setError("Something went wrong with the payment form. Please try again."); }
      },
    });
  }

  // next/script's onReady fires on load AND on every later mount (cached
  // script), so it's the only trigger needed; `started` guards double init.

  if (!txn) {
    return (
      <Shell>
        <p className="text-white/70">This page opens a payment. Start from your <Link href="/billing" className="text-violet-300 hover:text-violet-200">Billing page</Link>.</p>
      </Shell>
    );
  }

  return (
    <>
      <Script src="https://cdn.paddle.com/paddle/v2/paddle.js" strategy="afterInteractive" onReady={() => { void start(); }}
        onError={() => { setState("error"); setError("The payment form couldn't load. Disable any blocker for this page and refresh."); }} />
      <Shell>
        {state === "loading" && <p className="flex items-center gap-2 text-white/60"><Loader2 size={16} className="animate-spin" /> Opening secure checkout…</p>}
        {state === "open" && <p className="text-white/50 text-sm">Complete your payment in the secure form.</p>}
        {state === "done" && (
          <div className="space-y-3">
            <p className="text-white/85">Payment received — thank you! Your plan updates in a few seconds.</p>
            <Link href="/billing?status=success" className="inline-flex h-10 px-4 items-center rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white">Go to billing</Link>
          </div>
        )}
        {state === "closed" && (
          <div className="space-y-3">
            <p className="text-white/70">Checkout closed — you haven’t been charged.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => window.location.reload()} className="h-10 px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white">Reopen checkout</button>
              <Link href="/billing?status=cancelled" className="inline-flex h-10 px-4 items-center rounded-xl border border-white/10 text-sm text-white/70 hover:text-white">Back to billing</Link>
            </div>
          </div>
        )}
        {state === "error" && <p className="text-red-300">{error}</p>}
      </Shell>
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-d0a text-white flex items-center justify-center px-5">
      <div className="max-w-md w-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 text-center space-y-4">
        <p className="font-display text-2xl font-extrabold">Vybe<span className="text-violet-400">.</span></p>
        {children}
        <p className="flex items-center justify-center gap-1.5 text-[11px] text-white/30">
          <ShieldCheck size={12} /> Payments are processed by Paddle, our reseller and Merchant of Record.
        </p>
      </div>
    </div>
  );
}

export default function PayPage() {
  return (
    <Suspense fallback={null}>
      <PayInner />
    </Suspense>
  );
}
