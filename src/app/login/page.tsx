"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AuthShell, { authInputCls, PasswordInput, SocialButtons, useOAuthError } from "@/components/AuthShell";

export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const oauthError = useOAuthError();
  const shownError = error || oauthError;
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(form),
        headers: { "Content-Type": "application/json" },
      });

      let data: { error?: string; ok?: boolean } = {};
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server error (${res.status})`);
      }

      if (!res.ok) {
        setError(data.error ?? "Login failed. Please try again.");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      headline={<>Pick up where<br />you left off<span className="text-violet-500">.</span></>}
      subcopy="Your clips, calendar, and insights — exactly where you left them."
      perks={[
        "Auto-clip your Twitch, Kick & YouTube streams",
        "AI editor: captions, reframe, virality score",
        "Schedule to every platform from one calendar",
        "Auto-reply to comments & track analytics",
      ]}
      cardTitle={<>Welcome back<span className="text-violet-500">.</span></>}
      cardSubtitle="Sign in to your account"
    >
      {shownError && (
        <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/25 text-red-400 rounded-xl text-sm">
          {shownError}
        </div>
      )}

      <SocialButtons verb="Sign in" />

      <form onSubmit={submit} className="space-y-4">
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
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="••••••••"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors mt-2 shadow-[0_0_24px_rgba(51,92,186,0.35)] disabled:shadow-none"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="text-center text-sm text-white/35 mt-6">
        Don&apos;t have an account?{" "}
        <Link href="/register" className="text-violet-400 hover:text-violet-300 font-medium">
          Create one free
        </Link>
      </p>
    </AuthShell>
  );
}
