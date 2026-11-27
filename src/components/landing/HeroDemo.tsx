"use client";
// Landing hero visual — one object, one idea: a wide 16:9 video reshapes itself
// into a vertical short. Each loop is a different kind of long content (stream,
// podcast, video) and comes out in a different editing style, then it widens
// back out for the next one. Pure CSS transitions + a single interval.
import { useEffect, useRef, useState } from "react";

type Scene = "game" | "podcast" | "vlog";
type Layout = "split" | "bubble" | "stack" | "none";
type CaptionStyle = "karaoke" | "pop" | "box" | "cinema";

type Source = {
  badge: string; live?: boolean; kind: string; dot: string; glow: string; tint: string;
  scene: Scene; style: string; layout: Layout; captions: CaptionStyle; grade: string;
  line: string[]; hook?: string; emoji?: string;
  /** Optional real 16:9 footage (public/landing/…). Falls back to the drawn scene if missing or blocked. */
  video?: string; poster?: string;
  /** Where the subject is horizontally (0-100) — the 9:16 reframe pans here. */
  focusX?: number;
};

const SOURCES: Source[] = [
  {
    badge: "Twitch", live: true, kind: "Twitch stream", dot: "bg-purple-400", glow: "bg-purple-600/25", tint: "#2a1d4a",
    scene: "game", style: "Streamer Hype", layout: "split", captions: "karaoke", grade: "saturate(1.45) contrast(1.08)",
    line: ["NO", "WAY", "HE", "HIT", "THAT"],
  },
  {
    badge: "Podcast · 2h 14m", kind: "podcast episode", dot: "bg-orange-400", glow: "bg-orange-500/20", tint: "#3a2618",
    scene: "podcast", style: "Podcast Clip", layout: "stack", captions: "box", grade: "contrast(1.05)",
    line: ["Nobody", "talks", "about", "this", "part"], hook: "The #1 money mistake",
  },
  {
    badge: "Kick", live: true, kind: "Kick stream", dot: "bg-green-400", glow: "bg-green-600/20", tint: "#0f3a2a",
    scene: "game", style: "One-word pop", layout: "bubble", captions: "pop", grade: "contrast(1.12)",
    line: ["CHAT", "IS", "GOING", "CRAZY"], emoji: "🤯",
  },
  {
    badge: "YouTube · 38:20", kind: "YouTube video", dot: "bg-red-400", glow: "bg-amber-500/20", tint: "#1d3a5c",
    scene: "vlog", style: "Cinematic", layout: "none", captions: "cinema", grade: "sepia(0.3) saturate(1.2) brightness(0.96)",
    line: ["and", "then", "it", "all", "changed"],
  },
];

// Streamer facecam box per short layout (wide frames keep it in the corner).
const CAM: Partial<Record<Layout, string>> = {
  split:  "left-0 top-0 w-full h-[38%] rounded-none border-b border-white/20",
  bubble: "left-[7%] top-[5%] w-[36%] h-[20%] rounded-full border-2 border-white/80 shadow-[0_6px_20px_rgba(0,0,0,0.5)]",
};
const AIM: Partial<Record<Layout, string>> = { split: "top-[62%]", bubble: "top-[48%]" };

// Per source: WIDE_MS of the 16:9 video, then the reframe (MORPH_MS) into a
// vertical short that plays for SHORT_MS with captions timed to the words.
const WIDE_MS = 1900;
const MORPH_MS = 900;
const SHORT_MS = 4300;
const CYCLE_MS = WIDE_MS + SHORT_MS;
const CAPTION_START_MS = WIDE_MS + MORPH_MS + 150;
const STEP_MS = 50;
const EASE = "cubic-bezier(0.65,0,0.2,1)";

/** Start time (ms into the cycle) of each caption word — longer words stay up longer, like speech. */
function wordTimes(line: string[]): number[] {
  const weights = line.map((w) => 0.7 + Math.min(w.length, 9) * 0.12);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = CYCLE_MS - CAPTION_START_MS - 700; // leave the last word up a beat
  let acc = CAPTION_START_MS;
  return weights.map((w) => { const t = acc; acc += (w / total) * span; return t; });
}

export default function HeroDemo() {
  const [clock, setClock] = useState(0); // ms since the loop started, in STEP_MS steps
  const [videoOk, setVideoOk] = useState<Record<string, boolean>>({});
  const [tilt, setTilt] = useState<{ x: number; y: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const r = setTimeout(() => setClock(CYCLE_MS - 300), 0); // static: show the finished short
      return () => clearTimeout(r);
    }
    // Wall-clock based (not "+1 per tick") so a throttled background tab
    // catches up instead of drifting. Pauses while scrolled out of view.
    let start = performance.now();
    let pausedAt: number | null = null;
    const t = setInterval(() => {
      if (pausedAt !== null) return;
      setClock(Math.floor((performance.now() - start) / STEP_MS) * STEP_MS);
    }, STEP_MS);
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting && pausedAt === null) pausedAt = performance.now();
      else if (e.isIntersecting && pausedAt !== null) { start += performance.now() - pausedAt; pausedAt = null; }
    });
    if (frameRef.current) io.observe(frameRef.current);
    return () => { clearInterval(t); io.disconnect(); };
  }, []);

  function onTilt(e: React.PointerEvent) {
    if (e.pointerType !== "mouse" || !frameRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = frameRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = ((e.clientY - r.top) / r.height) * 2 - 1;
    setTilt({ x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) });
  }

  const srcIndex = Math.floor(clock / CYCLE_MS) % SOURCES.length;
  const src = SOURCES[srcIndex];
  const t = clock % CYCLE_MS;
  const short = t >= WIDE_MS;
  // Captions begin once the reframe has settled, each word for as long as it'd take to say.
  const times = wordTimes(src.line);
  const word = short ? times.reduce((acc, at, i) => (t >= at ? i : acc), -1) : -1;
  const hookOn = short && t >= WIDE_MS + MORPH_MS;
  const useVideo = !!src.video && videoOk[src.video] !== false;
  // "One-word pop" punches in on every other word.
  const punch = short && src.captions === "pop" && word >= 0 && word % 2 === 0;
  const grade = short ? src.grade : "none";

  return (
    <div className="hero-blur-in [animation-delay:0.9s] relative mx-auto flex flex-col items-center">
      {/* Tinted glow — one pre-blurred layer per source, crossfaded */}
      {SOURCES.map((s, i) => (
        <div key={s.kind} aria-hidden
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80%] h-[70%] rounded-full blur-[100px] -z-10 transition-opacity duration-700 ${s.glow}`}
          style={{ opacity: i === srcIndex ? 1 : 0 }} />
      ))}

      {/* Fixed-height stage so the page never jumps while the frame reshapes */}
      <div className="hero-float flex items-center justify-center h-[356px] sm:h-[420px] lg:h-[440px] [perspective:1100px]"
        onPointerMove={onTilt} onPointerLeave={() => setTilt(null)}>
        <div ref={frameRef}
          className={`relative overflow-hidden bg-black border shadow-[0_40px_120px_rgba(0,0,0,0.75)]
            ${short
              ? "w-[200px] h-[356px] sm:w-[236px] sm:h-[420px] lg:w-[248px] lg:h-[440px] rounded-[2rem] border-white/[0.16] p-[7px]"
              : "w-[320px] h-[180px] sm:w-[600px] sm:h-[338px] lg:w-[720px] lg:h-[405px] rounded-2xl border-white/[0.1] p-0"}`}
          style={{
            transform: tilt ? `rotateX(${(-tilt.y * 8).toFixed(2)}deg) rotateY(${(tilt.x * 12).toFixed(2)}deg)` : "none",
            transition: [
              `width 900ms ${EASE}`, `height 900ms ${EASE}`, `padding 900ms ${EASE}`, `border-radius 900ms ${EASE}`,
              "border-color 900ms ease",
              tilt ? "transform 80ms linear" : "transform 700ms cubic-bezier(0.22,1,0.36,1)",
            ].join(", "),
          }}>
          <div className={`relative w-full h-full overflow-hidden transition-[border-radius] duration-[900ms] ${short ? "rounded-[1.55rem]" : "rounded-2xl"}`}>
            {/* Scene — graded + punched-in per style */}
            <div className="absolute inset-0"
              style={{
                filter: grade,
                transform: punch ? "scale(1.14)" : "scale(1)",
                transition: "filter 700ms ease, transform 220ms cubic-bezier(0.2,1.4,0.4,1)",
              }}>
              {useVideo ? (
                <video key={src.video} src={src.video} poster={src.poster} autoPlay muted loop playsInline preload="auto"
                  onError={() => setVideoOk((m) => ({ ...m, [src.video!]: false }))}
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{
                    objectPosition: `${short ? src.focusX ?? 50 : 50}% 50%`,
                    transition: `object-position ${MORPH_MS}ms ${EASE}`,
                  }} />
              ) : (
                <>
                  {src.scene === "game" && <GameScene tint={src.tint} aim={short ? AIM[src.layout] ?? "top-1/2" : "top-1/2"} />}
                  {src.scene === "podcast" && <PodcastScene tint={src.tint} short={short} />}
                  {src.scene === "vlog" && <VlogScene tint={src.tint} />}
                </>
              )}
            </div>

            {/* Streamer facecam — corner overlay when wide, style-specific when vertical */}
            {src.scene === "game" && !useVideo && (
              <div className={`absolute overflow-hidden bg-gradient-to-br from-[#2b2140] via-[#1c2238] to-[#13182a]
                transition-all duration-[900ms] ease-[cubic-bezier(0.65,0,0.2,1)]
                ${short ? CAM[src.layout] : "left-[76%] top-[64%] w-[21%] h-[30%] rounded-lg border border-white/20"}`}
                style={{ filter: grade }}>
                <Person className="left-1/2 top-[60%] h-[62%]" />
              </div>
            )}

            {/* Cinematic letterbox */}
            <div className={`absolute inset-x-0 top-0 bg-black transition-all duration-700 ${short && src.layout === "none" ? "h-[11%]" : "h-0"}`} />
            <div className={`absolute inset-x-0 bottom-0 bg-black transition-all duration-700 ${short && src.layout === "none" ? "h-[11%]" : "h-0"}`} />

            {/* Source badge (wide) */}
            <div className={`absolute left-3 top-3 flex items-center gap-1.5 text-[11px] font-semibold text-white/85 bg-black/55 backdrop-blur rounded-full px-2.5 py-1 transition-all duration-500 ${short ? "opacity-0 -translate-y-2" : "opacity-100"}`}>
              {src.live && <span className="text-[9px] font-bold text-white bg-red-500 rounded px-1">LIVE</span>}
              <span className={`w-1.5 h-1.5 rounded-full ${src.dot}`} />
              {src.badge}
            </div>

            {/* Hook title */}
            {src.hook && (
              <div className={`absolute inset-x-0 top-[50%] -translate-y-1/2 flex justify-center transition-all duration-300 ${hookOn ? "opacity-100 scale-100" : "opacity-0 scale-90"}`}>
                <span className="[font-family:'Vybe_Bold',sans-serif] text-[14px] sm:text-[16px] text-black bg-[#FFE000] px-2.5 py-1 rounded-md -rotate-2 shadow-lg whitespace-nowrap">
                  {src.hook}
                </span>
              </div>
            )}

            {/* Captions — one look per style */}
            {short && <Captions key={src.kind} style={src.captions} line={src.line} word={word} emoji={src.emoji} />}

            {/* Player progress — fills across the short's runtime (transform = composited) */}
            <div className={`absolute inset-x-0 bottom-0 h-[3px] bg-white/15 transition-opacity duration-500 ${short ? "opacity-100" : "opacity-0"}`}>
              <div className="h-full w-full origin-left bg-white/85"
                style={{
                  transform: `scaleX(${short ? Math.min(1, (t - WIDE_MS) / SHORT_MS) : 0})`,
                  // The clock steps every STEP_MS; a matching linear transition makes it continuous.
                  transition: short ? `transform ${STEP_MS + 30}ms linear` : "none",
                }} />
            </div>

            {/* Glare */}
            <div className="absolute inset-0 pointer-events-none transition-opacity duration-300"
              style={{
                opacity: tilt ? 1 : 0.35,
                background: `radial-gradient(circle at ${tilt ? 50 + tilt.x * 40 : 25}% ${tilt ? 50 + tilt.y * 40 : 15}%, rgba(255,255,255,0.14), transparent 55%)`,
              }} />
          </div>
        </div>
      </div>

      {/* One-line caption under the frame */}
      <p className="mt-6 h-5 flex items-center gap-2 text-[13px] font-mono text-white/45">
        <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${short ? "bg-violet-400" : src.dot}`} />
        <span key={`${src.kind}-${short}`} className="hero-blur-in">
          {short ? <>9:16 · <span className="text-white/75">{src.style}</span> style</> : `16:9 · ${src.kind}`}
        </span>
      </p>
    </div>
  );
}

// ─── Scene pieces ─────────────────────────────────────────────────────────────

/** Head-and-shoulders silhouette; `className` positions its center and sets height. */
function Person({ className, shirt = "#3a4a8a", style }: { className: string; shirt?: string; style?: React.CSSProperties }) {
  return (
    <div className={`absolute -translate-x-1/2 -translate-y-1/2 aspect-[1/1.15] ${className}`} style={style}>
      <div className="absolute left-1/2 top-0 -translate-x-1/2 w-[52%] aspect-square rounded-full bg-gradient-to-b from-[#e8b894] to-[#b98466]" />
      <div className="absolute left-1/2 bottom-0 -translate-x-1/2 w-full h-[46%] rounded-t-[50%]" style={{ background: shirt }} />
    </div>
  );
}

function GameScene({ tint, aim }: { tint: string; aim: string }) {
  return (
    <>
      <div className="absolute inset-0 transition-[background] duration-700"
        style={{ background: `linear-gradient(160deg, ${tint} 0%, #10182c 55%, #0b0f1c 100%)` }} />
      <div className="absolute inset-x-0 bottom-0 h-[70%] opacity-35"
        style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.08) 1px,transparent 1px)", backgroundSize: "28px 28px", transform: "perspective(260px) rotateX(55deg) scale(1.8)", transformOrigin: "bottom" }} />
      <div className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 transition-[top] duration-[900ms] ${aim}`}>
        <div className="absolute inset-x-0 top-1/2 h-px bg-white/80" />
        <div className="absolute inset-y-0 left-1/2 w-px bg-white/80" />
      </div>
    </>
  );
}

/** Two hosts side by side; in the short they restack top / bottom. */
function PodcastScene({ tint, short }: { tint: string; short: boolean }) {
  const move = { transition: `left 900ms ${EASE}, top 900ms ${EASE}, height 900ms ${EASE}` };
  return (
    <>
      <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse at 50% 30%, ${tint} 0%, #1a120c 70%)` }} />
      {/* studio lights */}
      <div className="absolute left-[18%] top-[8%] w-[10%] aspect-square rounded-full bg-amber-200/20 blur-md" />
      <div className="absolute right-[18%] top-[8%] w-[10%] aspect-square rounded-full bg-amber-200/20 blur-md" />
      {/* divider between stacked hosts */}
      <div className={`absolute inset-x-0 top-1/2 h-px bg-white/25 transition-opacity duration-500 ${short ? "opacity-100" : "opacity-0"}`} />
      <Person shirt="#6b3f2a" className="" style={{ ...move, left: short ? "50%" : "30%", top: short ? "27%" : "58%", height: short ? "34%" : "58%" }} />
      <Person shirt="#2f4a3a" className="" style={{ ...move, left: short ? "50%" : "70%", top: short ? "77%" : "58%", height: short ? "34%" : "58%" }} />
      {/* mics (wide only) */}
      {[30, 70].map((x) => (
        <div key={x} className={`absolute bottom-[8%] w-[3%] h-[22%] -translate-x-1/2 transition-opacity duration-300 ${short ? "opacity-0" : "opacity-100"}`} style={{ left: `${x + 9}%` }}>
          <div className="w-full aspect-[1/1.6] rounded-full bg-zinc-700 border border-white/10" />
          <div className="mx-auto w-[30%] h-full bg-zinc-800" />
        </div>
      ))}
    </>
  );
}

function VlogScene({ tint }: { tint: string }) {
  return (
    <>
      <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, ${tint} 0%, #e7976a 62%, #3a2a2a 62%, #1d1714 100%)` }} />
      <div className="absolute left-1/2 top-[50%] -translate-x-1/2 -translate-y-1/2 w-[14%] aspect-square rounded-full bg-amber-200/80 blur-[2px]" />
      <div className="absolute inset-x-0 top-[55%] h-[10%] opacity-60" style={{ background: "linear-gradient(90deg, transparent, #2a1f2a 20%, #2a1f2a 35%, transparent 45%, #2a1f2a 60%, transparent 80%)" }} />
      <Person shirt="#22303f" className="left-1/2 top-[66%] h-[64%]" />
    </>
  );
}

// ─── Captions ─────────────────────────────────────────────────────────────────

function Captions({ style, line, word, emoji }: { style: CaptionStyle; line: string[]; word: number; emoji?: string }) {
  if (style === "pop") {
    if (word < 0) return null;
    return (
      <div className="absolute inset-x-0 top-[66%] -translate-y-1/2 flex justify-center">
        <span key={word}
          className="hero-pop [font-family:'Vybe_Round',sans-serif] text-[40px] sm:text-[46px] leading-none text-[#34C759] [paint-order:stroke_fill] [-webkit-text-stroke:7px_#000] drop-shadow-[0_4px_0_rgba(0,0,0,0.6)]">
          {line[word]}{word === line.length - 1 && emoji ? <span className="[-webkit-text-stroke:0] ml-1">{emoji}</span> : null}
        </span>
      </div>
    );
  }

  if (style === "box") {
    return (
      <div className="absolute inset-x-4 top-[88%] -translate-y-1/2 text-center leading-[1.5]">
        <span className="[box-decoration-break:clone] bg-black/80 rounded-md px-2 py-0.5 [font-family:'Vybe_Sans',sans-serif] text-[14px] sm:text-[15px] text-white">
          {line.map((w, i) => (
            <span key={i} className={`transition-opacity duration-150 ${i > word ? "opacity-0" : "opacity-100"}`}>{w}{i < line.length - 1 ? " " : ""}</span>
          ))}
        </span>
      </div>
    );
  }

  if (style === "cinema") {
    return (
      <div className="absolute inset-x-4 top-[80%] -translate-y-1/2 text-center">
        <p className="[font-family:'Vybe_Serif',serif] italic text-[18px] sm:text-[20px] text-white/95 [text-shadow:0_2px_12px_rgba(0,0,0,0.8)] tracking-wide">
          {line.map((w, i) => (
            <span key={i} className={`inline-block mx-[2px] transition-all duration-500 ${i > word ? "opacity-0 blur-sm translate-y-1" : "opacity-100 blur-0"}`}>{w}</span>
          ))}
        </p>
      </div>
    );
  }

  // karaoke
  return (
    <div className="absolute inset-x-3 top-[70%] text-center leading-[1.05]">
      {line.map((w, i) => (
        <span key={i}
          className={`inline-block mx-[3px] [font-family:'Vybe_Impact',sans-serif] text-[24px] sm:text-[27px] [paint-order:stroke_fill] [-webkit-text-stroke:5px_#000]
            transition-all duration-200 ease-out ${
            i > word ? "opacity-0 scale-50" : i === word ? "opacity-100 scale-110 text-[#FFE000]" : "opacity-100 scale-100 text-white"
          }`}>
          {w}
        </span>
      ))}
    </div>
  );
}
