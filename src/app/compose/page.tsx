"use client";
import React, { useEffect, useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { platformIcon, safeFetch } from "@/lib/utils";
import {
  Send, Save, X, Upload, Loader2, AlertCircle, CheckCircle2,
  Film, Hash, Clock, ChevronDown, ChevronUp, Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import EmojiPicker, { insertEmoji } from "@/components/EmojiPicker";
import PageHeader from "@/components/PageHeader";
import { uploadFile as uploadToStorage } from "@/lib/upload-client";
import TikTokPostModal from "@/components/TikTokPostModal";

type Account = { id: number; platform: string; username: string; isActive: boolean };

const PLATFORM_LIMITS: Record<string, number> = {
  twitter: 280, tiktok: 2200, instagram: 2200, youtube: 5000,
};

function isVideoUrl(url: string) {
  return /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(url);
}

// ─── Components ───────────────────────────────────────────────────────────────

function PlatformSection({ platform, children }: { platform: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const icons: Record<string, string> = { youtube: "▶", tiktok: "♪", instagram: "📷", twitter: "𝕏" };
  const labels: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", twitter: "Twitter / X" };
  return (
    <div className="border border-white/[0.06] rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-white/[0.03] hover:bg-white/[0.05] transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-white/60">
          <span>{icons[platform] ?? "📱"}</span>
          {labels[platform] ?? platform} options
        </span>
        {open ? <ChevronUp size={14} className="text-white/25" /> : <ChevronDown size={14} className="text-white/25" />}
      </button>
      {open && <div className="p-4 space-y-3">{children}</div>}
    </div>
  );
}

function Toggle({ value, onChange, label, sub }: { value: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <div
        onClick={() => onChange(!value)}
        className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors flex-shrink-0 ${value ? "bg-violet-600" : "bg-white/10"}`}
      >
        <div className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${value ? "translate-x-4" : ""}`} />
      </div>
      <div>
        <p className="text-sm font-medium text-white/65">{label}</p>
        {sub && <p className="text-xs text-white/30">{sub}</p>}
      </div>
    </label>
  );
}

const DInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function DInput({ className = "", ...rest }, ref) {
    return (
      <input
        ref={ref}
        {...rest}
        className={`w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-violet-500/50 focus:bg-white/[0.07] transition-colors placeholder:text-white/20 ${className}`}
      />
    );
  }
);

function DSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return (
    <select
      {...rest}
      className={`w-full bg-d1a border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/70 outline-none focus:border-violet-500/50 transition-colors ${className}`}
    />
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function ComposeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([]);
  const [content, setContent] = useState("");
  const [mediaUrls, setMediaUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [hashtagIdeas, setHashtagIdeas] = useState<string[]>([]);
  const [hashtagsLoading, setHashtagsLoading] = useState(false);
  const [hashtagsError, setHashtagsError] = useState("");

  const [videoTitle, setVideoTitle] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoAspect, setVideoAspect] = useState<{ w: number; h: number } | null>(null);

  const [isShort, setIsShort] = useState(false);
  const [ytTags, setYtTags] = useState("");
  const [ytCategory, setYtCategory] = useState("22");
  const [ytPrivacy, setYtPrivacy] = useState<"public" | "private" | "unlisted">("public");
  const [tiktokPostAccount, setTiktokPostAccount] = useState<number | null>(null);
  const [igType, setIgType] = useState<"reel" | "post">("reel");

  const [scheduledAt, setScheduledAt] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return format(d, "yyyy-MM-dd'T'HH:mm");
  });

  useEffect(() => {
    safeFetch<Account[]>("/api/accounts", undefined, []).then((data) =>
      setAccounts(data.filter((a) => a.isActive))
    );
  }, []);

  useEffect(() => {
    const videoUrl = searchParams.get("videoUrl");
    const titleParam = searchParams.get("videoTitle");
    const dateParam = searchParams.get("date");
    const timeParam = searchParams.get("time");
    if (!videoUrl && !titleParam && !dateParam) return;
    // Defer a tick so these don't run synchronously inside the effect body.
    const t = setTimeout(() => {
      if (videoUrl) setMediaUrls([videoUrl]);
      if (titleParam) setVideoTitle(titleParam);
      if (dateParam) setScheduledAt(`${dateParam}T${timeParam ?? "12:00"}`);
    }, 0);
    return () => clearTimeout(t);
  }, [searchParams]);

  const videoUrl = mediaUrls.find(isVideoUrl) ?? null;
  const imageUrls = mediaUrls.filter((u) => !isVideoUrl(u));
  const isVideoMode = !!videoUrl;

  const selectedPlatforms = selectedAccounts
    .map((id) => accounts.find((a) => a.id === id)?.platform)
    .filter((p): p is string => !!p);

  const hasYoutube = selectedPlatforms.includes("youtube");
  const hasTikTok = selectedPlatforms.includes("tiktok");
  const hasInstagram = selectedPlatforms.includes("instagram");

  const charLimit = selectedPlatforms.length > 0
    ? Math.min(...selectedPlatforms.map((p) => PLATFORM_LIMITS[p] ?? 2200))
    : 280;

  function toggleAccount(id: number) {
    setSelectedAccounts((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) { setError("File too large (max 500 MB)"); return; }
    setUploading(true);
    setError("");
    try {
      const url = await uploadToStorage(file, "media");
      setMediaUrls((prev) => [...prev, url]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Ask Gemini for hashtags — it sees frames from the video (when present)
  // plus the title, the caption written so far, and the target platforms.
  async function suggestHashtags() {
    if (hashtagsLoading) return;
    setHashtagsLoading(true); setHashtagsError(""); setHashtagIdeas([]);
    try {
      const res = await fetch("/api/clips/ai-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "hashtags",
          videoUrl,
          title: videoTitle,
          postText: content,
          platform: selectedPlatforms.join(", "),
          duration: videoDuration,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to suggest hashtags");
      // Hide tags already in the caption.
      const existing = new Set((content.match(/#[\w]+/g) ?? []).map((t) => t.toLowerCase()));
      const ideas = (data.suggestions ?? []).filter((t: string) => !existing.has(t.toLowerCase()));
      setHashtagIdeas(ideas);
      if (ideas.length === 0) setHashtagsError("No new hashtags came back — try again.");
    } catch (e) {
      setHashtagsError(e instanceof Error ? e.message : "Failed to suggest hashtags");
    } finally {
      setHashtagsLoading(false);
    }
  }

  function appendHashtags(tags: string[]) {
    setContent((prev) => {
      const sep = prev === "" ? "" : /[\s\n]$/.test(prev) ? "" : prev.includes("#") ? " " : "\n\n";
      return prev + sep + tags.join(" ");
    });
    setHashtagIdeas((prev) => prev.filter((t) => !tags.includes(t)));
  }

  async function save(status: "scheduled" | "draft") {
    setError("");
    if (selectedAccounts.length === 0) { setError("Select at least one account to post to."); return; }
    // TikTok posts go through the TikTok posting screen (explicit consent per
    // post), so they're never saved for the scheduler.
    const targets = selectedAccounts.filter((id) => accounts.find((a) => a.id === id)?.platform !== "tiktok");
    if (targets.length === 0) { setError("TikTok can't be scheduled. Use “Post to TikTok” in the TikTok section."); return; }
    if (!content.trim() && !isVideoMode) { setError("Write some content first."); return; }
    if (isVideoMode && !videoTitle.trim() && !content.trim()) { setError("Add a title or caption for your video."); return; }
    setSaving(true);
    try {
      for (const accountId of targets) {
        const acc = accounts.find((a) => a.id === accountId);
        let metadata: Record<string, unknown> | undefined;
        if (acc?.platform === "youtube") {
          metadata = { isShort, videoTitle: videoTitle || content.slice(0, 100), tags: ytTags.split(",").map((t) => t.trim()).filter(Boolean), category: ytCategory, privacy: ytPrivacy };
        } else if (acc?.platform === "instagram") {
          metadata = { type: igType, videoTitle };
        }
        const res = await fetch("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // datetime-local is the user's wall clock; send a real UTC instant.
          body: JSON.stringify({ accountId, platform: acc?.platform, content, mediaUrls, metadata, scheduledAt: new Date(scheduledAt).toISOString(), status }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to save"); }
      }
      setSaved(true);
      setTimeout(() => router.push("/dashboard"), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  // ── Shared blocks ──────────────────────────────────────────────────────────

  const accountSelector = (
    <div className="bg-d12 border border-white/[0.06] rounded-2xl p-5">
      <label className="text-xs font-semibold text-white/35 uppercase tracking-widest mb-3 block">Post to</label>
      {accounts.length === 0 ? (
        <p className="text-sm text-white/30">
          No active accounts.{" "}
          <a href="/accounts" className="text-violet-400 hover:text-violet-300">Connect one first.</a>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {accounts.map((acc) => (
            <button
              key={acc.id}
              type="button"
              onClick={() => toggleAccount(acc.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                selectedAccounts.includes(acc.id)
                  ? "bg-violet-600 border-violet-600 text-white"
                  : "bg-white/[0.04] border-white/[0.07] text-white/45 hover:border-violet-500/40 hover:text-white/70 hover:bg-violet-500/10"
              }`}
            >
              <span>{platformIcon(acc.platform)}</span>
              @{acc.username}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const captionCard = (
    <div className="bg-d12 border border-white/[0.06] rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <label className="text-xs font-semibold text-white/35 uppercase tracking-widest">
          {isVideoMode ? "Caption / Description" : "Content"}
        </label>
        {selectedPlatforms.length > 0 && (
          <div className="flex items-center gap-1.5">
            {selectedPlatforms.map((p) => (
              <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.08] text-white/40 font-mono">
                {PLATFORM_LIMITS[p] ?? "∞"}
              </span>
            ))}
          </div>
        )}
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={isVideoMode ? "Describe your video, add hashtags…" : "What do you want to share?"}
        rows={isVideoMode ? 5 : 7}
        maxLength={5000}
        className="w-full text-white/70 text-sm resize-none outline-none placeholder:text-white/20 bg-transparent"
      />
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/[0.05]">
        <button
          type="button"
          onClick={suggestHashtags}
          disabled={hashtagsLoading}
          title="Let AI suggest hashtags from the video, title, and caption"
          className="flex items-center gap-1.5 text-xs text-white/30 hover:text-violet-400 px-2 py-1 rounded hover:bg-violet-500/10 disabled:opacity-50 transition-colors"
        >
          {hashtagsLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {hashtagsLoading ? "Thinking…" : "AI hashtags"}
        </button>
        <span className={`text-xs font-mono font-medium ${
          content.length > charLimit ? "text-red-400" : content.length > charLimit * 0.9 ? "text-amber-400" : "text-white/20"
        }`}>
          {content.length} / {charLimit}
        </span>
      </div>

      {hashtagsError && (
        <p className="text-[11px] text-red-400/70 mt-2">{hashtagsError}</p>
      )}
      {hashtagIdeas.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {hashtagIdeas.map((t) => (
            <button key={t} type="button" onClick={() => appendHashtags([t])}
              title="Add to caption"
              className="px-2 py-1 rounded-lg bg-violet-500/[0.07] border border-violet-500/15 text-[11px] text-violet-200/70
                hover:bg-violet-500/15 hover:border-violet-500/30 hover:text-violet-200 transition-colors duration-150">
              {t}
            </button>
          ))}
          <button type="button" onClick={() => appendHashtags(hashtagIdeas)}
            className="px-2 py-1 text-[11px] text-white/30 hover:text-violet-300 font-medium transition-colors flex items-center gap-1">
            <Hash size={10} /> Add all
          </button>
          <button type="button" onClick={() => setHashtagIdeas([])}
            className="px-1.5 py-1 text-[11px] text-white/20 hover:text-white/40 transition-colors">
            <X size={10} />
          </button>
        </div>
      )}
    </div>
  );

  const imagePreview = imageUrls.length > 0 && (
    <div className="bg-d12 border border-white/[0.06] rounded-2xl p-5">
      <label className="text-xs font-semibold text-white/35 uppercase tracking-widest mb-3 block">Images</label>
      <div className="flex flex-wrap gap-2">
        {imageUrls.map((url, i) => (
          <div key={i} className="relative group w-20 h-20">
            <img src={url} alt="" className="w-20 h-20 object-cover rounded-lg border border-white/[0.08]" />
            <button
              onClick={() => setMediaUrls((prev) => prev.filter((u) => u !== url))}
              className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center hover-reveal transition-opacity"
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  const platformOptions = (hasYoutube || hasTikTok || hasInstagram) && (
    <div className="space-y-3">
      {hasYoutube && (
        <PlatformSection platform="youtube">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] text-white/30 uppercase tracking-wide">Video title</label>
              <EmojiPicker onSelect={(emoji) => insertEmoji(titleRef.current, videoTitle, emoji, setVideoTitle)} />
            </div>
            <DInput ref={titleRef} type="text" value={videoTitle} onChange={(e) => setVideoTitle(e.target.value)} placeholder="Defaults to first 100 chars of caption" maxLength={100} />
          </div>
          <Toggle value={isShort} onChange={setIsShort} label="Post as YouTube Short" sub="Video must be 9:16 vertical and under 60 seconds" />
          {isShort && videoAspect && videoAspect.w > videoAspect.h && (
            <div className="flex items-start gap-2 text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
              <AlertCircle size={12} className="flex-shrink-0 mt-0.5 text-amber-400" />
              <span>
                Video is landscape ({videoAspect.w}×{videoAspect.h}). Shorts need 9:16.{" "}
                <a href="/clips" className="underline font-medium text-amber-300">Go to Clip Editor</a> and enable &ldquo;Crop to 9:16&rdquo;.
              </span>
            </div>
          )}
          <div>
            <label className="text-[10px] text-white/30 uppercase tracking-wide mb-1.5 block">Tags (comma-separated)</label>
            <DInput type="text" value={ytTags} onChange={(e) => setYtTags(e.target.value)} placeholder="gaming, highlights, clip" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-white/30 uppercase tracking-wide mb-1.5 block">Category</label>
              <DSelect value={ytCategory} onChange={(e) => setYtCategory(e.target.value)}>
                <option value="1">Film &amp; Animation</option>
                <option value="2">Autos &amp; Vehicles</option>
                <option value="10">Music</option>
                <option value="15">Pets &amp; Animals</option>
                <option value="17">Sports</option>
                <option value="19">Travel &amp; Events</option>
                <option value="20">Gaming</option>
                <option value="22">People &amp; Blogs</option>
                <option value="23">Comedy</option>
                <option value="24">Entertainment</option>
                <option value="25">News &amp; Politics</option>
                <option value="26">Howto &amp; Style</option>
                <option value="27">Education</option>
                <option value="28">Science &amp; Technology</option>
              </DSelect>
            </div>
            <div>
              <label className="text-[10px] text-white/30 uppercase tracking-wide mb-1.5 block">Privacy</label>
              <DSelect value={ytPrivacy} onChange={(e) => setYtPrivacy(e.target.value as typeof ytPrivacy)}>
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </DSelect>
            </div>
          </div>
        </PlatformSection>
      )}

      {hasTikTok && (
        <PlatformSection platform="tiktok">
          {!videoUrl ? (
            <p className="text-xs text-white/40">TikTok needs a video. Add one to post to TikTok.</p>
          ) : (
            <>
              <p className="text-xs text-white/40 leading-relaxed">
                TikTok posts go out right away from TikTok&apos;s posting screen, where you choose privacy and other settings. They can&apos;t be scheduled.
              </p>
              {selectedAccounts
                .map((id) => accounts.find((a) => a.id === id))
                .filter((a): a is Account => a?.platform === "tiktok")
                .map((a) => (
                  <button key={a.id} type="button" onClick={() => setTiktokPostAccount(a.id)}
                    className="w-full flex items-center justify-center gap-2 py-2 bg-white/10 hover:bg-white/15 border border-white/[0.1] text-white rounded-xl text-sm font-semibold transition-colors">
                    <Send size={13} /> Post to TikTok as @{a.username}
                  </button>
                ))}
            </>
          )}
        </PlatformSection>
      )}

      {hasInstagram && (
        <PlatformSection platform="instagram">
          <div>
            <label className="text-[10px] text-white/30 uppercase tracking-wide mb-1.5 block">Post type</label>
            <div className="flex gap-2">
              {(["reel", "post"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setIgType(v)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors capitalize ${
                    igType === v
                      ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white border-transparent"
                      : "bg-transparent border-white/[0.07] text-white/30 hover:border-white/[0.15] hover:text-white/50"
                  }`}
                >
                  {v === "reel" ? "📹 Reel" : "🖼 Post"}
                </button>
              ))}
            </div>
          </div>
        </PlatformSection>
      )}
    </div>
  );

  const scheduleCard = (
    <div className="bg-d12 border border-white/[0.06] rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <Clock size={13} className="text-violet-400/70" />
        <label className="text-xs font-semibold text-white/35 uppercase tracking-widest">Schedule for</label>
      </div>
      <input
        type="datetime-local"
        value={scheduledAt}
        onChange={(e) => setScheduledAt(e.target.value)}
        className="bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/70 outline-none focus:border-violet-500/50 transition-colors"
      />
      <p className="text-[11px] text-white/20 mt-2">Scheduler checks every minute and posts at the scheduled time.</p>
    </div>
  );

  const actions = (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <AlertCircle size={14} className="flex-shrink-0" /> {error}
        </div>
      )}
      {saved && (
        <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3">
          <CheckCircle2 size={14} /> Saved! Redirecting to dashboard…
        </div>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => save("draft")}
          disabled={saving || saved}
          className="flex items-center gap-2 px-5 py-2.5 bg-white/[0.05] border border-white/[0.07] text-white/60 rounded-xl text-sm font-medium hover:bg-white/[0.08] disabled:opacity-50 transition-colors"
        >
          <Save size={14} /> Save Draft
        </button>
        <button
          type="button"
          onClick={() => save("scheduled")}
          disabled={saving || saved || selectedAccounts.length === 0}
          className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors shadow-[0_0_20px_rgba(51,92,186,0.25)] disabled:shadow-none"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {saving ? "Scheduling…" : "Schedule Post"}
        </button>
      </div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <PageHeader
          eyebrow={isVideoMode ? "Compose · Video" : "Compose"}
          title={isVideoMode ? "Post your clip" : "Compose a post"}
          description={isVideoMode ? "Review your clip and schedule it across platforms." : "Create and schedule content across your accounts."}
          actions={!isVideoMode && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-2 px-4 py-2 border border-dashed border-white/[0.10] text-white/35 rounded-xl text-sm hover:border-violet-500/50 hover:text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-50"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {uploading ? "Uploading…" : "Upload Media"}
            </button>
          )}
        />
        <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={uploadFile} />
        {tiktokPostAccount !== null && videoUrl && (
          <TikTokPostModal
            accountId={tiktokPostAccount}
            videoUrl={videoUrl}
            videoDuration={videoDuration}
            initialTitle={content || videoTitle}
            onClose={() => setTiktokPostAccount(null)}
          />
        )}

        {isVideoMode ? (
          <div className="flex flex-col lg:flex-row gap-6 items-start">
            {/* Left: sticky video */}
            <div className="w-full lg:w-72 xl:w-80 flex-shrink-0 lg:sticky lg:top-6 space-y-3">
              <div className="bg-black rounded-2xl overflow-hidden border border-white/[0.08] shadow-2xl">
                <video
                  ref={videoRef}
                  src={videoUrl!}
                  controls
                  className="w-full"
                  onLoadedMetadata={(e) => {
                    const v = e.target as HTMLVideoElement;
                    setVideoDuration(v.duration);
                    setVideoAspect({ w: v.videoWidth, h: v.videoHeight });
                  }}
                />
              </div>

              <div className="bg-d12 border border-white/[0.06] rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] font-semibold text-white/30 uppercase tracking-widest">Video Title</label>
                  <EmojiPicker
                    direction="down"
                    onSelect={(emoji) => insertEmoji(titleRef.current, videoTitle, emoji, setVideoTitle)}
                  />
                </div>
                <input
                  ref={titleRef}
                  type="text"
                  value={videoTitle}
                  onChange={(e) => setVideoTitle(e.target.value)}
                  placeholder="Enter a title for your video"
                  maxLength={150}
                  className="w-full text-sm text-white/70 outline-none placeholder:text-white/20 bg-transparent"
                />
                {videoDuration > 0 && (
                  <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-white/[0.05]">
                    <Film size={11} className="text-white/25" />
                    <span className="text-[11px] text-white/30 font-mono">
                      {Math.floor(videoDuration / 60)}:{String(Math.floor(videoDuration % 60)).padStart(2, "0")}
                    </span>
                    {videoDuration <= 60 && (
                      <span className="text-[10px] bg-green-500/15 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded font-medium ml-auto">
                        Shorts eligible
                      </span>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => { setMediaUrls((prev) => prev.filter((u) => !isVideoUrl(u))); setVideoDuration(0); }}
                className="w-full flex items-center justify-center gap-2 py-2 text-xs text-white/25 hover:text-red-400 hover:bg-red-500/10 rounded-xl border border-dashed border-white/[0.06] hover:border-red-500/20 transition-colors"
              >
                <X size={12} /> Remove video
              </button>
            </div>

            {/* Right: form */}
            <div className="flex-1 min-w-0 space-y-3">
              {accountSelector}
              {captionCard}
              {imagePreview}
              {platformOptions}
              {scheduleCard}
              {actions}
            </div>
          </div>
        ) : (
          <div className="max-w-2xl space-y-3">
            {accountSelector}
            {captionCard}
            {imagePreview}
            {platformOptions}
            {scheduleCard}
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ComposePage() {
  return <Suspense><ComposeInner /></Suspense>;
}
