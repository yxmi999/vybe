"use client";
import { useEffect, useRef, useState } from "react";
import {
  Wand2, Sparkles, Loader2, Image as ImageIcon, Film, Download, ArrowRight,
  Upload, X, Clapperboard, AlertCircle, History, Clock,
} from "lucide-react";
import Link from "next/link";
import {
  EFFECTS, VIDEO_MODELS, IMAGE_MODELS, ASPECTS, DURATIONS,
  type AspectRatio, type Duration, type EffectCategory,
} from "@/lib/ai-presets";
import { uid } from "@/lib/utils";

type Tab = "generate" | "effects" | "image";
type SrcImage = { dataUrl: string; name: string };
type HistoryItem = {
  id: string;
  type: "video" | "image";
  url: string;
  prompt: string;
  aspect: AspectRatio;
  createdAt: number;
};

// AI Studio is excluded from the beta. This full implementation is preserved
// here (NOT wired to a route) so it can be brought back post-beta. To re-enable:
// render <StudioApp/> from src/app/studio/page.tsx instead of the redirect, and
// set AI_GENERATION_ENABLED=true on the server so the generate routes accept calls.
const COMING_SOON = false;

const HISTORY_KEY = "vybe-studio-history";
const ASPECT_LABEL: Record<AspectRatio, string> = { "9:16": "Vertical", "16:9": "Wide", "1:1": "Square" };

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
}
async function urlToDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

function ComingSoon() {
  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-2xl mx-auto px-4 sm:px-8 py-20 sm:py-28">
        <div className="relative rounded-3xl border border-violet-500/15 bg-violet-500/[0.04] p-8 sm:p-12 text-center overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[360px] h-[260px] bg-violet-600/10 rounded-full blur-[90px] pointer-events-none" />

          <div className="relative">
            <div className="w-12 h-12 rounded-2xl bg-violet-600/15 border border-violet-500/25 flex items-center justify-center mx-auto mb-6">
              <Wand2 size={22} className="text-violet-400" />
            </div>

            <div className="inline-flex items-center gap-2 bg-violet-500/[0.08] border border-violet-500/20 text-violet-300/80 text-[11px] font-semibold px-3 py-1 rounded-full mb-5 tracking-wide">
              <Clock size={12} /> Coming soon
            </div>

            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent mb-4 leading-tight">
              AI Studio is on the way
            </h1>

            <p className="text-white/45 text-sm sm:text-base leading-relaxed max-w-md mx-auto mb-8">
              Generate videos and images from a prompt, turn a still into a
              cinematic clip, and send it straight to the editor. We&rsquo;re
              putting the finishing touches on it — it&rsquo;ll be live here soon.
            </p>

            <div className="grid sm:grid-cols-3 gap-3 mb-9 text-left">
              {[
                { icon: Clapperboard, label: "Text → Video", note: "Describe a scene, get a clip" },
                { icon: Sparkles, label: "Image Effects", note: "Animate a still with VFX" },
                { icon: ImageIcon, label: "Text → Image", note: "Photoreal stills in seconds" },
              ].map(({ icon: Icon, label, note }) => (
                <div key={label} className="rounded-xl border border-white/[0.06] bg-black/30 p-3.5">
                  <Icon size={16} className="text-violet-400/80 mb-2" />
                  <p className="text-[13px] font-semibold text-white/75">{label}</p>
                  <p className="text-[11px] text-white/35 leading-snug mt-0.5">{note}</p>
                </div>
              ))}
            </div>

            <Link href="/clips"
              className="inline-flex items-center gap-2 bg-violet-600 hover:bg-violet-500 text-white font-semibold px-6 py-3 rounded-xl transition-colors text-sm">
              Use the Clip Editor meanwhile
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StudioApp() {
  if (COMING_SOON) return <ComingSoon />;

  /* eslint-disable react-hooks/rules-of-hooks */
  const [tab, setTab] = useState<Tab>("generate");
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<SrcImage | null>(null);
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [duration, setDuration] = useState<Duration>("5");
  const [videoModel, setVideoModel] = useState(VIDEO_MODELS[0].id);
  const [imageModel, setImageModel] = useState(IMAGE_MODELS[0].id);
  const [effectId, setEffectId] = useState<string>("");
  const [effectCat, setEffectCat] = useState<EffectCategory>("camera");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<HistoryItem | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Deferred a tick so the state update doesn't run synchronously in the
    // effect body (matches the pattern used elsewhere in the app).
    const t = setTimeout(() => {
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (raw) setHistory(JSON.parse(raw));
      } catch { /* ignore corrupt history */ }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  function pushHistory(item: HistoryItem) {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 30);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }
  function clearHistory() {
    setHistory([]);
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  }

  async function onPickImage(file: File) {
    if (!file.type.startsWith("image/")) return;
    setImage({ dataUrl: await fileToDataUrl(file), name: file.name });
  }

  function openInEditor(item: HistoryItem) {
    if (item.type !== "video") return;
    const q = new URLSearchParams({ gen: item.url, t: item.prompt.slice(0, 60) || "AI clip" });
    window.open(`/clips?${q}`, "_blank", "noopener");
  }

  // Send a generated (or any) image into the animate flow.
  async function animateImage(url: string) {
    try {
      setImage({ dataUrl: await urlToDataUrl(url), name: "generated.png" });
      setTab("effects");
      setResult(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setError("Couldn't load that image to animate.");
    }
  }

  async function runVideo() {
    if (loading) return;
    const text = prompt.trim();
    if (tab === "effects" && !effectId) { setError("Pick an effect."); return; }
    if (tab === "effects" && !image) { setError("Upload an image to apply the effect to."); return; }
    if (tab === "generate" && !text && !image) { setError("Describe the video, or add an image to animate."); return; }

    setLoading(true); setError(""); setResult(null);
    try {
      const res = await fetch("/api/clips/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          image: image?.dataUrl,
          aspectRatio: aspect,
          duration,
          model: videoModel,
          effectId: tab === "effects" ? effectId : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error ?? "Generation failed");
      const item: HistoryItem = {
        id: uid(), type: "video", url: data.url,
        prompt: text || EFFECTS.find((e) => e.id === effectId)?.label || "AI clip",
        aspect, createdAt: Date.now(),
      };
      setResult(item); pushHistory(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function runImage() {
    if (loading) return;
    const text = prompt.trim();
    if (!text) { setError("Describe the image you want."); return; }
    setLoading(true); setError(""); setResult(null);
    try {
      const res = await fetch("/api/clips/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, aspectRatio: aspect, model: imageModel }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error ?? "Generation failed");
      const item: HistoryItem = {
        id: uid(), type: "image", url: data.url, prompt: text, aspect, createdAt: Date.now(),
      };
      setResult(item); pushHistory(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const TABS: { id: Tab; label: string; icon: typeof Wand2 }[] = [
    { id: "generate", label: "Generate", icon: Clapperboard },
    { id: "effects", label: "Effects", icon: Sparkles },
    { id: "image", label: "Image", icon: ImageIcon },
  ];

  const aspectBox = aspect === "9:16" ? "aspect-[9/16] max-w-[260px]" : aspect === "1:1" ? "aspect-square max-w-[360px]" : "aspect-video max-w-[480px]";

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-violet-600/15 border border-violet-500/25 flex items-center justify-center flex-shrink-0">
            <Wand2 size={17} className="text-violet-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent leading-tight">AI Studio</h1>
            <p className="text-white/35 text-sm">Generate videos and images with AI — then send them straight to the editor.</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1.5 mb-4">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => { setTab(t.id); setError(""); }}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                tab === t.id ? "bg-violet-600/25 text-violet-200 border border-violet-500/30"
                  : "text-white/40 hover:text-white/70 hover:bg-white/[0.04] border border-transparent"
              }`}>
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>

        <div className="grid lg:grid-cols-[1fr_auto] gap-6 items-start">
          {/* ── Controls ── */}
          <div className="bg-d12 border border-white/[0.06] rounded-2xl p-4 space-y-4">
            {/* Effects grid */}
            {tab === "effects" && (
              <div>
                <div className="flex gap-1.5 mb-3">
                  {(["camera", "vfx"] as EffectCategory[]).map((c) => (
                    <button key={c} type="button" onClick={() => setEffectCat(c)}
                      className={`px-3 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                        effectCat === c ? "bg-white/[0.08] text-white/85" : "text-white/40 hover:text-white/65"
                      }`}>
                      {c === "camera" ? "Camera moves" : "VFX"}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {EFFECTS.filter((e) => e.category === effectCat).map((e) => (
                    <button key={e.id} type="button" onClick={() => setEffectId(e.id)} title={e.blurb}
                      className={`flex flex-col items-center gap-1 px-2 py-3 rounded-xl border text-center transition-colors ${
                        effectId === e.id ? "bg-violet-600/20 border-violet-500/40" : "bg-black/30 border-white/[0.06] hover:border-white/[0.14]"
                      }`}>
                      <span className="text-xl leading-none">{e.emoji}</span>
                      <span className="text-[10px] font-medium text-white/70 leading-tight">{e.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Image input (generate + effects) */}
            {tab !== "image" && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">
                  {tab === "effects" ? "Image to animate" : "Image (optional)"}
                </p>
                {image ? (
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.dataUrl} alt="" className="h-24 rounded-lg border border-white/[0.1] object-cover" />
                    <button type="button" onClick={() => setImage(null)}
                      className="absolute -top-2 -right-2 p-1 rounded-full bg-black/80 border border-white/15 text-white/70 hover:text-white">
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => imageInputRef.current?.click()}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-white/[0.12] text-white/45 hover:text-white/70 hover:border-white/25 text-xs transition-colors w-full">
                    <Upload size={14} /> Upload an image
                  </button>
                )}
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); e.target.value = ""; }} />
              </div>
            )}

            {/* Prompt */}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">
                {tab === "effects" ? "Extra detail (optional)" : tab === "image" ? "Describe the image" : "Describe the video"}
              </p>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
                placeholder={
                  tab === "effects" ? "e.g. keep the lighting moody"
                  : tab === "image" ? "e.g. a neon-lit street at night, cinematic, ultra detailed"
                  : "e.g. a corgi surfing a giant wave at sunset, cinematic"}
                className="w-full bg-black/30 border border-white/[0.07] rounded-xl px-3 py-2.5 text-sm text-white/80 placeholder:text-white/25 outline-none focus:border-violet-500/40 transition-colors resize-none" />
            </div>

            {/* Aspect */}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">Aspect</p>
              <div className="flex rounded-lg overflow-hidden border border-white/[0.08] w-fit">
                {ASPECTS.map((a) => (
                  <button key={a} type="button" onClick={() => setAspect(a)}
                    className={`px-3 py-1.5 text-[11px] font-medium transition-colors ${
                      aspect === a ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                    }`}>
                    {a} <span className="text-white/30">{ASPECT_LABEL[a]}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Video-only: duration + model */}
            {tab !== "image" ? (
              <div className="flex flex-wrap gap-4">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">Length</p>
                  <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                    {DURATIONS.map((d) => (
                      <button key={d} type="button" onClick={() => setDuration(d)}
                        className={`px-3 py-1.5 text-[11px] font-medium tabular-nums transition-colors ${
                          duration === d ? "bg-violet-600/25 text-violet-200" : "text-white/35 hover:text-white/60"
                        }`}>{d}s</button>
                    ))}
                  </div>
                </div>
                <div className="min-w-[160px]">
                  <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">Model</p>
                  <select value={videoModel} onChange={(e) => setVideoModel(e.target.value)}
                    className="w-full bg-black/30 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-white/75 outline-none focus:border-violet-500/40">
                    {VIDEO_MODELS.map((m) => <option key={m.id} value={m.id} className="bg-d1a">{m.label} — {m.blurb}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div className="min-w-[160px]">
                <p className="text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1.5">Model</p>
                <select value={imageModel} onChange={(e) => setImageModel(e.target.value)}
                  className="w-full max-w-[220px] bg-black/30 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-white/75 outline-none focus:border-violet-500/40">
                  {IMAGE_MODELS.map((m) => <option key={m.id} value={m.id} className="bg-d1a">{m.label} — {m.blurb}</option>)}
                </select>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-xs">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" /> <span>{error}</span>
              </div>
            )}

            <button type="button" onClick={tab === "image" ? runImage : runVideo} disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-xl text-sm font-semibold transition-colors">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {loading ? "Generating…" : tab === "image" ? "Generate image" : "Generate video"}
            </button>
            {loading && <p className="text-center text-[11px] text-white/30">This can take 30–90 seconds.</p>}
          </div>

          {/* ── Preview ── */}
          <div className="lg:w-[420px]">
            <div className={`mx-auto w-full ${aspectBox} rounded-2xl border border-white/[0.06] bg-black/40 overflow-hidden flex items-center justify-center`}>
              {loading ? (
                <div className="flex flex-col items-center gap-2 text-white/30">
                  <Loader2 size={22} className="animate-spin text-violet-400/60" />
                  <p className="text-xs">Generating…</p>
                </div>
              ) : result?.type === "video" ? (
                <video src={result.url} controls autoPlay loop muted className="w-full h-full object-contain" />
              ) : result?.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result.url} alt="" className="w-full h-full object-contain" />
              ) : (
                <div className="flex flex-col items-center gap-2 text-white/20">
                  <Film size={26} />
                  <p className="text-xs">Your result shows here</p>
                </div>
              )}
            </div>

            {result && !loading && (
              <div className="flex flex-wrap gap-2 mt-3 justify-center">
                {result.type === "video" ? (
                  <button type="button" onClick={() => openInEditor(result)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-200 text-xs font-semibold transition-colors">
                    <Film size={13} /> Open in editor <ArrowRight size={12} />
                  </button>
                ) : (
                  <button type="button" onClick={() => animateImage(result.url)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-200 text-xs font-semibold transition-colors">
                    <Sparkles size={13} /> Animate this <ArrowRight size={12} />
                  </button>
                )}
                <a href={result.url} download
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-white/70 text-xs font-semibold transition-colors">
                  <Download size={13} /> Download
                </a>
              </div>
            )}
          </div>
        </div>

        {/* ── History ── */}
        {history.length > 0 && (
          <div className="mt-10">
            <div className="flex items-center gap-2 mb-3">
              <History size={14} className="text-white/35" />
              <h2 className="text-sm font-semibold text-white/70">Recent generations</h2>
              <button type="button" onClick={clearHistory} className="ml-auto text-[11px] text-white/30 hover:text-white/60">Clear</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {history.map((h) => (
                <div key={h.id} className="group bg-d12 border border-white/[0.06] rounded-xl overflow-hidden flex flex-col">
                  <div className="relative aspect-video bg-black">
                    {h.type === "video" ? (
                      <video src={h.url} className="w-full h-full object-cover" muted
                        onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                        onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0; }} />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={h.url} alt="" className="w-full h-full object-cover" />
                    )}
                    <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/70 text-white/70 backdrop-blur-sm">
                      {h.type === "video" ? "VIDEO" : "IMAGE"} · {h.aspect}
                    </span>
                  </div>
                  <div className="p-2.5 flex flex-col flex-1">
                    <p className="text-[11px] text-white/55 leading-snug line-clamp-2 mb-2">{h.prompt}</p>
                    <div className="mt-auto flex gap-1.5">
                      {h.type === "video" ? (
                        <button type="button" onClick={() => openInEditor(h)}
                          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-200 text-[10px] font-semibold transition-colors">
                          <Film size={11} /> Edit
                        </button>
                      ) : (
                        <button type="button" onClick={() => animateImage(h.url)}
                          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-200 text-[10px] font-semibold transition-colors">
                          <Sparkles size={11} /> Animate
                        </button>
                      )}
                      <a href={h.url} download
                        className="flex items-center justify-center px-2 py-1.5 rounded-md bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-white/60 transition-colors">
                        <Download size={11} />
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
