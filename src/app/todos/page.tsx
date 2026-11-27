"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ListTodo, Plus, Trash2, Check, Circle, Film, Link as LinkIcon, Loader2, ArrowRight,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import Pagination, { usePagination } from "@/components/Pagination";

type Todo = {
  id: number;
  title: string | null;
  url: string | null;
  note: string | null;
  done: boolean;
  createdAt: string | null;
};

const URL_RE = /^(https?:\/\/|www\.)/i;
const isUrl = (s: string) => URL_RE.test(s.trim());

export default function TodosPage() {
  const router = useRouter();
  const [todos, setTodos]   = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText]     = useState("");
  const [note, setNote]     = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetch("/api/todos")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Todo[]) => setTodos(Array.isArray(rows) ? rows : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value && !note.trim()) return;

    const body = isUrl(value)
      ? { url: value, note: note.trim() }
      : { title: value, note: note.trim() };

    setAdding(true);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const row: Todo = await res.json();
        setTodos((prev) => [row, ...prev]);
        setText(""); setNote("");
      }
    } finally {
      setAdding(false);
    }
  }

  async function toggle(t: Todo) {
    setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)));
    await fetch("/api/todos", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, done: !t.done }),
    });
  }

  async function remove(id: number) {
    setTodos((prev) => prev.filter((x) => x.id !== id));
    await fetch("/api/todos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  function openInClips(url: string) {
    router.push(`/clips?url=${encodeURIComponent(url)}`);
  }

  const pending = todos.filter((t) => !t.done);
  const done    = todos.filter((t) => t.done);

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-2xl mx-auto px-4 sm:px-8 py-6 sm:py-8">

        {/* Header */}
        <PageHeader
          eyebrow="To-Do"
          title="Your queue"
          description="Queue clip links and tasks, then jump straight into the editor."
        />

        {/* Stat cards */}
        {todos.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            {[
              { label: "To do",  value: pending.length, icon: ListTodo, color: "text-violet-300", glow: "bg-violet-500/20" },
              { label: "Links",  value: todos.filter((t) => t.url).length, icon: LinkIcon, color: "text-sky-300", glow: "bg-sky-500/20" },
              { label: "Done",   value: done.length,    icon: Check,    color: "text-emerald-300", glow: "bg-emerald-500/20" },
            ].map(({ label, value, icon: Icon, color, glow }) => (
              <div
                key={label}
                className="relative overflow-hidden bg-gradient-to-br from-d16 to-d0e border border-white/[0.06] rounded-2xl p-4 hover:border-white/[0.12] transition-colors"
              >
                <div className={`absolute -right-5 -top-5 w-16 h-16 rounded-full blur-2xl ${glow} pointer-events-none`} />
                <div className="relative">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] uppercase tracking-wider text-white/35 font-semibold">{label}</span>
                    <Icon size={14} className={color} />
                  </div>
                  <div className="text-2xl font-bold text-white/95 leading-none tabular-nums">{value}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add form */}
        <form onSubmit={addTodo} className="bg-d12 border border-white/[0.06] rounded-2xl p-3 mb-6 space-y-2">
          <div className="flex items-center gap-2 bg-black/30 border border-white/[0.07] rounded-lg px-3 focus-within:border-violet-500/35 transition-colors">
            {isUrl(text) ? <LinkIcon size={13} className="text-violet-400/60 flex-shrink-0" /> : <Plus size={13} className="text-white/25 flex-shrink-0" />}
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste a clip link, or type a task…"
              className="flex-1 bg-transparent py-2.5 text-sm text-white/80 placeholder:text-white/20 outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional note (e.g. trim to 30s, add caption)…"
              className="flex-1 bg-black/20 border border-white/[0.05] rounded-lg px-3 py-2 text-xs text-white/65 placeholder:text-white/15 outline-none focus:border-violet-500/30 transition-colors"
            />
            <button
              type="submit"
              disabled={adding || (!text.trim() && !note.trim())}
              className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-lg text-sm font-semibold transition-colors flex-shrink-0"
            >
              {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />} Add
            </button>
          </div>
        </form>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 size={20} className="animate-spin text-white/20" /></div>
        ) : todos.length === 0 ? (
          <div className="text-center py-16">
            <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4">
              <ListTodo size={28} className="text-white/15" />
            </div>
            <p className="text-white/30 font-medium text-sm mb-1">Nothing queued yet</p>
            <p className="text-white/15 text-xs">Drop a clip link above to come back to it later.</p>
          </div>
        ) : (
          <div className="space-y-5">
            <TodoList rows={pending} onToggle={toggle} onRemove={remove} onOpen={openInClips} />

            {done.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wider font-semibold text-white/20 mb-2 px-1">
                  Done · {done.length}
                </p>
                <TodoList rows={done} onToggle={toggle} onRemove={remove} onOpen={openInClips} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TodoList({
  rows, onToggle, onRemove, onOpen,
}: {
  rows: Todo[];
  onToggle: (t: Todo) => void;
  onRemove: (id: number) => void;
  onOpen: (url: string) => void;
}) {
  const { pageItems, ...pager } = usePagination(rows, 12);
  if (rows.length === 0) return null;
  return (
    <div className="bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
      {pageItems.map((t) => (
        <div key={t.id} className="group flex items-start gap-3 px-4 py-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
          <button
            onClick={() => onToggle(t)}
            className="mt-0.5 flex-shrink-0 transition-colors"
            title={t.done ? "Mark as not done" : "Mark as done"}
          >
            {t.done
              ? <Check size={17} className="text-green-400" />
              : <Circle size={17} className="text-white/20 hover:text-violet-400" />}
          </button>

          <div className="flex-1 min-w-0">
            {t.url ? (
              <a href={t.url} target="_blank" rel="noopener noreferrer"
                className={`text-sm font-medium break-all hover:underline ${t.done ? "text-white/30 line-through" : "text-violet-300/90"}`}>
                {t.title || t.url}
              </a>
            ) : (
              <p className={`text-sm font-medium break-words ${t.done ? "text-white/30 line-through" : "text-white/80"}`}>
                {t.title}
              </p>
            )}
            {t.note && (
              <p className={`text-xs mt-0.5 break-words ${t.done ? "text-white/15" : "text-white/35"}`}>{t.note}</p>
            )}
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {t.url && (
              <button
                onClick={() => onOpen(t.url!)}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/25 text-violet-300 rounded-lg text-[11px] font-semibold transition-colors"
                title="Open in the clip editor"
              >
                <Film size={12} /> <span className="hidden sm:inline">Open in Clips</span> <ArrowRight size={11} />
              </button>
            )}
            <button
              onClick={() => onRemove(t.id)}
              className="p-1.5 text-white/20 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors hover-reveal"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      <Pagination pager={pager} />
    </div>
  );
}
