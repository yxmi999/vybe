import type { Metadata } from "next";
import Link from "next/link";
import {
  Calendar, BarChart2, MessageSquare, Sparkles, ArrowRight, Check, ChevronDown,
  Captions, ScanFace, LayoutPanelTop, Scissors, Flame, ImageIcon, Copy, Film, Music,
  TrendingUp, Search, Timer, DollarSign, Monitor, Undo2, Zap, KeyRound,
} from "lucide-react";
import AppPreview from "@/components/AppPreview";
import Worker from "@/components/icons/Worker";
import { Wordmark } from "@/components/brand/Wordmark";
import HeroDemo from "@/components/landing/HeroDemo";
import HeroHeadline from "@/components/landing/HeroHeadline";
import MobileNav from "@/components/landing/MobileNav";
import Pricing from "@/components/landing/Pricing";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Vybe (Beta) — Turn long videos into viral shorts with AI",
  description:
    "Vybe finds the best moments in your streams, podcasts and long videos, edits them into vertical shorts with AI captions, smart layouts and auto-reframe, then schedules them everywhere.",
};

// ─── Content ──────────────────────────────────────────────────────────────────

const PLATFORMS = [
  { name: "Twitch", dot: "bg-purple-500" },
  { name: "Kick", dot: "bg-green-500" },
  { name: "YouTube", dot: "bg-red-500" },
  { name: "Rumble", dot: "bg-lime-500" },
  { name: "TikTok", dot: "bg-white/60" },
  { name: "Instagram", dot: "bg-pink-500" },
  { name: "X / Twitter", dot: "bg-white/60" },
];

const WORKFLOW = [
  {
    n: "01",
    icon: Search,
    title: "Find the moments",
    desc: "Paste a stream, a podcast episode or any long video and Vybe hands back its best moments, ranked and ready — no more scrubbing through hours of footage.",
    bullets: ["Streams, podcasts, videos & uploads", "Clips start and end in the right place"],
  },
  {
    n: "02",
    icon: Sparkles,
    title: "Edit with AI",
    desc: "One click turns a moment into a finished short: vertical reframe, facecam split, animated captions, punch-ins and a hook — in your own style.",
    bullets: ["Auto-edit or describe the edit", "Copy the style of any short"],
  },
  {
    n: "03",
    icon: Calendar,
    title: "Post everywhere",
    desc: "Schedule to TikTok, YouTube, Instagram and X from one calendar, or let Auto-Pilot clip every new upload or stream and queue the winners for you.",
    bullets: ["Auto-replies keep comments going", "Analytics + campaign earnings"],
  },
];

const EDITOR_TOOLS = [
  { icon: Captions, title: "Animated captions", desc: "Word-level karaoke, one-word pop or classic lines. 8 fonts, 4 styles, auto emoji — what you see is what exports." },
  { icon: ScanFace, title: "Auto-reframe", desc: "Face tracking keeps the action centered when you go vertical, with smooth keyframed pans you can fine-tune." },
  { icon: LayoutPanelTop, title: "Facecam split-screen", desc: "Detects the webcam overlay and stacks it over gameplay. Five layouts, each panel its own crop." },
  { icon: Scissors, title: "Auto-tighten", desc: "Cuts dead air and filler words in one pass, so every second of the short earns its place." },
  { icon: Flame, title: "Virality score", desc: "Rates the hook and pacing before you post, then tells you exactly what to fix." },
  { icon: ImageIcon, title: "AI cover & titles", desc: "Picks the strongest frame, writes the hook text and suggests titles from the transcript." },
  { icon: Film, title: "B-roll & overlays", desc: "Drop in images, videos and sound effects on the timeline — or let AI pick B-roll from what’s being said." },
  { icon: Music, title: "Audio tools", desc: "Background music, keyframed ducking, pitch, and one-tap loudness leveling for every platform." },
  { icon: Undo2, title: "Real timeline", desc: "Split, trim, reorder and delete segments, keyframe crop and zoom, timed effects — with full undo/redo." },
];

const CLIPPER = [
  { icon: Film, title: "Anything long", desc: "Streams, podcasts, interviews, vlogs and webinars — from YouTube, Twitch, Kick or Rumble." },
  { icon: TrendingUp, title: "Ranked for you", desc: "Every moment comes back scored, best first, so you know where to start." },
  { icon: Search, title: "Find something specific", desc: "Looking for the boss fight or the sponsor read? Tell Vybe what to look for." },
  { icon: Timer, title: "Clean cuts", desc: "Clips start and end where they should — no sentences chopped in half." },
  { icon: Sparkles, title: "Preview, then edit", desc: "Play any moment first, then open it in the editor with one tap." },
  { icon: Calendar, title: "A week in one go", desc: "Pick your favorites, apply your style and schedule them all at once." },
];

const AUTOMATION = [
  { icon: Worker, title: "Auto-Pilot", desc: "Point it at a channel. Every new stream or upload gets clipped, edited in your saved style and queued to post — hands-off." },
  { icon: Calendar, title: "Calendar & scheduling", desc: "Plan a week of posts across every account. Pick a time and Vybe publishes on the dot." },
  { icon: MessageSquare, title: "Auto-Respond", desc: "Keyword rules answer new comments automatically while you focus on making the next clip." },
  { icon: BarChart2, title: "Analytics", desc: "Views, likes, reach and engagement for every post, across every connected platform." },
  { icon: DollarSign, title: "Clipping campaigns", desc: "Track CPM payouts per video — caps, minimums and estimated earnings, calculated for you." },
];

const FAQS = [
  {
    q: "What does “beta” mean?",
    a: "Vybe is live and fully usable, but we’re shipping updates every week — new features, faster renders and the occasional rough edge. Your feedback shapes what comes next, and anyone who subscribes during the beta keeps the beta price after launch for as long as they stay subscribed.",
  },
  {
    q: "Where do the clips come from?",
    a: "Anything long-form: a stream VOD from Twitch, Kick, YouTube or Rumble, a podcast episode, an interview, a vlog — or just upload your own file. You can also import a single clip from TikTok, Instagram and more.",
  },
  {
    q: "What does “copy a style” do?",
    a: "Give Vybe any short you like — an upload, a link or one of your clips. It measures the pacing and watches the edit to learn the captions, hook text, punch-ins, color grade and transitions, then applies that recipe to your clips with Auto-edit or Auto-Pilot.",
  },
  {
    q: "Can I still edit by hand?",
    a: "Yes — everything AI does lands on a normal timeline you control: trim and split segments, drag captions, keyframe crop and zoom, add music and overlays, and undo anything. The preview matches the export frame for frame.",
  },
  {
    q: "Does it work on my phone?",
    a: "Yes. The dashboard and the clip editor are built for touch: the preview stays pinned while you scroll the tools, captions drag with a finger, and exports run in the cloud.",
  },
  {
    q: "Which platforms can I post to?",
    a: "Schedule and publish to YouTube, TikTok, Instagram and X. Sign in with Google, GitHub, Discord or email, then connect each account with one click.",
  },
  {
    q: "Is there a desktop app?",
    a: "Yes — a Windows app runs the whole pipeline on your own machine with your own AI keys, so downloads and renders never wait on a server.",
  },
  {
    q: "How does billing work?",
    a: "Start free with no card. Paid plans are monthly or yearly (two months free), by card or crypto, and you can cancel anytime. Keeping a small watermark makes them cheaper.",
  },
];

// ─── Small building blocks ────────────────────────────────────────────────────

function BetaBadge() {
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider text-violet-200 bg-violet-500/15 border border-violet-500/30 px-1.5 py-0.5 rounded-md leading-none">
      Beta
    </span>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="cue text-violet-400/80 mb-3">{children}</p>;
}

function H2({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={`font-display text-[32px] leading-[1.08] sm:text-5xl font-extrabold tracking-tight bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent ${className}`}>
      {children}
    </h2>
  );
}

function PrimaryCta({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <Link href="/register"
      className={`inline-flex items-center justify-center gap-2 h-12 px-7 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-[15px]
        transition-all duration-200 shadow-[0_0_28px_rgba(51,92,186,0.4)] hover:shadow-[0_0_36px_rgba(51,92,186,0.55)] active:scale-[0.98] ${className}`}>
      {children}
    </Link>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-d0a text-white overflow-x-clip">

      {/* Background glow */}
      <div className="fixed inset-0 pointer-events-none -z-10">
        <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[1100px] h-[700px] bg-violet-600/[0.09] rounded-full blur-[140px]" />
      </div>

      {/* ── Nav ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-d0a/80 backdrop-blur-xl">
        <nav className="max-w-6xl mx-auto flex items-center justify-between px-5 sm:px-6 h-14">
          <Link href="/" aria-label="Vybe home" className="flex items-center gap-2">
            <Wordmark height={22} className="text-white" />
            <BetaBadge />
          </Link>

          <div className="hidden md:flex items-center gap-7 text-sm text-white/50">
            <a href="#workflow" className="hover:text-white transition-colors">How it works</a>
            <a href="#editor" className="hover:text-white transition-colors">Editor</a>
            <a href="#clipper" className="hover:text-white transition-colors">Auto-Clipper</a>
            <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
            <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
          </div>

          <div className="flex items-center gap-1 sm:gap-2">
            <Link href="/login" className="hidden sm:block text-sm text-white/55 hover:text-white px-3 py-1.5 transition-colors">
              Sign in
            </Link>
            <Link href="/register"
              className="flex items-center gap-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white font-semibold px-3.5 sm:px-4 h-9 rounded-lg transition-colors shadow-[0_0_16px_rgba(51,92,186,0.3)]">
              Start free <ArrowRight size={13} />
            </Link>
            <MobileNav />
          </div>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section className="relative max-w-6xl mx-auto px-5 sm:px-6 pt-14 sm:pt-20 pb-16 sm:pb-24 text-center">
        {/* Aurora + grid backdrop */}
        <div aria-hidden className="absolute inset-x-0 -top-14 h-[760px] -z-10 pointer-events-none overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
          <div className="absolute inset-0 opacity-[0.35] [background-image:linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_50%_30%,black_20%,transparent_70%)]" />
          <div className="aurora-a absolute left-[8%] top-[4%] w-[520px] h-[420px] rounded-full bg-violet-600/25 blur-[110px]" />
          <div className="aurora-b absolute right-[6%] top-[14%] w-[460px] h-[380px] rounded-full bg-fuchsia-500/[0.14] blur-[110px]" />
        </div>

        <a href="#pricing"
          className="inline-flex items-center gap-2 bg-violet-500/[0.08] border border-violet-500/25 text-violet-200/90 text-[12px] font-medium pl-1.5 pr-3 py-1 rounded-full mb-7 hover:border-violet-500/45 transition-colors">
          <span className="bg-violet-600 text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">Beta</span>
          Public beta is open · lock in beta pricing
          <ArrowRight size={12} className="text-violet-300/70" />
        </a>

        <HeroHeadline />

        <p className="hero-blur-in [animation-delay:0.7s] text-white/55 text-base sm:text-lg max-w-2xl mx-auto mb-9 leading-relaxed">
          Vybe finds the best moments in any long video, edits them into shorts and posts them everywhere.
        </p>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 mb-5 max-w-sm sm:max-w-none mx-auto">
          <PrimaryCta>Start free — no card needed <ArrowRight size={15} /></PrimaryCta>
          <a href="#workflow"
            className="inline-flex items-center justify-center gap-2 h-12 px-6 rounded-xl border border-white/[0.12] bg-white/[0.03] hover:bg-white/[0.07] text-white/80 text-[15px] font-medium transition-colors">
            See how it works
          </a>
        </div>
        <p className="text-[12px] text-white/35 mb-14 sm:mb-20">
          Sign up with Google, GitHub or Discord · 10 free clips every month
        </p>

        <HeroDemo />
      </section>

      {/* ── Platforms ── */}
      <section className="border-y border-white/[0.05] bg-white/[0.015] py-8">
        <div className="max-w-5xl mx-auto px-5 sm:px-6">
          <p className="cue text-white/30 text-center mb-5">Clip from · post to</p>
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {PLATFORMS.map(({ name, dot }) => (
              <div key={name}
                className="flex items-center gap-2 bg-white/[0.04] border border-white/[0.07] rounded-full px-3.5 py-1.5 sm:px-4 sm:py-2">
                <span className={`w-2 h-2 rounded-full ${dot}`} />
                <span className="text-[13px] sm:text-sm text-white/60 font-medium">{name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Workflow ── */}
      <section id="workflow" className="max-w-6xl mx-auto px-5 sm:px-6 py-20 sm:py-28 scroll-mt-16">
        <div className="max-w-2xl mb-12 sm:mb-16">
          <Eyebrow>How it works</Eyebrow>
          <H2>From one long video to a week of shorts.</H2>
          <p className="mt-4 text-white/50 text-base leading-relaxed">
            The boring parts — scrubbing, cropping, captioning, uploading — are automated. The creative calls stay yours.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          {WORKFLOW.map(({ n, icon: Icon, title, desc, bullets }) => (
            <div key={n} className="relative rounded-2xl border border-white/[0.07] bg-gradient-to-b from-white/[0.035] to-transparent p-6 sm:p-7">
              <div className="flex items-center justify-between mb-6">
                <span className="w-11 h-11 rounded-xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center">
                  <Icon size={19} className="text-violet-300" />
                </span>
                <span className="font-mono text-sm text-white/20">{n}</span>
              </div>
              <h3 className="text-lg font-semibold text-white/90 mb-2">{title}</h3>
              <p className="text-white/50 text-sm leading-relaxed mb-5">{desc}</p>
              <ul className="space-y-2">
                {bullets.map((b) => (
                  <li key={b} className="flex items-center gap-2 text-[13px] text-white/60">
                    <Check size={14} className="text-violet-400 flex-shrink-0" /> {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ── Editor ── */}
      <section id="editor" className="border-t border-white/[0.05] bg-white/[0.012] py-20 sm:py-28 scroll-mt-16">
        <div className="max-w-6xl mx-auto px-5 sm:px-6">
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center mb-14 sm:mb-20">
            <div>
              <Eyebrow>The editor</Eyebrow>
              <H2>Describe the edit. <span className="text-violet-300">Or don’t.</span></H2>
              <p className="mt-5 text-white/55 text-base leading-relaxed">
                Hit <span className="text-white font-medium">Auto-edit</span> and the AI watches the clip, writes the hook,
                trims the slow start, adds punch-ins on the big reaction and captions every word. Want something specific?
                Just type it — “vertical, yellow karaoke subs, flash on the peak” — and every control gets set for you.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Every AI change shows up as a list you can undo in one click",
                  "The preview is the exact export frame — no surprises after render",
                  "Works the same on desktop, tablet and phone",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-3 text-[15px] text-white/70">
                    <span className="mt-0.5 w-5 h-5 rounded-full bg-violet-500/15 border border-violet-500/30 flex items-center justify-center flex-shrink-0">
                      <Check size={11} className="text-violet-300" />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>

            {/* Copy-a-style card */}
            <div className="relative rounded-3xl border border-violet-500/25 bg-gradient-to-br from-violet-600/[0.14] via-violet-600/[0.05] to-transparent p-6 sm:p-8 overflow-hidden">
              <div className="absolute -top-20 -right-20 w-64 h-64 bg-fuchsia-500/10 blur-[70px] rounded-full pointer-events-none" />
              <div className="relative">
                <div className="flex items-center gap-2.5 mb-5">
                  <span className="w-10 h-10 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
                    <Copy size={18} className="text-violet-200" />
                  </span>
                  <div>
                    <p className="font-semibold text-white">Copy a style</p>
                    <p className="text-[12px] text-white/45">Learned from any short you like</p>
                  </div>
                </div>
                <div className="rounded-xl bg-black/40 border border-white/[0.07] p-4 mb-4">
                  <p className="text-[11px] font-mono text-white/35 mb-3">Style recipe · “Neon Hype”</p>
                  <div className="flex flex-wrap gap-2">
                    {["Karaoke · Impact · yellow", "Hook text top", "Cut every 1.8s", "Punch-in on beats", "Vivid grade", "Flash transitions"].map((t) => (
                      <span key={t} className="text-[12px] text-violet-100/90 bg-violet-500/15 border border-violet-500/25 px-2.5 py-1 rounded-full">{t}</span>
                    ))}
                  </div>
                </div>
                <p className="text-sm text-white/55 leading-relaxed">
                  Upload a reference or paste a link. Vybe measures the cut rate and studies the edit, saves it as a
                  reusable style, and applies it to every new clip — including ones Auto-Pilot makes while you sleep.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {["Streamer Hype", "Clean Creator", "Podcast Clip", "Cinematic"].map((s) => (
                    <span key={s} className="text-[12px] text-white/55 bg-white/[0.04] border border-white/[0.08] px-2.5 py-1 rounded-lg">{s}</span>
                  ))}
                  <span className="text-[12px] text-white/35 px-1 py-1">+ your own</span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {EDITOR_TOOLS.map(({ icon: Icon, title, desc }) => (
              <div key={title}
                className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 sm:p-6 hover:border-white/[0.14] hover:bg-white/[0.035] transition-colors">
                <span className="w-10 h-10 rounded-xl bg-white/[0.05] border border-white/[0.08] flex items-center justify-center mb-4 group-hover:border-violet-500/35 group-hover:bg-violet-500/10 transition-colors">
                  <Icon size={18} className="text-white/60 group-hover:text-violet-300 transition-colors" />
                </span>
                <h3 className="font-semibold text-white/90 mb-1.5">{title}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Auto-Clipper ── */}
      <section id="clipper" className="max-w-6xl mx-auto px-5 sm:px-6 py-20 sm:py-28 scroll-mt-16">
        <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
          <Eyebrow>Auto-Clipper</Eyebrow>
          <H2>Hours of footage in. Clips out.</H2>
          <p className="mt-4 text-white/50 text-base leading-relaxed">
            Drop in a stream, an episode or any long video and get back the moments worth posting — scored, trimmed and one tap from the editor.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {CLIPPER.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
              <span className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
                <Icon size={18} className="text-violet-300" />
              </span>
              <div>
                <h3 className="font-semibold text-white/90 mb-1">{title}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Automation ── */}
      <section id="automation" className="border-t border-white/[0.05] bg-white/[0.012] py-20 sm:py-28 scroll-mt-16">
        <div className="max-w-6xl mx-auto px-5 sm:px-6">
          <div className="grid lg:grid-cols-[1fr_1.15fr] gap-10 lg:gap-14 items-center">
            <div>
              <Eyebrow>Automation</Eyebrow>
              <H2>Runs your channel while you create.</H2>
              <div className="mt-8 space-y-5">
                {AUTOMATION.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex gap-4">
                    <span className="w-10 h-10 rounded-xl bg-white/[0.05] border border-white/[0.08] flex items-center justify-center flex-shrink-0">
                      <Icon size={18} className="text-violet-300" />
                    </span>
                    <div>
                      <h3 className="font-semibold text-white/90">{title}</h3>
                      <p className="text-white/50 text-sm leading-relaxed mt-0.5">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <AppPreview />
          </div>

          {/* Desktop app */}
          <div className="mt-16 sm:mt-20 rounded-3xl border border-white/[0.08] bg-gradient-to-r from-white/[0.04] to-transparent p-6 sm:p-8 flex flex-col md:flex-row md:items-center gap-6">
            <span className="w-14 h-14 rounded-2xl bg-violet-500/15 border border-violet-500/25 flex items-center justify-center flex-shrink-0">
              <Monitor size={24} className="text-violet-300" />
            </span>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-white/90">Prefer local? There’s a desktop app.</h3>
              <p className="text-white/50 text-sm leading-relaxed mt-1 max-w-2xl">
                The Windows app runs downloads, renders and AI on your own machine with your own keys — no upload waits, no server queues.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-white/45">
              <KeyRound size={15} className="text-violet-300/80" /> Bring your own API keys
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="max-w-5xl mx-auto px-5 sm:px-6 py-20 sm:py-28 scroll-mt-16">
        <div className="text-center mb-10">
          <Eyebrow>Pricing</Eyebrow>
          <H2>Beta pricing. Locked in.</H2>
          <p className="mt-4 text-white/50 max-w-md mx-auto text-base leading-relaxed">
            Every AI tool is on the free plan. Subscribe during the beta and keep these prices after launch.
          </p>
        </div>
        <Pricing />
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="border-t border-white/[0.05] py-20 sm:py-28 scroll-mt-16">
        <div className="max-w-3xl mx-auto px-5 sm:px-6">
          <div className="text-center mb-10 sm:mb-12">
            <Eyebrow>FAQ</Eyebrow>
            <H2>Questions, answered.</H2>
          </div>
          <div className="space-y-2.5">
            {FAQS.map(({ q, a }) => (
              <details key={q} className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] open:bg-white/[0.035] open:border-white/[0.12] transition-colors">
                <summary className="flex items-center justify-between gap-4 cursor-pointer list-none px-5 sm:px-6 py-4 sm:py-5 [&::-webkit-details-marker]:hidden">
                  <span className="font-semibold text-white/85 text-[15px]">{q}</span>
                  <ChevronDown size={18} className="text-white/35 flex-shrink-0 transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <p className="px-5 sm:px-6 pb-5 -mt-1 text-white/55 text-sm leading-relaxed">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="px-5 sm:px-6 pb-20 sm:pb-28">
        <div className="relative max-w-5xl mx-auto rounded-3xl border border-violet-500/25 bg-gradient-to-b from-violet-600/[0.16] to-violet-600/[0.03] px-6 py-14 sm:py-20 text-center overflow-hidden">
          <div className="absolute inset-x-0 -top-24 h-48 bg-violet-500/20 blur-[80px] pointer-events-none" />
          <div className="relative">
            <span className="w-12 h-12 rounded-2xl bg-violet-600/25 border border-violet-500/35 flex items-center justify-center mx-auto mb-6">
              <Zap size={20} className="text-violet-200 fill-violet-300" />
            </span>
            <H2 className="max-w-xl mx-auto">Your next viral clip is already in your last video.</H2>
            <p className="mt-4 text-white/55 text-base mb-8">Join the public beta — free to start, and beta prices are yours to keep.</p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 max-w-sm sm:max-w-none mx-auto">
              <PrimaryCta>Create free account <ArrowRight size={15} /></PrimaryCta>
              <Link href="/login" className="inline-flex items-center justify-center h-12 px-6 text-white/55 hover:text-white text-[15px] transition-colors">
                Sign in instead
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.05] py-10">
        <div className="max-w-6xl mx-auto px-5 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-5">
          <div className="flex items-center gap-2">
            <Wordmark height={16} mono className="text-white/35" />
            <span className="text-white/15 text-sm">·</span>
            <span className="text-[12px] text-white/25">© 2026</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-white/35">
            <a href="#editor" className="hover:text-white/70 transition-colors">Editor</a>
            <a href="#pricing" className="hover:text-white/70 transition-colors">Pricing</a>
            <Link href="/terms" className="hover:text-white/70 transition-colors">Terms</Link>
            <Link href="/privacy" className="hover:text-white/70 transition-colors">Privacy</Link>
            <Link href="/refunds" className="hover:text-white/70 transition-colors">Refunds</Link>
            <a href={`mailto:${LEGAL.contactEmail}`} className="hover:text-white/70 transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
