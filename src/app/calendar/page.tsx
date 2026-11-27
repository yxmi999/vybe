"use client";
import { useEffect, useState, useRef } from "react";
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay,
  addMonths, subMonths, startOfWeek, endOfWeek, setHours, setMinutes,
} from "date-fns";
import { ChevronLeft, ChevronRight, Plus, X, Send, Save, Loader2, ImagePlus, AlertCircle } from "lucide-react";
import { platformIcon, safeFetch } from "@/lib/utils";
import PageHeader from "@/components/PageHeader";
import Link from "next/link";
import { uploadFile as uploadToStorage } from "@/lib/upload-client";

type Post = {
  post: { id: number; content: string; status: string; scheduledAt: string; platform: string };
  account: { username: string } | null;
};
type Account = { id: number; platform: string; username: string; isActive: boolean };

function statusBadge(status: string) {
  const m: Record<string, string> = {
    scheduled: "bg-blue-500/15 text-blue-400 border border-blue-500/20",
    published:  "bg-green-500/15 text-green-400 border border-green-500/20",
    failed:     "bg-red-500/15 text-red-400 border border-red-500/20",
    draft:      "bg-white/[0.08] text-white/40 border border-white/[0.08]",
  };
  return m[status] ?? "bg-white/[0.08] text-white/40";
}

function chipColor(status: string) {
  const m: Record<string, string> = {
    scheduled: "bg-sky-500/20 text-sky-200",
    published: "bg-emerald-500/20 text-emerald-200",
    failed:    "bg-rose-500/20 text-rose-200",
    draft:     "bg-white/[0.08] text-white/45",
  };
  return m[status] ?? "bg-violet-500/20 text-violet-200";
}

function ScheduleModal({
  day, accounts, onClose, onSaved,
}: {
  day: Date; accounts: Account[]; onClose: () => void; onSaved: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const defaultTime = format(setMinutes(setHours(day, 12), 0), "HH:mm");
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([]);
  const [content, setContent] = useState("");
  const [time, setTime] = useState(defaultTime);
  const [mediaUrls, setMediaUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function toggleAccount(id: number) {
    setSelectedAccounts((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) { setError("File too large (max 500 MB)"); return; }
    setUploading(true);
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

  async function save(status: "scheduled" | "draft") {
    setError("");
    if (selectedAccounts.length === 0) { setError("Select at least one account."); return; }
    if (!content.trim()) { setError("Write some content first."); return; }
    const [h, m] = time.split(":").map(Number);
    const scheduledAt = format(setMinutes(setHours(day, h), m), "yyyy-MM-dd'T'HH:mm");
    setSaving(true);
    try {
      for (const accountId of selectedAccounts) {
        const acc = accounts.find((a) => a.id === accountId);
        const res = await fetch("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, platform: acc?.platform, content, mediaUrls, scheduledAt, status }),
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to save"); }
      }
      onSaved(); onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-d14 border border-white/[0.08] rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="font-semibold text-white/80 text-sm">Schedule Post</h2>
            <p className="text-xs text-white/30 mt-0.5">{format(day, "EEEE, MMMM d, yyyy")}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-white/[0.06] rounded-lg text-white/30 hover:text-white/60 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Time */}
          <div>
            <label className="text-xs font-medium text-white/40 mb-1.5 block">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-violet-500/50 transition-colors"
            />
          </div>

          {/* Accounts */}
          <div>
            <label className="text-xs font-medium text-white/40 mb-1.5 block">Post to</label>
            {accounts.length === 0 ? (
              <p className="text-sm text-white/30">No active accounts. <a href="/accounts" className="text-violet-400 hover:text-violet-300">Connect one first.</a></p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {accounts.map((acc) => (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() => toggleAccount(acc.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                      selectedAccounts.includes(acc.id)
                        ? "bg-violet-600 border-violet-600 text-white"
                        : "bg-white/[0.04] border-white/[0.07] text-white/40 hover:border-white/[0.15] hover:text-white/60"
                    }`}
                  >
                    <span>{platformIcon(acc.platform)}</span>
                    @{acc.username}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Content */}
          <div>
            <label className="text-xs font-medium text-white/40 mb-1.5 block">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="What do you want to share?"
              rows={4}
              maxLength={2200}
              className="w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80 resize-none outline-none focus:border-violet-500/50 placeholder:text-white/20 transition-colors"
            />
            <div className="flex items-center justify-between mt-1.5">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/60 px-2 py-1 rounded hover:bg-white/[0.05] transition-colors"
              >
                <ImagePlus size={12} />
                {uploading ? "Uploading…" : "Add Media"}
              </button>
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={uploadFile} />
              <span className={`text-xs font-mono ${content.length > 280 ? "text-amber-400" : "text-white/20"}`}>
                {content.length}/280
              </span>
            </div>
            {mediaUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {mediaUrls.map((url, i) => (
                  <div key={i} className="relative group">
                    <img src={url} alt="" className="w-14 h-14 object-cover rounded-lg border border-white/[0.08]" />
                    <button
                      onClick={() => setMediaUrls((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center hover-reveal transition-opacity"
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
              <AlertCircle size={13} className="flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => save("draft")}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-white/[0.05] border border-white/[0.07] text-white/60 rounded-xl text-sm font-medium hover:bg-white/[0.08] disabled:opacity-50 transition-colors"
            >
              <Save size={13} /> Save Draft
            </button>
            <button
              type="button"
              onClick={() => save("scheduled")}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {saving ? "Saving…" : "Schedule"}
            </button>
          </div>

          <p className="text-center text-xs text-white/20">
            Need more options?{" "}
            <Link href={`/compose?date=${format(day, "yyyy-MM-dd")}&time=${time}`} className="text-violet-400 hover:text-violet-300">
              Open full composer
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function CalendarPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [current, setCurrent] = useState(new Date());
  const [selected, setSelected] = useState<Date | null>(null);
  const [modalDay, setModalDay] = useState<Date | null>(null);

  function loadPosts() { safeFetch("/api/posts", undefined, []).then(setPosts); }

  useEffect(() => {
    loadPosts();
    safeFetch<Account[]>("/api/accounts", undefined, []).then((data) => setAccounts(data.filter((a) => a.isActive)));
  }, []);

  const monthStart = startOfMonth(current);
  const days = eachDayOfInterval({
    start: startOfWeek(monthStart, { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(current), { weekStartsOn: 1 }),
  });

  function postsForDay(day: Date) { return posts.filter((p) => isSameDay(new Date(p.post.scheduledAt), day)); }
  const selectedPosts = selected ? postsForDay(selected) : [];

  const monthPosts = posts.filter((p) => {
    const d = new Date(p.post.scheduledAt);
    return d.getMonth() === current.getMonth() && d.getFullYear() === current.getFullYear();
  });
  const monthStat = (s: string) => monthPosts.filter((p) => p.post.status === s).length;

  async function deletePost(id: number) {
    await fetch("/api/posts", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    loadPosts();
  }

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
        <PageHeader
          eyebrow="Calendar"
          title="Your schedule"
          description={
            <span className="flex items-center flex-wrap gap-x-3 gap-y-1">
              <span>{monthPosts.length} post{monthPosts.length !== 1 ? "s" : ""} in {format(current, "MMMM")}</span>
              {monthStat("scheduled") > 0 && <span className="text-sky-300/70">{monthStat("scheduled")} scheduled</span>}
              {monthStat("published") > 0 && <span className="text-emerald-300/70">{monthStat("published")} published</span>}
              {monthStat("failed") > 0 && <span className="text-rose-300/70">{monthStat("failed")} failed</span>}
            </span>
          }
          actions={
            <Link href="/compose" className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm font-semibold transition-colors shadow-[0_0_20px_rgba(51,92,186,0.25)] self-start">
              <Plus size={14} /> New Post
            </Link>
          }
        />

        <div className="bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
          {/* Month nav */}
          <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-white/[0.05]">
            <h2 className="font-semibold text-white/80 text-base">{format(current, "MMMM yyyy")}</h2>
            <div className="flex items-center gap-1">
              <button onClick={() => setCurrent(new Date())} className="px-2.5 py-1.5 mr-1 text-[11px] font-medium text-white/45 hover:text-white/75 hover:bg-white/[0.06] rounded-lg transition-colors">
                Today
              </button>
              <button onClick={() => setCurrent(subMonths(current, 1))} className="p-1.5 hover:bg-white/[0.06] rounded-lg text-white/40 hover:text-white/70 transition-colors">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setCurrent(addMonths(current, 1))} className="p-1.5 hover:bg-white/[0.06] rounded-lg text-white/40 hover:text-white/70 transition-colors">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Weekday labels */}
          <div className="grid grid-cols-7 border-b border-white/[0.04]">
            {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
              <div key={d} className="py-2.5 text-center text-[10px] font-semibold text-white/20 uppercase tracking-widest">{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const dayPosts = postsForDay(day);
              const isCurrentMonth = day.getMonth() === current.getMonth();
              const isSelected = selected && isSameDay(day, selected);
              const isToday = isSameDay(day, new Date());

              return (
                <button
                  key={day.toISOString()}
                  onClick={() => setSelected(isSelected ? null : day)}
                  className={`group min-h-[84px] sm:min-h-[96px] p-1.5 sm:p-2 text-left border-b border-r border-white/[0.04] transition-colors relative last:border-r-0 ${
                    isSelected ? "bg-violet-600/10 ring-1 ring-inset ring-violet-500/30" : "hover:bg-white/[0.025]"
                  } ${!isCurrentMonth ? "opacity-40" : ""} ${isToday ? "bg-violet-500/[0.04]" : ""}`}
                >
                  <div className="flex items-start justify-between mb-1">
                    <span className={`text-xs font-semibold w-6 h-6 flex items-center justify-center rounded-full tabular-nums ${
                      isToday ? "bg-violet-600 text-white shadow-[0_0_10px_rgba(51,92,186,0.5)]" : isCurrentMonth ? "text-white/55" : "text-white/30"
                    }`}>
                      {format(day, "d")}
                    </span>
                    {isCurrentMonth && (
                      <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); setModalDay(day); }}
                        className="hover-reveal transition-opacity w-5 h-5 flex items-center justify-center rounded-md bg-violet-600/20 hover:bg-violet-600/40 text-violet-300"
                      >
                        <Plus size={10} />
                      </span>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {dayPosts.slice(0, 3).map(({ post }) => (
                      <div
                        key={post.id}
                        className={`text-[9px] px-1.5 py-0.5 rounded truncate font-medium ${chipColor(post.status)}`}
                      >
                        {platformIcon(post.platform)} {post.content.slice(0, 16) || "post"}
                      </div>
                    ))}
                    {dayPosts.length > 3 && (
                      <div className="text-[9px] text-white/30 px-1 font-medium">+{dayPosts.length - 3} more</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected day panel */}
        {selected && (
          <div className="mt-4 bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.05] flex items-center justify-between">
              <span className="text-sm font-semibold text-white/70">
                {format(selected, "EEEE, MMMM d")}
                <span className="text-white/30 font-normal ml-1.5">
                  · {selectedPosts.length} post{selectedPosts.length !== 1 ? "s" : ""}
                </span>
              </span>
              <button
                onClick={() => setModalDay(selected)}
                className="flex items-center gap-1.5 text-xs font-medium text-violet-400 hover:text-violet-300 px-3 py-1.5 rounded-lg hover:bg-violet-500/10 transition-colors"
              >
                <Plus size={12} /> Schedule for this day
              </button>
            </div>

            {selectedPosts.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-white/25 text-sm mb-3">No posts scheduled for this day.</p>
                <button
                  onClick={() => setModalDay(selected)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  <Plus size={13} /> Schedule a post
                </button>
              </div>
            ) : (
              <div>
                {selectedPosts.map(({ post, account }) => (
                  <div key={post.id} className="flex items-center gap-3 px-5 py-3.5 border-b border-white/[0.04] hover:bg-white/[0.02] group transition-colors last:border-0">
                    <span className="text-base">{platformIcon(post.platform)}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white/65 truncate">{post.content}</p>
                      <p className="text-[11px] text-white/25 mt-0.5">
                        @{account?.username ?? "unknown"} · {format(new Date(post.scheduledAt), "HH:mm")}
                      </p>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium capitalize ${statusBadge(post.status)}`}>
                      {post.status}
                    </span>
                    <button
                      onClick={() => deletePost(post.id)}
                      className="hover-reveal transition-opacity p-1.5 text-white/25 hover:text-red-400 hover:bg-red-500/10 rounded-lg"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {modalDay && (
        <ScheduleModal
          day={modalDay}
          accounts={accounts}
          onClose={() => setModalDay(null)}
          onSaved={loadPosts}
        />
      )}
    </div>
  );
}
