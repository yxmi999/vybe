"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Calendar,
  Users,
  PenSquare,
  BarChart2,
  MessageSquare,
  LogOut,
  ChevronDown,
  Film,
  Menu,
  X,
  ListTodo,
  Wand2,
  Sparkles,
  Settings,
  UserCog,
  MessageSquareHeart,
  Trophy,
  HandCoins,
} from "lucide-react";
import Worker from "@/components/icons/Worker";
import { Wordmark } from "@/components/brand/Wordmark";
import { useIsDesktop } from "@/lib/desktop-bridge";
import { BETA } from "@/lib/pricing";
import { LEGAL } from "@/lib/legal";
import { ThemeToggle } from "@/components/ThemeToggle";

// Nav grouped by what you're actually doing — the section labels (rendered as
// mono "cue" eyebrows) carry that meaning, so the labels aren't decoration.
const navGroups: { label: string | null; items: { href: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; soon?: boolean }[] }[] = [
  { label: null, items: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  ] },
  { label: "Make", items: [
    { href: "/compose", label: "Compose", icon: PenSquare },
    { href: "/clips", label: "Clips", icon: Film },
    { href: "/auto-clipper", label: "Auto-Clipper", icon: Wand2 },
  ] },
  { label: "Automate", items: [
    { href: "/auto-pilot", label: "Auto-Pilot", icon: Worker },
    { href: "/responses", label: "Auto-Respond", icon: MessageSquare },
  ] },
  { label: "Schedule", items: [
    { href: "/calendar", label: "Calendar", icon: Calendar },
    { href: "/todos", label: "To-Do", icon: ListTodo },
  ] },
  { label: "Measure", items: [
    { href: "/analytics", label: "Analytics", icon: BarChart2 },
    { href: "/accounts", label: "Accounts", icon: Users },
  ] },
];

// Web-only: both run on the hosted billing/analytics, not the local desktop DB.
const growGroup = { label: "Grow", items: [
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy, soon: true },
  { href: "/affiliate", label: "Earn", icon: HandCoins },
] };

type User = { name: string | null; email: string; plan: string | null };
type Usage = { plan: string; used: number; limit: number | null };

function Brand({ size = "base" }: { size?: "base" | "lg" }) {
  return (
    <span className="flex items-center gap-2">
      <Wordmark height={size === "lg" ? 30 : 24} className="text-white" />
      {BETA && (
        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-200 bg-violet-500/15 border border-violet-500/30 px-1.5 py-0.5 rounded-md leading-none">
          Beta
        </span>
      )}
    </span>
  );
}

// Beta feedback goes straight to the inbox, tagged with the page it came from.
function feedbackHref(path: string) {
  const subject = encodeURIComponent("Vybe beta feedback");
  const body = encodeURIComponent(`Page: ${path}

What happened / what would make Vybe better:

`);
  return `mailto:${LEGAL.contactEmail}?subject=${subject}&body=${body}`;
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);   // user dropdown
  const [drawerOpen, setDrawerOpen] = useState(false); // mobile nav drawer
  // Desktop app: adds Settings (API keys); no billing or sign-out (single local user).
  const isDesktop = useIsDesktop();
  const groups = isDesktop
    ? [...navGroups, { label: "App", items: [{ href: "/settings", label: "Settings", icon: Settings }] }]
    : [...navGroups, growGroup];

  useEffect(() => {
    // A 401/404 here can mean the cookie's JWT is valid but its user no longer
    // exists (orphaned token). The proxy treats that token as authed and would
    // bounce /login back to /dashboard, so we must clear the cookie via logout
    // BEFORE redirecting — otherwise we loop.
    async function bailToLogin() {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      router.push("/login");
    }
    fetch("/api/auth/me")
      .then((r) => {
        if (r.status === 401 || r.status === 404) { bailToLogin(); return null; }
        return r.json();
      })
      .then((d) => { if (d?.email) setUser(d); })
      .catch(() => bailToLogin());
  }, [router]);

  // Monthly clip usage — only shown when the plan has a finite limit.
  useEffect(() => {
    fetch("/api/clips/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.used === "number") setUsage(d); })
      .catch(() => {});
  }, [pathname]);

  // Close the mobile drawer whenever the route changes (adjust state during
  // render — the recommended pattern over a setState-in-effect).
  const [prevPath, setPrevPath] = useState(pathname);
  if (pathname !== prevPath) {
    setPrevPath(pathname);
    setDrawerOpen(false);
  }

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [drawerOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const navLinks = (
    <nav className="flex-1 px-3 py-4 overflow-y-auto">
      {groups.map((group, gi) => (
        <div key={gi} className={cn(gi > 0 && "mt-5")}>
          {group.label && (
            <p className="cue text-white/25 px-3 mb-1.5">{group.label}</p>
          )}
          <div className="space-y-0.5">
            {group.items.map(({ href, label, icon: Icon, ...item }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setDrawerOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    active
                      ? "bg-violet-600/[0.12] text-white"
                      : "text-white/45 hover:bg-white/[0.04] hover:text-white/90"
                  )}
                >
                  <span className={cn(
                    "absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full bg-violet-500 transition-all duration-200",
                    active ? "h-5 opacity-100" : "h-0 opacity-0"
                  )} />
                  <Icon size={17} className={cn("transition-colors", active ? "text-violet-400" : "text-white/35 group-hover:text-white/70")} />
                  {label}
                  {"soon" in item && item.soon && (
                    <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-white/40 bg-white/[0.05] border border-white/[0.08] px-1.5 py-0.5 rounded leading-none">
                      Soon
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  // Persistent clip-usage meter — pulled out of the account dropdown so you can
  // always see where you stand against the monthly cap. Links to billing.
  const usageMeter = usage && usage.limit != null && (() => {
    const pct = Math.min(100, Math.round((usage.used / usage.limit!) * 100));
    const nearCap = usage.used >= usage.limit!;
    return (
      <Link href={isDesktop ? "/settings" : "/billing"} className="block mx-3 mb-1 px-3 py-2.5 rounded-lg hover:bg-white/[0.04] transition-colors">
        <div className="flex items-center justify-between mb-1.5">
          <span className="cue text-white/30">Clips this month</span>
          <span className={cn("text-[11px] font-semibold tabular-nums", nearCap ? "text-violet-400" : "text-white/55")}>
            {usage.used}<span className="text-white/25">/{usage.limit}</span>
          </span>
        </div>
        <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", nearCap ? "bg-violet-500" : "bg-violet-500/70")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </Link>
    );
  })();

  const betaCard = BETA && (
    <a href={feedbackHref(pathname)}
      className="group flex items-center gap-3 mx-3 mb-2 px-3 py-2.5 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] hover:bg-violet-500/[0.1] hover:border-violet-500/35 transition-colors">
      <MessageSquareHeart size={16} className="text-violet-300 flex-shrink-0" />
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-white/85">You’re on the beta</span>
        <span className="block text-[11px] text-white/45 group-hover:text-white/60">Found a bug or have an idea? Tell us</span>
      </span>
    </a>
  );

  const userMenu = (
    <div className="border-t border-white/[0.06] p-3 pt-2">
      {betaCard}
      {usageMeter}
      {user ? (
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.05] transition-colors"
          >
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {(user.name ?? user.email)[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-sm font-medium text-white truncate">{user.name ?? user.email.split("@")[0]}</p>
              <p className="text-xs text-white/40 truncate capitalize">{isDesktop ? "Desktop app" : `${user.plan ?? "free"} plan`}</p>
            </div>
            <ChevronDown size={14} className={cn("text-white/30 flex-shrink-0 transition-transform", menuOpen && "rotate-180")} />
          </button>

          {menuOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-d14 border border-white/[0.09] rounded-xl overflow-hidden shadow-2xl">
              <div className="px-4 py-3 border-b border-white/[0.06]">
                <p className="text-xs text-white/40 truncate">{user.email}</p>
              </div>
              <Link
                href={isDesktop ? "/settings" : "/billing"}
                onClick={() => setMenuOpen(false)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-white/70 hover:bg-white/[0.04] transition-colors"
              >
                {isDesktop ? <Settings size={15} className="text-violet-400" /> : <Sparkles size={15} className="text-violet-400" />}
                {isDesktop ? "Settings & API keys" : (user.plan ?? "free") === "free" ? "Upgrade plan" : "Plans & billing"}
              </Link>
              <Link
                href="/account"
                onClick={() => setMenuOpen(false)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-white/70 hover:bg-white/[0.04] transition-colors border-t border-white/[0.06]"
              >
                <UserCog size={15} className="text-white/45" />
                Account &amp; data
              </Link>
              <ThemeToggle className="border-t border-white/[0.06]" />
              {!isDesktop && <button
                onClick={logout}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-red-400 hover:bg-white/[0.04] transition-colors border-t border-white/[0.06]"
              >
                <LogOut size={15} />
                Sign out
              </button>}
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-white/25">Loading...</div>
      )}
    </div>
  );

  return (
    <>
      {/* ── Desktop sidebar ───────────────────────────────────────────── */}
      <aside className="hidden md:flex w-60 min-h-screen bg-d0c text-white flex-col border-r border-white/[0.06]">
        <div className="px-6 py-5 border-b border-white/[0.06]">
          <Brand />
        </div>
        {navLinks}
        {userMenu}
      </aside>

      {/* ── Mobile top bar ────────────────────────────────────────────── */}
      <header className="md:hidden fixed top-0 inset-x-0 z-40 h-14 flex items-center gap-3 px-4
        bg-d0c/95 backdrop-blur border-b border-white/[0.06] text-white">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="p-2 -ml-2 rounded-lg text-white/60 hover:bg-white/[0.06] active:bg-white/[0.06] transition-colors"
        >
          <Menu size={22} />
        </button>
        <Link href="/dashboard">
          <Brand />
        </Link>
      </header>

      {/* ── Mobile drawer ─────────────────────────────────────────────── */}
      {/* Backdrop */}
      <div
        onClick={() => setDrawerOpen(false)}
        className={cn(
          "md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200",
          drawerOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
      />
      {/* Panel */}
      <aside
        className={cn(
          "md:hidden fixed top-0 left-0 z-50 h-full w-[78%] max-w-xs bg-d0c text-white",
          "flex flex-col border-r border-white/[0.06] shadow-2xl transition-transform duration-200 ease-out",
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="px-5 py-5 flex items-center justify-between border-b border-white/[0.06]">
          <Brand />
          <button
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="p-2 -mr-2 rounded-lg text-white/40 hover:bg-white/[0.06] transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        {navLinks}
        {userMenu}
      </aside>
    </>
  );
}
