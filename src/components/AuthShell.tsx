"use client";
import { useState, useSyncExternalStore } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import { Wordmark } from "@/components/brand/Wordmark";

// Shared two-column chrome for the login + register pages: a left "booth" panel
// (brand, headline, product perks) and a right form card. The pages own their
// form fields and submit logic; this owns everything around them so the two
// stay identical without duplicating ~60 lines each.

export const authInputCls =
  "w-full bg-white/[0.04] border border-white/[0.09] text-white placeholder:text-white/25 rounded-lg px-4 py-2.5 text-sm outline-none focus:border-violet-500/60 focus:bg-white/[0.06] focus:ring-2 focus:ring-violet-500/15 transition-all";

// Password field with a show/hide toggle — auth forms are the one place it
// genuinely helps. Spreads through the rest of the input props.
export function PasswordInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={show ? "text" : "password"} className={`${authInputCls} pr-11`} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-white/30 hover:text-white/70 transition-colors"
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

// Error passed back by the Google/GitHub/Discord callback as ?error=… — read from the
// URL without useSearchParams (which would force a Suspense boundary); the
// server snapshot is "" so hydration matches.
const noopSubscribe = () => () => {};
export function useOAuthError() {
  return useSyncExternalStore(
    noopSubscribe,
    () => new URLSearchParams(window.location.search).get("error") ?? "",
    () => "",
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3a7.2 7.2 0 0 1-10.71-3.78H1.35v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.36 14.31a7.2 7.2 0 0 1 0-4.62v-3.1H1.35a12 12 0 0 0 0 10.82l4.01-3.1z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.97 11.97 0 0 0 1.35 6.59l4.01 3.1A7.15 7.15 0 0 1 12 4.77z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57v-2.02c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .3z" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="#5865F2">
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.85a.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.25a18.3 18.3 0 0 0-5.49 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.92 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-2a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1-.01-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.07 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.88.9a.08.08 0 0 0-.04.1c.36.7.78 1.37 1.23 2a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6.01-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42z" />
    </svg>
  );
}

const socialBtnCls =
  "flex-1 flex items-center justify-center gap-2.5 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.09] hover:border-white/[0.16] text-white/85 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors";

// Google + GitHub + Discord buttons with an "or" divider underneath; plain links because
// the flow is a full-page redirect through /api/auth/oauth/{provider} (a
// <Link> would attempt client-side navigation to an API route).
export function SocialButtons({ verb }: { verb: "Sign in" | "Sign up" }) {
  return (
    <>
      <div className="flex flex-col sm:flex-row gap-3">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/auth/oauth/google" className={socialBtnCls} aria-label={`${verb} with Google`}>
          <GoogleIcon /> Google
        </a>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/auth/oauth/github" className={socialBtnCls} aria-label={`${verb} with GitHub`}>
          <GitHubIcon /> GitHub
        </a>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/auth/oauth/discord" className={socialBtnCls} aria-label={`${verb} with Discord`}>
          <DiscordIcon /> Discord
        </a>
      </div>
      <div className="flex items-center gap-3 my-6">
        <div className="h-px flex-1 bg-white/[0.08]" />
        <span className="cue text-white/30">or with email</span>
        <div className="h-px flex-1 bg-white/[0.08]" />
      </div>
    </>
  );
}

export default function AuthShell({
  eyebrow,
  headline,
  subcopy,
  perks,
  cardTitle,
  cardSubtitle,
  children,
}: {
  eyebrow: string;
  headline: React.ReactNode;
  subcopy: string;
  perks: string[];
  cardTitle: React.ReactNode;
  cardSubtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-d0a flex text-white">
      {/* Left — the booth */}
      <div className="hidden lg:flex flex-col justify-between w-1/2 relative overflow-hidden p-12 border-r border-white/[0.06]">
        <div className="absolute inset-0 bg-gradient-to-br from-violet-700/[0.16] via-d0c to-d0a" />
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-violet-600/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full bg-fuchsia-600/[0.07] blur-[120px]" />

        <div className="relative">
          <Wordmark height={30} className="text-white" />
        </div>

        <div className="relative">
          <p className="cue text-violet-400/80 mb-4">{eyebrow}</p>
          <h2 className="font-display text-5xl font-extrabold mb-5 leading-[1.05] tracking-tight">
            {headline}
          </h2>
          <p className="text-white/45 mb-10 max-w-sm leading-relaxed">{subcopy}</p>
          <ul className="space-y-3 max-w-sm">
            {perks.map((p) => (
              <li key={p} className="flex items-center gap-3 text-white/70 text-sm">
                <div className="w-5 h-5 rounded-full bg-violet-500/15 border border-violet-500/30 flex items-center justify-center flex-shrink-0">
                  <Check size={12} className="text-violet-300" />
                </div>
                {p}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-white/20 text-xs">© 2026 Vybe. All rights reserved.</p>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md anim-rise">
          <div className="flex mb-8 lg:hidden justify-center">
            <Wordmark height={34} className="text-white" />
          </div>

          <div className="bg-d12 border border-white/[0.08] rounded-2xl p-8 shadow-2xl">
            <h1 className="font-display text-3xl font-extrabold tracking-tight mb-1">{cardTitle}</h1>
            <p className="text-white/35 text-sm mb-7">{cardSubtitle}</p>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
