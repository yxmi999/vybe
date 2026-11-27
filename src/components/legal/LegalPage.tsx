// Shared shell for the legal pages (privacy, terms, refunds): header, a
// jump-to table of contents, and consistent typography. Server component.
import Link from "next/link";
import { Wordmark } from "@/components/brand/Wordmark";

import { LEGAL } from "@/lib/legal";
export { LEGAL };

export type LegalSection = { id: string; title: string; body: React.ReactNode };

export function LegalPage({ title, intro, sections }: { title: string; intro: React.ReactNode; sections: LegalSection[] }) {
  return (
    <div className="min-h-screen bg-d0a text-white">
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-d0a/85 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-5 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/" aria-label="Vybe home"><Wordmark height={20} className="text-white" /></Link>
          <nav className="flex items-center gap-4 sm:gap-6 text-[13px] text-white/50">
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/refunds" className="hover:text-white transition-colors">Refunds</Link>
          </nav>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-5 sm:px-6 py-12 sm:py-16 lg:grid lg:grid-cols-[220px_1fr] lg:gap-14">
        {/* Table of contents */}
        <aside className="hidden lg:block">
          <nav className="sticky top-24 space-y-1 text-[13px]">
            <p className="cue text-white/30 mb-3">On this page</p>
            {sections.map((s, i) => (
              <a key={s.id} href={`#${s.id}`} className="block py-1 text-white/45 hover:text-white transition-colors leading-snug">
                {i + 1}. {s.title}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <p className="cue text-violet-400/80 mb-3">Legal</p>
          <h1 className="font-display text-4xl sm:text-5xl font-extrabold tracking-tight text-white mb-3">{title}</h1>
          <p className="text-white/35 text-sm mb-8">Last updated: {LEGAL.lastUpdated}</p>
          <div className="text-[15px] text-white/65 leading-relaxed mb-10 space-y-3">{intro}</div>

          <div className="space-y-10">
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-24">
                <h2 className="text-lg font-semibold text-white/90 mb-3">{i + 1}. {s.title}</h2>
                <div className="legal-body text-[15px] text-white/60 leading-relaxed space-y-3">{s.body}</div>
              </section>
            ))}
          </div>

          <div className="mt-16 pt-8 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-4 text-xs text-white/30">
            <span>© 2026 {LEGAL.operator}</span>
            <span>
              Questions? <a href={`mailto:${LEGAL.contactEmail}`} className="text-violet-300/80 hover:text-violet-200">{LEGAL.contactEmail}</a>
            </span>
          </div>
        </main>
      </div>
    </div>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="text-violet-400 mt-0.5 flex-shrink-0">•</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Strong({ children }: { children: React.ReactNode }) {
  return <span className="text-white/85 font-medium">{children}</span>;
}

export function A({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="text-violet-300/90 hover:text-violet-200 underline underline-offset-2 decoration-violet-400/40">
      {children}
    </a>
  );
}
