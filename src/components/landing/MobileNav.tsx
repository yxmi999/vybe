"use client";
// Landing-page menu for phones: a full-width sheet under the sticky header.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X, ArrowRight } from "lucide-react";

const LINKS = [
  { href: "#workflow", label: "How it works" },
  { href: "#editor", label: "Editor" },
  { href: "#clipper", label: "Auto-Clipper" },
  { href: "#automation", label: "Automation" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export default function MobileNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = ""; window.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="md:hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open}
        className="w-10 h-10 -mr-2 flex items-center justify-center rounded-lg text-white/70 active:bg-white/[0.08]">
        {open ? <X size={22} /> : <Menu size={22} />}
      </button>

      <div className={`fixed inset-x-0 top-14 bottom-0 z-50 bg-d0a/98 backdrop-blur-xl transition-all duration-200 ${
        open ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2 pointer-events-none"
      }`}>
        <nav className="flex flex-col px-5 pt-4 pb-8 h-full overflow-y-auto">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)}
              className="flex items-center justify-between py-4 border-b border-white/[0.06] text-[17px] font-medium text-white/80 active:text-white">
              {l.label}
              <ArrowRight size={16} className="text-white/25" />
            </a>
          ))}
          <div className="mt-auto pt-8 grid gap-3">
            <Link href="/register" onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-2 h-12 rounded-xl bg-violet-600 text-white font-semibold">
              Start free <ArrowRight size={16} />
            </Link>
            <Link href="/login" onClick={() => setOpen(false)}
              className="flex items-center justify-center h-12 rounded-xl border border-white/10 text-white/75 font-medium">
              Sign in
            </Link>
          </div>
        </nav>
      </div>
    </div>
  );
}
