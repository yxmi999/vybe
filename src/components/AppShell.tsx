"use client";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import VerifyEmailBanner from "./VerifyEmailBanner";

// Standalone pages (no sidebar). Public legal pages must also be listed in
// PUBLIC_PREFIXES in src/proxy.ts.
const AUTH_PAGES = ["/login", "/register", "/", "/privacy", "/terms", "/refunds", "/affiliate-terms", "/pay"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuthPage = AUTH_PAGES.includes(pathname);

  // Landing / auth / legal pages are designed dark — they stay dark in light mode.
  if (isAuthPage) return <div className="keep-dark contents">{children}</div>;

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      {/* pt-14 on mobile clears the fixed top bar; min-w-0 lets children shrink instead of overflowing */}
      <main className="flex-1 min-w-0 overflow-auto pt-14 md:pt-0">
        <VerifyEmailBanner />
        {children}
      </main>
    </div>
  );
}
