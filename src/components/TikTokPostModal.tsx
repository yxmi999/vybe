"use client";
import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, Loader2, X } from "lucide-react";

// TikTok posting screen. Follows TikTok's Content Sharing Guidelines:
// shows the creator's account, privacy options come from creator_info with no
// default, interaction toggles start off and respect the creator's settings,
// commercial content disclosure, the legal declaration, a preview, and an
// explicit Post click. Nothing is uploaded until the user presses the button.

type PrivacyLevel = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

type CreatorInfo = {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: PrivacyLevel[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
};

const PRIVACY_LABELS: Record<PrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

const MUSIC_URL = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const BC_URL = "https://www.tiktok.com/legal/page/global/bc-policy/en";

type Phase = "edit" | "posting" | "processing" | "done" | "failed";

export default function TikTokPostModal({
  accountId, videoUrl, videoDuration, initialTitle, onClose,
}: {
  accountId: number;
  videoUrl: string;
  videoDuration: number;
  initialTitle: string;
  onClose: () => void;
}) {
  const [creator, setCreator] = useState<CreatorInfo | null>(null);
  const [loadError, setLoadError] = useState("");

  const [mode, setMode] = useState<"direct" | "inbox">("direct");
  const [title, setTitle] = useState(initialTitle.slice(0, 2200));
  const [privacy, setPrivacy] = useState<PrivacyLevel | "">("");
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);

  const [phase, setPhase] = useState<Phase>("edit");
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tiktok/creator-info?accountId=${accountId}`)
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) setLoadError(d.error ?? "Couldn't load your TikTok account.");
        else setCreator(d);
      })
      .catch(() => !cancelled && setLoadError("Couldn't reach TikTok. Try again."));
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [accountId]);

  const tooLong = !!creator && videoDuration > 0 && videoDuration > creator.max_video_post_duration_sec;
  const discloseIncomplete = disclose && !yourBrand && !branded;

  let blockReason = "";
  if (tooLong) blockReason = `This video is longer than this account's ${creator!.max_video_post_duration_sec}s limit.`;
  else if (mode === "direct" && !privacy) blockReason = "Choose who can view this post.";
  else if (mode === "direct" && discloseIncomplete) blockReason = "You need to indicate if your content promotes yourself, a third party, or both.";

  function pickPrivacy(p: PrivacyLevel) {
    if (p === "SELF_ONLY" && branded) return;
    setPrivacy(p);
  }

  function poll(publishId: string, postId: number, tries = 0) {
    pollRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/tiktok/status?accountId=${accountId}&publishId=${encodeURIComponent(publishId)}&postId=${postId}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        if (d.status === "PUBLISH_COMPLETE" || d.status === "SEND_TO_USER_INBOX") { setPhase("done"); return; }
        if (d.status === "FAILED") { setError(`TikTok couldn't process the video (${d.fail_reason ?? "unknown reason"}).`); setPhase("failed"); return; }
      } catch { /* keep polling; status is best-effort */ }
      // TikTok can take a few minutes; after ~2 min stop polling and tell the user it's still processing.
      if (tries < 40) poll(publishId, postId, tries + 1);
      else setPhase("done");
    }, 3000);
  }

  async function submit() {
    if (blockReason || phase === "posting") return;
    setError("");
    setPhase("posting");
    try {
      const r = await fetch("/api/tiktok/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId, videoUrl, mode, title,
          privacyLevel: privacy,
          allowComment, allowDuet, allowStitch,
          brandOrganic: disclose && yourBrand,
          brandContent: disclose && branded,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Posting failed");
      setPhase("processing");
      poll(d.publishId, d.postId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Posting failed");
      setPhase("edit");
    }
  }

  const labelText = disclose && branded
    ? "Your video will be labeled as “Paid partnership”."
    : disclose && yourBrand
      ? "Your video will be labeled as “Promotional content”."
      : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Post to TikTok">
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-d12 border border-white/[0.08] rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-sm font-semibold text-white/80">Post to TikTok</h2>
          <button type="button" onClick={onClose} disabled={phase === "posting"} className="text-white/30 hover:text-white/70 disabled:opacity-30" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {loadError ? (
          <div className="p-6">
            <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" /> {loadError}
            </div>
          </div>
        ) : !creator ? (
          <div className="p-10 flex justify-center"><Loader2 className="animate-spin text-white/30" /></div>
        ) : phase === "processing" || phase === "done" ? (
          <div className="p-8 text-center space-y-3">
            {phase === "processing"
              ? <Loader2 className="animate-spin text-white/40 mx-auto" size={28} />
              : <CheckCircle2 className="text-green-400 mx-auto" size={28} />}
            <p className="text-sm text-white/70">
              {mode === "inbox"
                ? "Sent! Open TikTok and check your inbox notifications to finish editing and post your video."
                : "Your video was sent to TikTok. It may take a few minutes to process and appear on your profile."}
            </p>
            {phase === "done" && (
              <button type="button" onClick={onClose} className="mt-2 px-5 py-2 bg-white/10 hover:bg-white/15 rounded-xl text-sm text-white/80">Close</button>
            )}
          </div>
        ) : phase === "failed" ? (
          <div className="p-8 text-center space-y-3">
            <AlertCircle className="text-red-400 mx-auto" size={28} />
            <p className="text-sm text-white/70">{error}</p>
            <button type="button" onClick={onClose} className="px-5 py-2 bg-white/10 hover:bg-white/15 rounded-xl text-sm text-white/80">Close</button>
          </div>
        ) : (
          <div className="flex flex-col md:flex-row gap-5 p-5">
            {/* Preview */}
            <div className="md:w-56 flex-shrink-0">
              <video src={videoUrl} controls className="w-full rounded-xl bg-black border border-white/[0.08] aspect-[9/16] object-contain" />
            </div>

            <div className="flex-1 min-w-0 space-y-4">
              {/* Account */}
              <div className="flex items-center gap-3">
                {creator.creator_avatar_url && <img src={creator.creator_avatar_url} alt="" className="w-9 h-9 rounded-full" />}
                <div>
                  <p className="text-sm font-semibold text-white/80">{creator.creator_nickname}</p>
                  <p className="text-xs text-white/35">@{creator.creator_username}</p>
                </div>
              </div>

              {tooLong && (
                <div className="flex items-start gap-2 text-xs text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5">
                  <AlertCircle size={12} className="flex-shrink-0 mt-0.5" /> {blockReason}
                </div>
              )}

              {/* Mode */}
              <div className="flex gap-2">
                {([["direct", "Post now"], ["inbox", "Send to TikTok drafts"]] as const).map(([m, label]) => (
                  <button key={m} type="button" onClick={() => setMode(m)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      mode === m ? "bg-white/10 text-white border-white/20" : "border-white/[0.07] text-white/35 hover:text-white/60"}`}>
                    {label}
                  </button>
                ))}
              </div>

              {mode === "inbox" ? (
                <p className="text-xs text-white/40 leading-relaxed">
                  The video is uploaded to your TikTok inbox. You add the caption, choose privacy and post it yourself in the TikTok app.
                </p>
              ) : (
                <>
                  {/* Title */}
                  <div>
                    <label className="text-[10px] text-white/30 uppercase tracking-wide mb-1.5 block">Caption</label>
                    <textarea value={title} onChange={(e) => setTitle(e.target.value)} maxLength={2200} rows={3}
                      className="w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-violet-500/50 resize-none" />
                  </div>

                  {/* Privacy */}
                  <div>
                    <label className="text-[10px] text-white/30 uppercase tracking-wide mb-1.5 block">Who can view this video</label>
                    <select value={privacy} onChange={(e) => pickPrivacy(e.target.value as PrivacyLevel)}
                      className="w-full bg-d1a border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/70 outline-none focus:border-violet-500/50">
                      <option value="" disabled>Select…</option>
                      {creator.privacy_level_options.map((p) => (
                        <option key={p} value={p} disabled={p === "SELF_ONLY" && branded}>
                          {PRIVACY_LABELS[p] ?? p}{p === "SELF_ONLY" && branded ? " (not available for branded content)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Interactions */}
                  <div>
                    <label className="text-[10px] text-white/30 uppercase tracking-wide mb-1.5 block">Allow users to</label>
                    <div className="flex flex-wrap gap-4">
                      <Check label="Comment" checked={allowComment} onChange={setAllowComment} disabled={creator.comment_disabled} />
                      <Check label="Duet" checked={allowDuet} onChange={setAllowDuet} disabled={creator.duet_disabled} />
                      <Check label="Stitch" checked={allowStitch} onChange={setAllowStitch} disabled={creator.stitch_disabled} />
                    </div>
                  </div>

                  {/* Commercial content disclosure */}
                  <div className="border border-white/[0.06] rounded-xl p-3 space-y-2.5">
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <span>
                        <span className="block text-sm text-white/70">Disclose video content</span>
                        <span className="block text-xs text-white/35">Turn on to disclose that this video promotes goods or services in exchange for something of value.</span>
                      </span>
                      <input type="checkbox" checked={disclose} onChange={(e) => { setDisclose(e.target.checked); if (!e.target.checked) { setYourBrand(false); setBranded(false); } }} className="w-4 h-4 accent-violet-600" />
                    </label>
                    {disclose && (
                      <div className="space-y-2 pl-1">
                        <Check label="Your brand" sub="You are promoting yourself or your own business." checked={yourBrand} onChange={setYourBrand} />
                        <Check
                          label="Branded content"
                          sub={privacy === "SELF_ONLY" ? "Branded content visibility cannot be set to private." : "You are promoting another brand or a third party."}
                          checked={branded}
                          onChange={setBranded}
                          disabled={privacy === "SELF_ONLY"}
                        />
                        {labelText && (
                          <p className="flex items-center gap-1.5 text-xs text-white/50"><Info size={11} /> {labelText}</p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}

              {error && (
                <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
                  <AlertCircle size={14} className="flex-shrink-0 mt-0.5" /> {error}
                </div>
              )}

              {/* Declaration */}
              <p className="text-[11px] text-white/35 leading-relaxed">
                By posting, you agree to TikTok&apos;s{" "}
                {mode === "direct" && disclose && branded && (
                  <><a href={BC_URL} target="_blank" rel="noreferrer" className="underline hover:text-white/60">Branded Content Policy</a> and{" "}</>
                )}
                <a href={MUSIC_URL} target="_blank" rel="noreferrer" className="underline hover:text-white/60">Music Usage Confirmation</a>.
              </p>

              <div>
                <button type="button" onClick={submit} disabled={!!blockReason || phase === "posting"}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-sm font-semibold disabled:opacity-40 transition-colors">
                  {phase === "posting" && <Loader2 size={14} className="animate-spin" />}
                  {phase === "posting" ? "Uploading to TikTok…" : mode === "inbox" ? "Send to TikTok" : "Post to TikTok"}
                </button>
                {blockReason && !tooLong && <p className="text-[11px] text-white/35 mt-1.5 text-center">{blockReason}</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Check({ label, sub, checked, onChange, disabled }: {
  label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 select-none ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
      <input type="checkbox" checked={checked && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 w-4 h-4 accent-violet-600" />
      <span>
        <span className="block text-sm text-white/70">{label}</span>
        {sub && <span className="block text-xs text-white/35">{sub}</span>}
      </span>
    </label>
  );
}
