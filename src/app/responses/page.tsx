"use client";
import React, { useEffect, useRef, useState } from "react";
import { safeFetch } from "@/lib/utils";
import PageHeader from "@/components/PageHeader";
import Pagination, { usePagination } from "@/components/Pagination";
import {
  Plus, Trash2, Power, Bot, Check, Hash, MessageSquare,
  Loader2, AlertCircle, X, Clock, Zap,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import EmojiPicker, { insertEmoji } from "@/components/EmojiPicker";

type Account = { id: number; platform: string; username: string };
type AutoResponse = {
  id: number;
  accountId: number;
  triggerKeyword: string | null;
  responseTemplate: string;
  respondToComments: boolean;
  respondToLikes: boolean;
  isActive: boolean;
  lastCheckedAt: string | null;
  account?: { username: string; platform: string };
};

const PLATFORM: Record<string, {
  label: string; icon: string;
  bg: string; text: string; border: string; dot: string;
  leftColor: string;
}> = {
  youtube:   { label: "YouTube",   icon: "▶",  bg: "bg-red-500/10",   text: "text-red-300",   border: "border-red-500/20",   dot: "bg-red-400",   leftColor: "rgba(239,68,68,0.45)"   },
  instagram: { label: "Instagram", icon: "📸", bg: "bg-pink-500/10",  text: "text-pink-300",  border: "border-pink-500/20",  dot: "bg-pink-400",  leftColor: "rgba(236,72,153,0.45)"  },
  twitter:   { label: "Twitter",   icon: "𝕏",  bg: "bg-sky-500/10",   text: "text-sky-300",   border: "border-sky-500/20",   dot: "bg-sky-400",   leftColor: "rgba(14,165,233,0.45)"  },
  tiktok:    { label: "TikTok",    icon: "♪",  bg: "bg-white/[0.06]", text: "text-white/50",  border: "border-white/[0.08]", dot: "bg-white/40",  leftColor: "rgba(255,255,255,0.12)" },
};
const fallbackPlatform = PLATFORM.tiktok;

function DInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80
        outline-none focus:border-violet-500/50 focus:bg-white/[0.07]
        transition-colors placeholder:text-white/20 ${className}`}
    />
  );
}

function DSelect({ className = "", children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...rest}
      className={`w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/70
        outline-none focus:border-violet-500/50 transition-colors ${className}`}
    >
      {children}
    </select>
  );
}

const DTextarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function DTextarea({ className = "", ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        {...rest}
        className={`w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80
          outline-none focus:border-violet-500/50 focus:bg-white/[0.07]
          transition-colors placeholder:text-white/20 resize-none ${className}`}
      />
    );
  }
);

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200
        ${checked ? "bg-violet-600" : "bg-white/[0.10]"}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200
        ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}

const EMPTY_FORM = {
  accountId: "",
  triggerKeyword: "",
  responseTemplate: "",
  respondToComments: true,
  respondToLikes: false,
};

export default function ResponsesPage() {
  const [accounts, setAccounts]     = useState<Account[]>([]);
  const [responses, setResponses]   = useState<AutoResponse[]>([]);
  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [formError, setFormError]   = useState("");
  const [saving, setSaving]         = useState(false);
  const [running, setRunning]       = useState(false);
  const templateRef                 = useRef<HTMLTextAreaElement>(null);
  const [runResult, setRunResult]   = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    safeFetch<Account[]>("/api/accounts", undefined, []).then(setAccounts);
    safeFetch<AutoResponse[]>("/api/responses", undefined, []).then(setResponses);
  }, []);

  async function runNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const res  = await fetch("/api/auto-respond", { method: "POST" });
      const data = await res.json() as { ok?: boolean; error?: string; checked?: number; replied?: number };
      if (!res.ok) throw new Error(data.error ?? "Failed");

      const updated = await safeFetch<AutoResponse[]>("/api/responses", undefined, []);
      setResponses(updated);

      const c = data.checked ?? 0;
      const r = data.replied ?? 0;
      const msg = `Checked ${c} comment${c !== 1 ? "s" : ""} · sent ${r} repl${r !== 1 ? "ies" : "y"}`;
      setRunResult({ ok: true, msg });
      setTimeout(() => setRunResult(null), 6000);
    } catch (e) {
      setRunResult({ ok: false, msg: e instanceof Error ? e.message : "Run failed" });
    }
    setRunning(false);
  }

  async function add() {
    setFormError("");
    if (!form.accountId) { setFormError("Please select an account."); return; }
    if (!form.responseTemplate.trim()) { setFormError("Response template is required."); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/responses", {
        method: "POST",
        body: JSON.stringify({ ...form, accountId: Number(form.accountId) }),
        headers: { "Content-Type": "application/json" },
      });
      const row = await res.json();
      if (!res.ok) throw new Error(row.error ?? "Failed to save");
      setResponses((prev) => [...prev, row]);
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to save");
    }
    setSaving(false);
  }

  async function remove(id: number) {
    setResponses((prev) => prev.filter((r) => r.id !== id));
    await fetch("/api/responses", { method: "DELETE", body: JSON.stringify({ id }), headers: { "Content-Type": "application/json" } });
  }

  async function toggle(id: number, isActive: boolean) {
    setResponses((prev) => prev.map((r) => r.id === id ? { ...r, isActive: !isActive } : r));
    await fetch("/api/responses", { method: "PATCH", body: JSON.stringify({ id, isActive: !isActive }), headers: { "Content-Type": "application/json" } });
  }

  const activeCount  = responses.filter((r) => r.isActive).length;
  const platforms    = [...new Set(responses.map((r) => r.account?.platform).filter(Boolean) as string[])];
  const { pageItems: pagedRules, ...pager } = usePagination(responses, 12);
  const charCount    = form.responseTemplate.length;
  const charWarning  = charCount > 400;

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-8">

        {/* ── Header ── */}
        <PageHeader
          eyebrow="Auto-Respond"
          title="Reply on autopilot"
          description="Auto-reply to new comments on your published posts."
          actions={<>
            <button
              onClick={runNow}
              disabled={running}
              className="flex items-center gap-2 px-4 py-2 bg-white/[0.06] hover:bg-white/[0.09]
                border border-white/[0.08] text-white/70 rounded-lg text-sm font-medium
                transition-colors disabled:opacity-40"
            >
              {running
                ? <><Loader2 size={14} className="animate-spin" /> Running…</>
                : <><Zap size={14} /> Run Now</>
              }
            </button>

            <button
              onClick={() => { setShowForm((v) => !v); setFormError(""); if (showForm) setForm(EMPTY_FORM); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                ${showForm
                  ? "bg-white/[0.06] border border-white/[0.08] text-white/70 hover:bg-white/[0.09]"
                  : "bg-violet-600 hover:bg-violet-500 text-white"
                }`}
            >
              {showForm ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New Rule</>}
            </button>
          </>}
        />

        {/* ── Run result ── */}
        {runResult && (
          <div className={`flex items-center gap-2 mb-5 px-4 py-3 rounded-xl text-sm font-medium border
            ${runResult.ok
              ? "bg-green-500/10 border-green-500/20 text-green-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"}`}
          >
            {runResult.ok ? <Check size={14} className="flex-shrink-0" /> : <AlertCircle size={14} className="flex-shrink-0" />}
            {runResult.msg}
          </div>
        )}

        {/* ── Stat cards ── */}
        {responses.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            {[
              { label: "Active",    value: activeCount,      icon: Power, color: "text-emerald-300", glow: "bg-emerald-500/20" },
              { label: "Rules",     value: responses.length, icon: Bot,   color: "text-violet-300",  glow: "bg-violet-500/20" },
              { label: "Platforms", value: platforms.length, icon: Hash,  color: "text-sky-300",     glow: "bg-sky-500/20" },
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

        {/* ── New rule form ── */}
        {showForm && (
          <div className="mb-6 bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/[0.05] flex items-center gap-2">
              <Plus size={14} className="text-violet-400" />
              <span className="text-sm font-semibold text-white/70">New Auto-Response Rule</span>
            </div>

            <div className="px-5 py-5 space-y-4">
              {/* Account + keyword row */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-white/40 block mb-1.5">Account</label>
                  <DSelect
                    value={form.accountId}
                    onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))}
                  >
                    <option value="">Select account…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        @{a.username} ({a.platform})
                      </option>
                    ))}
                  </DSelect>
                </div>

                <div>
                  <label className="text-xs font-medium text-white/40 block mb-1.5">
                    Trigger Keyword <span className="text-white/20 font-normal">— optional</span>
                  </label>
                  <DInput
                    type="text"
                    placeholder="e.g. price, link, collab…"
                    value={form.triggerKeyword}
                    onChange={(e) => setForm((f) => ({ ...f, triggerKeyword: e.target.value }))}
                  />
                </div>
              </div>

              {/* Response template */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-white/40">Response Template</label>
                  <div className="flex items-center gap-2">
                    <EmojiPicker
                      onSelect={(emoji) =>
                        insertEmoji(
                          templateRef.current,
                          form.responseTemplate,
                          emoji,
                          (v) => setForm((f) => ({ ...f, responseTemplate: v }))
                        )
                      }
                    />
                    <span className={`text-xs font-mono tabular-nums transition-colors ${charWarning ? "text-amber-400/70" : "text-white/20"}`}>
                      {charCount}/500
                    </span>
                  </div>
                </div>
                <DTextarea
                  ref={templateRef}
                  rows={3}
                  maxLength={500}
                  placeholder="Thanks for your comment! Check the link in bio for more 🙌"
                  value={form.responseTemplate}
                  onChange={(e) => setForm((f) => ({ ...f, responseTemplate: e.target.value }))}
                />
              </div>

              {/* Toggles */}
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-white/40 cursor-pointer select-none">
                  <Toggle checked={form.respondToComments} onChange={(v) => setForm((f) => ({ ...f, respondToComments: v }))} />
                  Reply to comments
                </label>
                <label className="flex items-center gap-2 text-sm text-white/40 cursor-pointer select-none">
                  <Toggle checked={form.respondToLikes} onChange={(v) => setForm((f) => ({ ...f, respondToLikes: v }))} />
                  Track likes
                </label>
              </div>

              {/* Hint */}
              <p className="text-xs text-white/20 leading-relaxed">
                Leave keyword blank to reply to every new comment. Only comments posted <em>after</em> this rule is created will get a reply.
              </p>

              {formError && (
                <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
                  <AlertCircle size={14} className="flex-shrink-0" />
                  {formError}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={add}
                  disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40
                    text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {saving ? "Saving…" : "Add Rule"}
                </button>
                <button
                  onClick={() => { setShowForm(false); setFormError(""); setForm(EMPTY_FORM); }}
                  className="px-3 py-2 text-white/30 hover:text-white/60 text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Rules list ── */}
        {responses.length === 0 ? (
          <div className="bg-d12 border border-white/[0.06] rounded-2xl">
            <div className="px-6 py-16 text-center">
              <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4 border border-white/[0.05]">
                <Bot size={28} className="text-white/10" />
              </div>
              <p className="text-white/40 text-sm font-semibold mb-1">No rules yet</p>
              <p className="text-white/20 text-xs max-w-xs mx-auto leading-relaxed mb-5">
                Create a rule to automatically reply to new comments on your published posts.
              </p>
              <div className="flex items-center justify-center gap-2 mb-5">
                {["youtube", "instagram"].map((pl) => {
                  const pc = PLATFORM[pl];
                  return (
                    <span key={pl} className={`text-xs font-medium px-2.5 py-1 rounded-lg border ${pc.bg} ${pc.text} ${pc.border}`}>
                      {pc.icon} {pc.label}
                    </span>
                  );
                })}
              </div>
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500
                  text-white rounded-lg text-sm font-medium transition-colors"
              >
                <Plus size={14} /> Create First Rule
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
            {pagedRules.map((r, i) => {
              const platform = r.account?.platform ?? "";
              const pc = PLATFORM[platform] ?? fallbackPlatform;

              return (
                <div
                  key={r.id}
                  className={`border-l-2 transition-colors hover:bg-white/[0.02] ${
                    i !== 0 ? "border-t border-white/[0.05]" : ""
                  }`}
                  style={{ borderLeftColor: pc.leftColor }}
                >
                  <div className="px-5 py-4 flex items-center gap-4">
                    {/* Left: platform + account + trigger */}
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-lg border flex-shrink-0 ${pc.bg} ${pc.text} ${pc.border}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${pc.dot}`} />
                        {pc.label}
                      </span>

                      <span className="text-sm font-medium text-white/60 truncate">
                        @{r.account?.username ?? "unknown"}
                      </span>

                      {r.triggerKeyword ? (
                        <span className="inline-flex items-center gap-1 text-xs bg-amber-500/10 text-amber-400/80 border border-amber-500/20 px-2 py-0.5 rounded-lg flex-shrink-0">
                          <Hash size={10} />
                          {r.triggerKeyword}
                        </span>
                      ) : (
                        <span className="text-xs text-white/25 bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-lg flex-shrink-0">
                          all comments
                        </span>
                      )}
                    </div>

                    {/* Middle: response template */}
                    <div className="flex items-center gap-2 flex-1 min-w-0 hidden sm:flex">
                      <MessageSquare size={12} className="text-white/15 flex-shrink-0" />
                      <p className="text-xs text-white/35 truncate italic">
                        &ldquo;{r.responseTemplate}&rdquo;
                      </p>
                    </div>

                    {/* Right: status + last check + controls */}
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="flex items-center gap-1 text-xs text-white/25 hidden md:flex">
                        <Clock size={11} />
                        {r.lastCheckedAt
                          ? formatDistanceToNow(new Date(r.lastCheckedAt), { addSuffix: true })
                          : "never"}
                      </span>

                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
                        r.isActive
                          ? "bg-green-500/10 text-green-400 border-green-500/20"
                          : "bg-white/[0.05] text-white/25 border-white/[0.08]"
                      }`}>
                        {r.isActive ? "Active" : "Paused"}
                      </span>

                      <button
                        onClick={() => toggle(r.id, r.isActive)}
                        title={r.isActive ? "Pause" : "Activate"}
                        className="p-1.5 text-white/25 hover:text-violet-300 rounded-lg hover:bg-violet-500/10 transition-colors"
                      >
                        <Power size={14} />
                      </button>
                      <button
                        onClick={() => remove(r.id)}
                        title="Delete rule"
                        className="p-1.5 text-white/25 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            <Pagination pager={pager} />
          </div>
        )}

        {/* ── Footer note ── */}
        <p className="flex items-center justify-center gap-1.5 text-xs text-white/20 text-center mt-6">
          <Zap size={11} />
          Runs every minute via the scheduler ·{" "}
          <code className="font-mono text-white/30">node scheduler-daemon.mjs</code>
        </p>

      </div>
    </div>
  );
}
