"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { platformIcon, safeFetch } from "@/lib/utils";
import PageHeader from "@/components/PageHeader";
import Pagination, { usePagination } from "@/components/Pagination";
import {
  Calendar, PenSquare, RefreshCw, Pencil, Trash2,
  X, Save, RotateCcw, Users, Clock, CheckCircle2, AlertCircle,
  Film, Loader2, TrendingUp, ArrowUpRight,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

type Post = {
  post: {
    id: number; content: string; status: string; scheduledAt: string;
    platform: string; mediaUrls: string | null; metadata: string | null; errorMessage: string | null;
  };
  account: { username: string; avatarUrl: string | null } | null;
};
type Account = { id: number; platform: string; username: string };
type EditState = { id: number; content: string; scheduledAt: string; videoTitle: string };
type User = { name: string | null; email: string; plan: string | null };
type Filter = "all" | "scheduled" | "published" | "failed" | "draft";

function statusBadge(status: string) {
  const m: Record<string, string> = {
    scheduled: "bg-sky-500/10 text-sky-300 border border-sky-500/25",
    published:  "bg-emerald-500/10 text-emerald-300 border border-emerald-500/25",
    failed:     "bg-red-500/10 text-red-300 border border-red-500/25",
    draft:      "bg-white/[0.06] text-white/40 border border-white/[0.1]",
  };
  return m[status] ?? "bg-white/[0.06] text-white/40";
}

function DInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-violet-500/50 focus:bg-white/[0.07] transition-colors placeholder:text-white/20 ${className}`}
    />
  );
}

function DTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return (
    <textarea
      {...rest}
      className={`w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:border-violet-500/50 resize-none placeholder:text-white/20 ${className}`}
    />
  );
}

export default function Dashboard() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [running, setRunning] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    load();
    safeFetch("/api/accounts", undefined, []).then(setAccounts);
    fetch("/api/auth/me").then((r) => r.json()).then((d) => d?.email && setUser(d)).catch(() => {});
  }, []);

  async function load() {
    const data = await safeFetch("/api/posts", undefined, []);
    setPosts(data);
  }

  async function runNow() {
    setRunning(true);
    await fetch("/api/scheduler", { method: "POST" });
    await load();
    setRunning(false);
  }

  function openEdit(p: Post["post"]) {
    const meta = p.metadata ? JSON.parse(p.metadata) : {};
    setEditing({
      id: p.id,
      content: p.content,
      scheduledAt: format(new Date(p.scheduledAt), "yyyy-MM-dd'T'HH:mm"),
      videoTitle: meta.videoTitle ?? "",
    });
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    const post = posts.find((p) => p.post.id === editing.id);
    const meta = post?.post.metadata ? JSON.parse(post.post.metadata) : {};
    if (editing.videoTitle) meta.videoTitle = editing.videoTitle;
    const wasFailed = editingPost?.post.status === "failed";
    await fetch("/api/posts", {
      method: "PATCH",
      body: JSON.stringify({
        id: editing.id,
        content: editing.content,
        scheduledAt: new Date(editing.scheduledAt).toISOString(),
        metadata: Object.keys(meta).length ? JSON.stringify(meta) : undefined,
        ...(wasFailed && { status: "scheduled", errorMessage: null }),
      }),
      headers: { "Content-Type": "application/json" },
    });
    await load();
    setEditing(null);
    setSaving(false);
  }

  async function retryPost(id: number) {
    await fetch("/api/posts", {
      method: "PATCH",
      body: JSON.stringify({ id, status: "scheduled", errorMessage: null }),
      headers: { "Content-Type": "application/json" },
    });
    await load();
  }

  async function deletePost(id: number) {
    if (!confirm("Delete this post?")) return;
    setDeleting(id);
    await fetch("/api/posts", {
      method: "DELETE",
      body: JSON.stringify({ id }),
      headers: { "Content-Type": "application/json" },
    });
    setPosts((prev) => prev.filter((p) => p.post.id !== id));
    setDeleting(null);
  }

  const scheduled  = posts.filter((p) => p.post.status === "scheduled");
  const published  = posts.filter((p) => p.post.status === "published");
  const failed     = posts.filter((p) => p.post.status === "failed");
  const drafts     = posts.filter((p) => p.post.status === "draft");
  const editingPost = editing ? posts.find((p) => p.post.id === editing.id) : null;
  const isYoutube  = editingPost?.post.platform === "youtube";

  const visiblePosts = filter === "all" ? posts : posts.filter((p) => p.post.status === filter);
  const { pageItems: pagedPosts, ...pager } = usePagination(visiblePosts, 12);
  const nextPost = [...scheduled].sort(
    (a, b) => new Date(a.post.scheduledAt).getTime() - new Date(b.post.scheduledAt).getTime()
  )[0];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (user?.name?.split(" ")[0] || user?.email?.split("@")[0] || "").trim();

  const stats = [
    { label: "Accounts",  value: accounts.length,  icon: Users,        color: "text-violet-300", glow: "bg-violet-500/20" },
    { label: "Scheduled", value: scheduled.length, icon: Clock,        color: "text-sky-300",    glow: "bg-sky-500/20" },
    { label: "Published", value: published.length, icon: CheckCircle2, color: "text-emerald-300",glow: "bg-emerald-500/20" },
    { label: "Failed",    value: failed.length,    icon: AlertCircle,  color: "text-rose-300",   glow: "bg-rose-500/20" },
  ];

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: "all",       label: "All",       count: posts.length },
    { id: "scheduled", label: "Scheduled", count: scheduled.length },
    { id: "published", label: "Published", count: published.length },
    { id: "failed",    label: "Failed",    count: failed.length },
    { id: "draft",     label: "Drafts",    count: drafts.length },
  ];

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8">

        {/* Header */}
        <div className="anim-rise">
          <PageHeader
            eyebrow="Dashboard"
            title={<>{greeting}{firstName ? `, ${firstName}` : ""}<span className="text-violet-500">.</span></>}
            description={nextPost ? (
              <>Next post {formatDistanceToNow(new Date(nextPost.post.scheduledAt), { addSuffix: true })} · <span className="text-white/55">{format(new Date(nextPost.post.scheduledAt), "MMM d, HH:mm")}</span></>
            ) : (
              "Nothing scheduled — let's create something."
            )}
            actions={<>
              <button
                onClick={runNow}
                disabled={running}
                className="flex items-center gap-2 px-4 py-2 bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.09] text-white/70 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
              >
                <RefreshCw size={14} className={running ? "animate-spin" : ""} />
                {running ? "Publishing…" : "Run Scheduler"}
              </button>
              <Link
                href="/compose"
                className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm font-semibold transition-colors shadow-[0_0_24px_rgba(51,92,186,0.35)]"
              >
                <PenSquare size={14} /> New Post
              </Link>
            </>}
          />
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {stats.map(({ label, value, icon: Icon, color, glow }, i) => (
            <div
              key={label}
              className={`anim-rise d-${i + 1} relative overflow-hidden bg-gradient-to-br from-d16 to-d0e border border-white/[0.06] rounded-2xl p-5 hover:border-white/[0.12] transition-colors`}
            >
              <div className={`absolute -right-5 -top-5 w-20 h-20 rounded-full blur-2xl ${glow} pointer-events-none`} />
              <div className="relative">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] uppercase tracking-wider text-white/35 font-semibold">{label}</span>
                  <Icon size={15} className={color} />
                </div>
                <div className="text-3xl font-bold text-white/95 leading-none tabular-nums">{value}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Quick actions */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {[
            { href: "/compose",  label: "Compose Post",   desc: "Create and schedule content", icon: PenSquare, color: "text-violet-300", glow: "bg-violet-500/15", ring: "hover:border-violet-500/30" },
            { href: "/calendar", label: "View Calendar",  desc: "See your content schedule",   icon: Calendar,  color: "text-sky-300",    glow: "bg-sky-500/15",    ring: "hover:border-sky-500/30" },
            { href: "/analytics",label: "Analytics",      desc: "Track post performance",      icon: TrendingUp,color: "text-emerald-300",glow: "bg-emerald-500/15",ring: "hover:border-emerald-500/30" },
          ].map(({ href, label, desc, icon: Icon, color, glow, ring }, i) => (
            <Link
              key={href}
              href={href}
              className={`anim-rise d-${i + 3} group relative bg-d12 border border-white/[0.06] rounded-2xl p-5 hover:bg-d16 transition-all ${ring}`}
            >
              <ArrowUpRight size={15} className="absolute top-4 right-4 text-white/15 group-hover:text-violet-400 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
              <div className={`inline-flex p-2.5 rounded-xl mb-3 ${glow} group-hover:scale-110 transition-transform`}>
                <Icon size={17} className={color} />
              </div>
              <div className="font-display text-sm font-bold text-white/85 mb-0.5">{label}</div>
              <div className="text-xs text-white/30">{desc}</div>
            </Link>
          ))}
        </div>

        {/* Posts */}
        <div className="anim-rise d-5 bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
          <div className="px-4 sm:px-5 py-3 border-b border-white/[0.06] flex items-center gap-1.5 overflow-x-auto">
            {filters.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  filter === f.id
                    ? "bg-violet-600/15 text-violet-300 border border-violet-500/25"
                    : "text-white/35 hover:text-white/60 hover:bg-white/[0.04] border border-transparent"
                }`}
              >
                {f.label}
                <span className={`text-[10px] tabular-nums px-1.5 py-px rounded-full ${filter === f.id ? "bg-violet-500/25 text-violet-200" : "bg-white/[0.06] text-white/30"}`}>
                  {f.count}
                </span>
              </button>
            ))}
          </div>

          {posts.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4">
                <Film size={28} className="text-white/15" />
              </div>
              <p className="text-white/30 text-sm mb-1 font-medium">No posts yet</p>
              <p className="text-white/15 text-xs mb-4">Create your first scheduled post to get started</p>
              <Link
                href="/compose"
                className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <PenSquare size={13} /> Create Post
              </Link>
            </div>
          ) : visiblePosts.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-white/25 text-sm">No {filter} posts.</p>
            </div>
          ) : (
            <div>
              {pagedPosts.map(({ post, account }) => {
                const mediaList: string[] = post.mediaUrls ? JSON.parse(post.mediaUrls) : [];
                const hasVideo = mediaList.some((u) => /\.(mp4|mov|webm)/i.test(u));
                return (
                  <div
                    key={post.id}
                    className="flex items-center gap-3 px-4 sm:px-5 py-3.5 border-b border-white/[0.04] hover:bg-white/[0.02] group transition-colors last:border-0"
                  >
                    {/* Avatar with platform badge */}
                    <div className="relative flex-shrink-0">
                      {account?.avatarUrl ? (
                        <img src={account.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover border border-white/[0.08]" />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center text-sm">
                          {platformIcon(post.platform)}
                        </div>
                      )}
                      <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-d12 flex items-center justify-center text-[9px] leading-none">
                        {platformIcon(post.platform)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white/70 truncate">
                        {post.content || (hasVideo ? "📹 Video post" : "(no caption)")}
                      </p>
                      <p className="text-[11px] text-white/25 mt-0.5">
                        @{account?.username ?? "unknown"} · {format(new Date(post.scheduledAt), "MMM d, yyyy HH:mm")}
                      </p>
                      {post.status === "failed" && post.errorMessage && (
                        <p className="text-[11px] text-red-400/70 mt-0.5 truncate">
                          ✕ {post.errorMessage}
                        </p>
                      )}
                    </div>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full flex-shrink-0 capitalize ${statusBadge(post.status)}`}>
                      {post.status}
                    </span>
                    <div className="flex items-center gap-0.5 hover-reveal transition-opacity flex-shrink-0">
                      {post.status === "failed" && (
                        <button
                          onClick={() => retryPost(post.id)}
                          className="p-1.5 text-white/25 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors"
                          title="Retry"
                        >
                          <RotateCcw size={13} />
                        </button>
                      )}
                      {(post.status === "scheduled" || post.status === "draft" || post.status === "failed") && (
                        <button
                          onClick={() => openEdit(post)}
                          className="p-1.5 text-white/25 hover:text-violet-400 hover:bg-violet-500/10 rounded-lg transition-colors"
                          title="Edit"
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => deletePost(post.id)}
                        disabled={deleting === post.id}
                        className="p-1.5 text-white/25 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40"
                        title="Delete"
                      >
                        {deleting === post.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </div>
                );
              })}
              <Pagination pager={pager} />
            </div>
          )}
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-d14 border border-white/[0.08] rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
              <div className="flex items-center gap-2.5">
                <span className="text-lg">{platformIcon(editingPost?.post.platform ?? "")}</span>
                <h2 className="font-semibold text-white/80 text-sm">Edit Post</h2>
              </div>
              <button onClick={() => setEditing(null)} className="p-1.5 text-white/30 hover:text-white/60 rounded-lg hover:bg-white/[0.06] transition-colors">
                <X size={16} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {isYoutube && (
                <div>
                  <label className="block text-xs font-medium text-white/40 mb-1.5">Video Title</label>
                  <DInput
                    type="text"
                    value={editing.videoTitle}
                    onChange={(e) => setEditing((s) => s && ({ ...s, videoTitle: e.target.value }))}
                    maxLength={100}
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-white/40 mb-1.5">
                  {isYoutube ? "Description / Caption" : "Content"}
                </label>
                <DTextarea
                  rows={5}
                  value={editing.content}
                  onChange={(e) => setEditing((s) => s && ({ ...s, content: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-white/40 mb-1.5">Scheduled for</label>
                <DInput
                  type="datetime-local"
                  value={editing.scheduledAt}
                  onChange={(e) => setEditing((s) => s && ({ ...s, scheduledAt: e.target.value }))}
                  className="w-auto"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2.5 px-5 py-4 border-t border-white/[0.06]">
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 text-sm text-white/50 bg-white/[0.05] border border-white/[0.07] rounded-lg hover:bg-white/[0.08] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-lg disabled:opacity-50 font-medium transition-colors"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
