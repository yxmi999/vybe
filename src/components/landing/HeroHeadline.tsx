"use client";
// Hero headline: "Your [stream's] best / [moments], posted."
// Line two flips through moments that fit the CURRENT kind of content (a
// podcast has hot takes, not clutches); after a full cycle line one advances.
//
// Each rotating slot holds every word it can show, measures them, and animates
// its own width to the current word — short words don't leave a gap, long
// ones never overflow — while the outgoing word lifts away and the incoming
// one rises in. Words are addressed by text, so switching lists is just
// another step of the same animation.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const CONTENT: { noun: string; moments: string[] }[] = [
  { noun: "stream’s", moments: ["moments", "clutches", "reactions", "fails"] },
  { noun: "podcast’s", moments: ["moments", "hot takes", "quotes", "laughs"] },
  { noun: "video’s", moments: ["moments", "hooks", "highlights", "scenes"] },
  { noun: "vlog’s", moments: ["moments", "adventures", "laughs", "reactions"] },
];
const PER = CONTENT[0].moments.length;
const NOUNS = CONTENT.map((c) => c.noun);
const ALL_MOMENTS = [...new Set(CONTENT.flatMap((c) => c.moments))];
const BEAT_MS = 2200;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

// useLayoutEffect warns during SSR; this page is server-rendered.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function at(n: number) {
  const m = ((n % (PER * CONTENT.length)) + PER * CONTENT.length) % (PER * CONTENT.length);
  const c = CONTENT[Math.floor(m / PER)];
  return { noun: c.noun, moment: c.moments[m % PER] };
}

function Rotator({ words, current, previous, className }: { words: string[]; current: string; previous: string | null; className: string }) {
  const refs = useRef<Record<string, HTMLSpanElement | null>>({});
  const [widths, setWidths] = useState<Record<string, number>>({});

  const measure = useCallback(() => {
    const next: Record<string, number> = {};
    for (const w of words) next[w] = refs.current[w]?.getBoundingClientRect().width ?? 0;
    setWidths(next);
  }, [words]);

  useIsoLayoutEffect(() => {
    measure();
    // Display fonts load after first paint and change every width.
    document.fonts?.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const width = widths[current];
  return (
    <span
      className="relative inline-block align-bottom text-left"
      style={{ width: width ? `${width}px` : undefined, transition: width ? `width 650ms ${EASE}` : undefined }}
    >
      {/* Invisible copy of the current word: gives the slot its height (and its
          width before measuring, e.g. during SSR). */}
      <span className={`invisible whitespace-nowrap ${className}`}>{current}</span>
      {words.map((w) => {
        const state = w === current ? "in" : w === previous ? "out" : "wait";
        return (
          <span key={w} ref={(el) => { refs.current[w] = el; }}
            className={`absolute left-0 bottom-0 whitespace-nowrap ${className}`}
            style={{
              opacity: state === "in" ? 1 : 0,
              filter: state === "in" ? "blur(0)" : "blur(8px)",
              transform: state === "in" ? "translateY(0)" : state === "out" ? "translateY(-0.45em)" : "translateY(0.45em)",
              // Waiting words jump back below instantly (they're invisible).
              transition: state === "wait" ? "none" : `opacity 550ms ${EASE}, transform 650ms ${EASE}, filter 550ms ${EASE}`,
            }}>
            {w}
          </span>
        );
      })}
    </span>
  );
}

export default function HeroHeadline() {
  const [n, setN] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setN((v) => v + 1), BEAT_MS);
    return () => clearInterval(t);
  }, []);

  const now = at(n);
  const before = n > 0 ? at(n - 1) : null;

  return (
    // Fixed line structure so the headline NEVER re-wraps as words change:
    // phones stack every part on its own line; sm+ is exactly two nowrap lines.
    // .hero-title (globals.css) scales the font so the widest combination fits.
    <h1 className="hero-title font-display leading-[1.04] font-extrabold tracking-tight mb-6">
      <span className="sr-only">Your stream’s, podcast’s or video’s best moments, posted.</span>
      <span aria-hidden className="block sm:whitespace-nowrap">
        <span className="hero-blur-in block sm:inline-block sm:mr-[0.22em] bg-gradient-to-b from-white to-white/65 bg-clip-text text-transparent" style={{ animationDelay: "0.08s" }}>
          Your
        </span>
        <span className="hero-blur-in block sm:inline-block sm:mr-[0.22em]" style={{ animationDelay: "0.2s" }}>
          <Rotator words={NOUNS} current={now.noun} previous={before && before.noun !== now.noun ? before.noun : null}
            className="hero-shimmer bg-clip-text text-transparent" />
        </span>
        <span className="hero-blur-in block sm:inline-block bg-gradient-to-b from-white to-white/65 bg-clip-text text-transparent" style={{ animationDelay: "0.32s" }}>
          best
        </span>
      </span>
      <span aria-hidden className="hero-blur-in block sm:whitespace-nowrap" style={{ animationDelay: "0.46s" }}>
        <span className="whitespace-nowrap">
          <Rotator words={ALL_MOMENTS} current={now.moment} previous={before && before.moment !== now.moment ? before.moment : null}
            className="hero-shimmer bg-clip-text text-transparent" />
          <span className="bg-gradient-to-b from-white to-white/65 bg-clip-text text-transparent">,</span>
        </span>
        <span className="block sm:inline bg-gradient-to-b from-white to-white/65 bg-clip-text text-transparent">
          <span className="hidden sm:inline"> </span>posted.
        </span>
      </span>
    </h1>
  );
}
