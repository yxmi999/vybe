"use client";
// Desktop app settings: the user's own API keys and OAuth app credentials.
// Keys are stored by the desktop shell, encrypted with the OS keychain, and
// applied to the local server immediately — they never leave this machine.
// In the cloud/web build this page just explains it's a desktop feature.
import { useEffect, useState } from "react";
import { Check, ExternalLink, Eye, EyeOff, FolderOpen, KeyRound, Loader2, Monitor, ShieldCheck } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { desktopBridge, useIsDesktop, type DesktopInfo, type DesktopKeyState } from "@/lib/desktop-bridge";

type Field = { name: string; label: string; help?: string; multi?: boolean };
type Group = { title: string; description: string; link?: { label: string; url: string }; redirect?: string; fields: Field[] };

const GROUPS: Group[] = [
  {
    title: "AI",
    description: "Powers clip scoring, cut planning, facecam detection, titles and the AI editor. Free tiers are enough to start — add several keys to raise your daily limit.",
    fields: [
      { name: "GOOGLE_GENERATIVE_AI_API_KEYS", label: "Google Gemini API keys", help: "One or more keys, comma-separated. Get one free at aistudio.google.com/apikey.", multi: true },
      { name: "GROQ_API_KEYS", label: "Groq API keys", help: "Speech-to-text for subtitles and moment checks. Comma-separated. Free at console.groq.com/keys.", multi: true },
      { name: "FAL_KEY", label: "fal.ai key (optional)", help: "Only for AI video generation (B-roll)." },
    ],
  },
  {
    title: "YouTube",
    description: "Lets the app post Shorts to your channel. Create an OAuth client (Web application) in Google Cloud and add the redirect URI below.",
    link: { label: "Google Cloud credentials", url: "https://console.cloud.google.com/apis/credentials" },
    redirect: "/api/auth/youtube",
    fields: [{ name: "YOUTUBE_CLIENT_ID", label: "Client ID" }, { name: "YOUTUBE_CLIENT_SECRET", label: "Client secret" }],
  },
  {
    title: "TikTok",
    description: "Posting to TikTok needs a TikTok developer app with Content Posting access.",
    link: { label: "TikTok developers", url: "https://developers.tiktok.com/apps" },
    redirect: "/api/auth/tiktok",
    fields: [{ name: "TIKTOK_CLIENT_KEY", label: "Client key" }, { name: "TIKTOK_CLIENT_SECRET", label: "Client secret" }],
  },
  {
    title: "Instagram",
    description: "Posting Reels needs a Meta developer app with “Instagram API with Instagram login”. Use the Instagram app ID and secret, and a Business or Creator account.",
    link: { label: "Meta for Developers", url: "https://developers.facebook.com/apps" },
    redirect: "/api/auth/instagram",
    fields: [{ name: "INSTAGRAM_CLIENT_ID", label: "App ID" }, { name: "INSTAGRAM_CLIENT_SECRET", label: "App secret" }],
  },
  {
    title: "X (Twitter)",
    description: "Posting to X needs an X developer project with OAuth 2.0 enabled.",
    link: { label: "X developer portal", url: "https://developer.x.com/en/portal/dashboard" },
    redirect: "/api/auth/twitter",
    fields: [{ name: "TWITTER_CLIENT_ID", label: "Client ID" }, { name: "TWITTER_CLIENT_SECRET", label: "Client secret" }],
  },
];

export default function SettingsPage() {
  const desktop = useIsDesktop();
  const [keys, setKeys] = useState<Record<string, DesktopKeyState>>({});
  const [info, setInfo] = useState<DesktopInfo | null>(null);

  useEffect(() => {
    const d = desktopBridge();
    if (!d) return;
    d.getKeys().then(setKeys).catch(() => {});
    d.getInfo().then(setInfo).catch(() => {});
  }, []);

  if (!desktop) {
    return (
      <div className="min-h-full bg-d0a text-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
          <PageHeader eyebrow="Settings" title="Settings" />
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 flex gap-3 items-start">
            <Monitor size={18} className="text-violet-300 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-white/60">
              API keys are set here in the <span className="text-white/85 font-medium">Vybe desktop app</span>, which runs
              everything on your own computer with your own keys. On the web, everything is already set up for you.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const origin = info?.appUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const aiReady = !!keys.GOOGLE_GENERATIVE_AI_API_KEYS?.set;

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
        <PageHeader eyebrow="Desktop" title="Settings"
          description="Your API keys stay on this computer, encrypted with your Windows account. Clipping, rendering and AI all run locally with them." />

        {!aiReady && (
          <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-200/90">
            Add a Google Gemini key to turn on AI scoring, cut planning, facecam detection and titles.
          </div>
        )}

        <div className="space-y-5">
          {GROUPS.map((g) => (
            <KeyGroup key={g.title} group={g} keys={keys} origin={origin} onSaved={setKeys} />
          ))}

          <section className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 space-y-3">
            <h2 className="text-sm font-semibold flex items-center gap-2"><ShieldCheck size={15} className="text-violet-300" /> Desktop plan</h2>
            <p className="text-sm text-white/55">
              Free on desktop: up to 150 clips a month, 1080p exports and Auto-Pilot — every clip carries the Vybe watermark.
              Everything is stored on this computer and is never auto-deleted.
            </p>
            <p className="text-sm text-white/55">
              The app must be running (it keeps working from the system tray when you close the window) for scheduled posts and Auto-Pilot to run.
            </p>
            {info && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button type="button" onClick={() => desktopBridge()?.openDataDir()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-white/80">
                  <FolderOpen size={13} /> Open data folder
                </button>
                <span className="text-[11px] text-white/30 font-mono truncate">{info.dataDir}</span>
                <span className="text-[11px] text-white/25 ml-auto">v{info.version}</span>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function KeyGroup({ group, keys, origin, onSaved }: {
  group: Group; keys: Record<string, DesktopKeyState>; origin: string; onSaved: (k: Record<string, DesktopKeyState>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = Object.keys(values).length > 0;

  async function save(clear = false) {
    const d = desktopBridge();
    if (!d) return;
    setSaving(true); setMsg(null);
    try {
      const payload = clear ? Object.fromEntries(group.fields.map((f) => [f.name, ""])) : values;
      onSaved(await d.saveKeys(payload));
      setValues({});
      setMsg({ ok: true, text: clear ? "Removed." : "Saved — active now." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Couldn't save." });
    } finally {
      setSaving(false);
    }
  }

  const anySet = group.fields.some((f) => keys[f.name]?.set);

  return (
    <section className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <KeyRound size={15} className="text-violet-300" /> {group.title}
            {anySet && <span className="text-[10px] font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded px-1.5 py-px">Set</span>}
          </h2>
          <p className="text-xs text-white/45 mt-1 leading-relaxed">{group.description}</p>
        </div>
        {group.link && (
          <button type="button" onClick={() => desktopBridge()?.openExternal(group.link!.url)}
            className="flex-shrink-0 flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-200">
            {group.link.label} <ExternalLink size={11} />
          </button>
        )}
      </div>

      {group.redirect && (
        <div className="text-[11px] text-white/40">
          Redirect URI to register:{" "}
          <code className="select-all font-mono text-white/70 bg-white/[0.05] rounded px-1.5 py-0.5">{origin}{group.redirect}</code>
        </div>
      )}

      <div className="space-y-2.5">
        {group.fields.map((f) => {
          const state = keys[f.name];
          return (
            <label key={f.name} className="block">
              <span className="block text-[11px] text-white/50 mb-1">{f.label}</span>
              <input
                type={show ? "text" : "password"}
                autoComplete="off" spellCheck={false}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                placeholder={state?.set ? `Saved (${state.hint}) — type to replace` : f.multi ? "key1, key2, …" : "Not set"}
                className="w-full bg-black/40 border border-white/[0.09] rounded-lg px-3 py-2 text-sm font-mono text-white/85 placeholder:text-white/25 focus:outline-none focus:border-violet-500/50"
              />
              {f.help && <span className="block text-[10px] text-white/30 mt-1">{f.help}</span>}
            </label>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="button" onClick={() => save()} disabled={!dirty || saving}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40">
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
        </button>
        <button type="button" onClick={() => setShow(!show)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-white/45 hover:text-white/80 hover:bg-white/[0.05]">
          {show ? <EyeOff size={12} /> : <Eye size={12} />} {show ? "Hide" : "Show"}
        </button>
        {anySet && (
          <button type="button" onClick={() => save(true)} disabled={saving}
            className="ml-auto px-2.5 py-1.5 rounded-lg text-xs text-white/35 hover:text-red-400 hover:bg-red-500/10">
            Remove
          </button>
        )}
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-300" : "text-red-400"}`}>{msg.text}</span>}
      </div>
    </section>
  );
}
