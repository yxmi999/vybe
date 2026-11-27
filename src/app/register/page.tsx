"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AuthShell, { authInputCls, PasswordInput, SocialButtons, useOAuthError } from "@/components/AuthShell";
import Turnstile, { type TurnstileHandle } from "@/components/Turnstile";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [captcha, setCaptcha] = useState("");
  const turnstile = useRef<TurnstileHandle>(null);
  const [error, setError] = useState("");
  const oauthError = useOAuthError();
  const shownError = error || oauthError;
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        // The server decides whether the check is required (it's skipped in
        // local dev and the desktop app), so a missing token isn't blocked here.
        body: JSON.stringify({ ...form, "cf-turnstile-response": captcha }),
        headers: { "Content-Type": "application/json" },
      });

      let data: { error?: string; ok?: boolean } = {};
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server error (${res.status})`);
      }

      if (!res.ok) {
        setError(data.error ?? "Registration failed. Please try again.");
        return;
      }

      router.push("/accounts");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
      turnstile.current?.reset(); // tokens are single-use
    }
  }

  return (
    <AuthShell
      eyebrow="Get started"
      headline={<>Clip. Post.<br />Grow<span className="text-violet-500">.</span></>}
      subcopy="Turn long streams into scroll-stopping clips and schedule them everywhere — from one dashboard."
      perks={[
        "Auto-clip Twitch, Kick, YouTube & Rumble VODs",
        "AI editing: captions, reframe, B-roll, covers",
        "Auto-Pilot posts your best moments for you",
        "Free forever — 10 clips a month, no card",
      ]}
      cardTitle={<>Create your account<span className="text-violet-500">.</span></>}
      cardSubtitle="Free forever. No credit card needed."
    >
      {shownError && (
        <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/25 text-red-400 rounded-xl text-sm">
          {shownError}
        </div>
      )}

      <SocialButtons verb="Sign up" />

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="cue block text-white/40 mb-2">Full name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Alex Johnson"
            className={authInputCls}
          />
        </div>
        <div>
          <label className="cue block text-white/40 mb-2">Email</label>
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="you@example.com"
            className={authInputCls}
          />
        </div>
        <div>
          <label className="cue block text-white/40 mb-2">Password</label>
          <PasswordInput
            required
            minLength={8}
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="Min. 8 characters"
          />
        </div>
        <Turnstile ref={turnstile} action="signup" onToken={setCaptcha} className="min-h-[65px]" />
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors mt-2 shadow-[0_0_24px_rgba(51,92,186,0.35)] disabled:shadow-none"
        >
          {loading ? "Creating account…" : "Create free account"}
        </button>
      </form>

      <p className="text-center text-[12px] text-white/35 leading-relaxed mt-4">
        By creating an account you agree to our{" "}
        <Link href="/terms" className="text-white/60 hover:text-white underline underline-offset-2">Terms</Link> and{" "}
        <Link href="/privacy" className="text-white/60 hover:text-white underline underline-offset-2">Privacy Policy</Link>.
      </p>

      <p className="text-center text-sm text-white/35 mt-6">
        Already have an account?{" "}
        <Link href="/login" className="text-violet-400 hover:text-violet-300 font-medium">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
