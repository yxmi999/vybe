"use client";
// Reminds unverified email sign-ups that their free clips are locked until
// they confirm their address, with a resend button. Also confirms the result
// when the user lands back from the emailed link (?verified=1 / =invalid).
import { useEffect, useState } from "react";

type Me = { email: string; plan?: string; emailVerified?: boolean };

export default function VerifyEmailBanner() {
  const [me, setMe] = useState<Me | null>(null);
  const [linkResult, setLinkResult] = useState<"ok" | "invalid" | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        const v = new URLSearchParams(window.location.search).get("verified");
        setLinkResult(v === "1" ? "ok" : v === "invalid" ? "invalid" : null);
        setMe(d);
      })
      .catch(() => {});
  }, []);

  async function resend() {
    setStatus("sending");
    try {
      const r = await fetch("/api/auth/verify-email/send", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as { error?: string; alreadyVerified?: boolean };
      if (d.alreadyVerified) { setMe((m) => (m ? { ...m, emailVerified: true } : m)); return; }
      if (!r.ok) { setStatus("error"); setMsg(d.error ?? "Couldn't send the email."); return; }
      setStatus("sent");
    } catch {
      setStatus("error");
      setMsg("Couldn't send the email.");
    }
  }

  if (linkResult === "ok" && me?.emailVerified) {
    return (
      <div className="mx-4 mt-4 md:mx-6 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
        Email verified, your free clips are unlocked. 🎉
      </div>
    );
  }
  if (!me || me.emailVerified !== false || (me.plan && me.plan !== "free")) return null;

  return (
    <div className="mx-4 mt-4 md:mx-6 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex-1 min-w-[200px]">
        {linkResult === "invalid" && "That verification link is invalid or expired. "}
        Verify <b>{me.email}</b> to unlock your 10 free clips a month.
        {status === "sent" && " Sent! Check your inbox (and spam)."}
        {status === "error" && ` ${msg}`}
      </span>
      <button
        type="button"
        onClick={resend}
        disabled={status === "sending" || status === "sent"}
        className="rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 px-3 py-1.5 font-medium"
      >
        {status === "sending" ? "Sending…" : status === "sent" ? "Email sent" : "Resend email"}
      </button>
    </div>
  );
}
