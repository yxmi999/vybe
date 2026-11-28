"use client";
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { safeFetch } from "@/lib/utils";
import PageHeader from "@/components/PageHeader";
import Pagination, { usePagination } from "@/components/Pagination";
import {
  Plus, Trash2, Power, Bot, Check, Hash, MessageSquare, Pencil, Send, Activity,
  Loader2, AlertCircle, X, Clock, Zap, FlaskConical, ShieldCheck, AlertTriangle, CornerDownRight, Info,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import EmojiPicker, { insertEmoji } from "@/components/EmojiPicker";
import {
  AUTO_REPLY_PLATFORMS, MAX_REPLIES_PER_RUN, MAX_REPLIES_PER_DAY, MAX_TEMPLATE_LENGTH, POST_WINDOW_DAYS,
  parseKeywords, splitVariants, joinVariants, renderReply, pickRule, pickVariant, parseDbTime,
} from "@/lib/auto-reply";

type Account = { id: number; platform: string; username: string; isActive?: boolean };
type AutoResponse = {
  id: number;
  accountId: number;
  triggerKeyword: string | null;
  responseTemplate: string;
  respondToComments: boolean;
  isActive: boolean;
  lastCheckedAt: string | null;
  repliesSent: number | null;
  lastReplyAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  account?: { username: string; platform: string; isActive?: boolean };
};
type LogRow = {
  id: number; ruleId: number | null; commentAuthor: string | null; commentText: string | null; replyText: string | null;
  status: "pending" | "sent" | "failed"; error: string | null; createdAt: string | null;
  platform: string; username: string; postContent: string | null;
};

const PLATFORM: Record<string, { label: string; bg: string; text: string; border: string; dot: string; leftColor: string }> = {
  youtube:   { label: "YouTube",   bg: "bg-red-500/10",   text: "text-red-300",  border: "border-red-500/20",   dot: "bg-red-400",  leftColor: "rgba(239,68,68,0.45)" },
  instagram: { label: "Instagram", bg: "bg-pink-500/10",  text: "text-pink-300", border: "border-pink-500/20",  dot: "bg-pink-400", leftColor: "rgba(236,72,153,0.45)" },
  twitter:   { label: "X",         bg: "bg-sky-500/10",   text: "text-sky-300",  border: "border-sky-500/20",   dot: "bg-sky-400",  leftColor: "rgba(14,165,233,0.45)" },
  tiktok:    { label: "TikTok",    bg: "bg-white/[0.06]", text: "text-white/50", border: "border-white/[0.08]", dot: "bg-white/40", leftColor: "rgba(255,255,255,0.12)" },
};
const fallbackPlatform = PLATFORM.tiktok;
const supported = (p: string) => (AUTO_REPLY_PLATFORMS as readonly string[]).includes(p);
const ago = (s: string | null | undefined) => {
  const t = parseDbTime(s);
  return t ? formatDistanceToNow(new Date(t), { addSuffix: true }) : "never";
};

const inputCls = `w-full bg-white/[0.05] border border-white/[0.07] rounded-lg px-3 py-2 text-sm text-white/80
  outline-none focus:border-violet-500/50 focus:bg-white/[0.07] transition-colors placeholder:text-white/20`;

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors duration-200 ${checked ? "bg-violet-600" : "bg-white/[0.10]"}`}>
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

// ── Keyword chips ────────────────────────────────────────────────────────────

function KeywordInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState("");
  function commit(raw: string) {
    const next = parseKeywords([...value, ...raw.split(",")].join(","));
    if (next.length !== value.length) onChange(next.slice(0, 20));
    setText("");
  }
  return (
    <div className={`${inputCls} flex flex-wrap items-center gap-1.5 min-h-[38px] py-1.5`}>
      {value.map((k) => (
        <span key={k} className="inline-flex items-center gap-1 text-xs bg-amber-500/10 text-amber-300/90 border border-amber-500/20 pl-2 pr-1 py-0.5 rounded-md">
          {k}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== k))} aria-label={`Remove ${k}`} className="p-0.5 rounded hover:bg-amber-500/20">
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => (e.target.value.includes(",") ? commit(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(text); }
          if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text.trim() && commit(text)}
        placeholder={value.length ? "Add another…" : "price, link, collab… (Enter to add)"}
        className="flex-1 min-w-[120px] bg-transparent outline-none text-sm placeholder:text-white/20"
      />
    </div>
  );
}

// ── Rule form (create + edit) ────────────────────────────────────────────────

type Form = { accountId: string; keywords: string[]; variants: string[]; respondToComments: boolean };
const EMPTY_FORM: Form = { accountId: "", keywords: [], variants: [""], respondToComments: true };

function RuleForm({ accounts, initial, editing, onCancel, onSaved }: {
  accounts: Account[];
  initial: Form;
  editing: AutoResponse | null;
  onCancel: () => void;
  onSaved: (row: AutoResponse) => void;
}) {
  const [form, setForm] = useState<Form>(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(0);
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const setVariant = (i: number, v: string) => setForm((f) => ({ ...f, variants: f.variants.map((x, j) => (j === i ? v : x)) }));
  const insertAtCursor = (token: string) => insertEmoji(refs.current[focused] ?? null, form.variants[focused] ?? "", token, (v) => setVariant(focused, v));

  async function save() {
    setError("");
    if (!editing && !form.accountId) { setError("Pick an account."); return; }
    if (!form.variants.some((v) => v.trim())) { setError("Write at least one reply."); return; }
    setSaving(true);
    try {
      const body = {
        triggerKeyword: form.keywords.join(", "),
        responseTemplate: joinVariants(form.variants),
        respondToComments: form.respondToComments,
      };
      const res = await fetch("/api/responses", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...body } : { ...body, accountId: Number(form.accountId) }),
      });
      const row = await res.json();
      if (!res.ok) throw new Error(row.error ?? "Failed to save");
      onSaved(editing ? { ...editing, ...row, account: editing.account } : row);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    }
    setSaving(false);
  }

  const sample = form.variants.find((v) => v.trim()) ?? "";

  return (
    <div className="mb-6 bg-d12 border border-violet-500/20 rounded-2xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-white/[0.05] flex items-center gap-2">
        {editing ? <Pencil size={14} className="text-violet-400" /> : <Plus size={14} className="text-violet-400" />}
        <span className="text-sm font-semibold text-white/70">{editing ? `Edit rule · @${editing.account?.username}` : "New auto-reply rule"}</span>
      </div>

      <div className="px-5 py-5 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-white/40 block mb-1.5" htmlFor="rule-account">Account</label>
            {editing ? (
              <div className={`${inputCls} text-white/50`}>@{editing.account?.username} ({editing.account?.platform})</div>
            ) : (
              <select id="rule-account" className={inputCls} value={form.accountId} onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))}>
                <option value="">Select account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id} disabled={!supported(a.platform)} className="bg-d12">
                    @{a.username} ({a.platform}){supported(a.platform) ? "" : " — not supported yet"}
                  </option>
                ))}
              </select>
            )}
            {!editing && accounts.length > 0 && !accounts.some((a) => supported(a.platform)) && (
              <p className="text-[11px] text-amber-300/70 mt-1.5">
                Auto-replies work on YouTube and Instagram. <Link href="/accounts" className="underline">Connect one</Link>.
              </p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-white/40 block mb-1.5">
              Trigger keywords <span className="text-white/20 font-normal">— empty = every comment</span>
            </label>
            <KeywordInput value={form.keywords} onChange={(keywords) => setForm((f) => ({ ...f, keywords }))} />
          </div>
        </div>

        {/* Reply variations */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-white/40">
              Reply {form.variants.length > 1 && <span className="text-white/20 font-normal">— one picked per comment</span>}
            </label>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => insertAtCursor("{name}")}
                className="text-[11px] font-mono px-2 py-1 rounded-md bg-white/[0.05] border border-white/[0.07] text-violet-300/80 hover:bg-white/[0.09]"
                title="Insert the commenter's name">
                {"{name}"}
              </button>
              <EmojiPicker onSelect={(emoji) => insertAtCursor(emoji)} />
            </div>
          </div>
          {form.variants.map((v, i) => (
            <div key={i} className="relative">
              <textarea
                ref={(el) => { refs.current[i] = el; }}
                rows={2}
                maxLength={MAX_TEMPLATE_LENGTH}
                value={v}
                onFocus={() => setFocused(i)}
                onChange={(e) => setVariant(i, e.target.value)}
                placeholder={i === 0 ? "Thanks {name}! Check the link in bio for more 🙌" : "Another way to say it, so replies don't look copy-pasted"}
                aria-label={`Reply variation ${i + 1}`}
                className={`${inputCls} resize-none pr-16`}
              />
              <div className="absolute right-2 top-2 flex items-center gap-1">
                <span className={`text-[10px] font-mono tabular-nums ${v.length > MAX_TEMPLATE_LENGTH * 0.8 ? "text-amber-400/70" : "text-white/20"}`}>
                  {v.length}/{MAX_TEMPLATE_LENGTH}
                </span>
                {form.variants.length > 1 && (
                  <button type="button" aria-label={`Remove variation ${i + 1}`}
                    onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, j) => j !== i) }))}
                    className="p-0.5 rounded text-white/25 hover:text-red-400"><X size={12} /></button>
                )}
              </div>
            </div>
          ))}
          {form.variants.length < 10 && (
            <button type="button" onClick={() => setForm((f) => ({ ...f, variants: [...f.variants, ""] }))}
              className="flex items-center gap-1.5 text-xs text-violet-300/80 hover:text-violet-200">
              <Plus size={12} /> Add a variation
            </button>
          )}
          {sample.trim() && (
            <div className="flex items-start gap-2 rounded-lg bg-white/[0.03] border border-white/[0.05] px-3 py-2">
              <CornerDownRight size={12} className="text-white/25 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-white/55"><span className="text-white/25">Preview: </span>{renderReply(sample, { name: "@sarah" })}</p>
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-white/45 cursor-pointer select-none w-fit">
          <Toggle label="Reply to comments" checked={form.respondToComments} onChange={(v) => setForm((f) => ({ ...f, respondToComments: v }))} />
          Reply to new comments
        </label>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
            <AlertCircle size={14} className="flex-shrink-0" /> {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="button" onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {saving ? "Saving…" : editing ? "Save changes" : "Create rule"}
          </button>
          <button type="button" onClick={onCancel} className="px-3 py-2 text-white/30 hover:text-white/60 text-sm transition-colors">Cancel</button>
          {!editing && <p className="text-[11px] text-white/25 ml-auto hidden sm:block">Only comments posted after you create the rule get a reply.</p>}
        </div>
      </div>
    </div>
  );
}

// ── Rule tester ──────────────────────────────────────────────────────────────

function RuleTester({ rules }: { rules: AutoResponse[] }) {
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState<number | "">("");
  const accountsWithRules = [...new Map(rules.map((r) => [r.accountId, r.account])).entries()];
  const scoped = rules.filter((r) => r.isActive && (accountId === "" || r.accountId === accountId));
  const rule = text.trim() ? pickRule(scoped, text) : null;

  return (
    <div className="bg-d12 border border-white/[0.06] rounded-2xl p-4 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <FlaskConical size={14} className="text-sky-300" />
        <span className="text-sm font-semibold text-white/70">Test a comment</span>
        <span className="text-[11px] text-white/25">See which rule would answer it — nothing is posted.</span>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        {accountsWithRules.length > 1 && (
          <select className={`${inputCls} sm:w-44`} value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")} aria-label="Account to test">
            <option value="" className="bg-d12">All accounts</option>
            {accountsWithRules.map(([id, a]) => <option key={id} value={id} className="bg-d12">@{a?.username}</option>)}
          </select>
        )}
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. what's the price of this?" aria-label="Sample comment" />
      </div>
      {text.trim() && (
        <div className={`mt-3 rounded-lg border px-3 py-2.5 text-xs ${rule ? "border-emerald-500/20 bg-emerald-500/[0.06]" : "border-white/[0.06] bg-white/[0.02]"}`}>
          {rule ? (
            <>
              <p className="text-emerald-300/90 font-medium mb-1">
                Answered by @{rule.account?.username} · {parseKeywords(rule.triggerKeyword).length ? `keywords: ${parseKeywords(rule.triggerKeyword).join(", ")}` : "catch-all rule"}
              </p>
              <p className="text-white/60 flex gap-1.5"><CornerDownRight size={12} className="mt-0.5 flex-shrink-0 text-white/25" />
                {renderReply(pickVariant(rule.responseTemplate, text), { name: "@viewer" })}
              </p>
            </>
          ) : (
            <p className="text-white/40">No active rule matches — this comment wouldn&apos;t get a reply.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ResponsesPage() {
  const [accounts, setAccounts]   = useState<Account[]>([]);
  const [responses, setResponses] = useState<AutoResponse[]>([]);
  const [activity, setActivity]   = useState<LogRow[]>([]);
  const [tab, setTab]             = useState<"rules" | "activity">("rules");
  const [formOpen, setFormOpen]   = useState(false);
  const [editing, setEditing]     = useState<AutoResponse | null>(null);
  const [running, setRunning]     = useState(false);
  const [runResult, setRunResult] = useState<{ ok: boolean; msg: string; notes?: string[] } | null>(null);

  const loadRules = () => safeFetch<AutoResponse[]>("/api/responses", undefined, []).then(setResponses);
  const loadActivity = () => safeFetch<LogRow[]>("/api/responses/activity", undefined, []).then(setActivity);

  useEffect(() => {
    safeFetch<Account[]>("/api/accounts", undefined, []).then(setAccounts);
    loadRules();
    loadActivity();
  }, []);

  async function runNow() {
    setRunning(true);
    setRunResult(null);
    try {
      const res  = await fetch("/api/auto-respond", { method: "POST" });
      const data = await res.json() as { error?: string; checked?: number; replied?: number; failed?: number; errors?: string[] };
      if (!res.ok) throw new Error(data.error ?? "Failed");
      await Promise.all([loadRules(), loadActivity()]);
      const c = data.checked ?? 0, r = data.replied ?? 0, f = data.failed ?? 0;
      setRunResult({
        ok: f === 0 && !(data.errors?.length),
        msg: `Checked ${c} comment${c !== 1 ? "s" : ""} · sent ${r} repl${r !== 1 ? "ies" : "y"}${f ? ` · ${f} failed` : ""}`,
        notes: data.errors,
      });
    } catch (e) {
      setRunResult({ ok: false, msg: e instanceof Error ? e.message : "Run failed" });
    }
    setRunning(false);
  }

  function openNew() { setEditing(null); setFormOpen(true); }
  function openEdit(r: AutoResponse) {
    setEditing(r);
    setFormOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function closeForm() { setFormOpen(false); setEditing(null); }

  async function remove(r: AutoResponse) {
    if (!confirm(`Delete this rule for @${r.account?.username}? Its reply history stays in Activity.`)) return;
    setResponses((prev) => prev.filter((x) => x.id !== r.id));
    await fetch("/api/responses", { method: "DELETE", body: JSON.stringify({ id: r.id }), headers: { "Content-Type": "application/json" } });
  }

  async function toggle(r: AutoResponse) {
    setResponses((prev) => prev.map((x) => (x.id === r.id ? { ...x, isActive: !r.isActive, lastError: r.isActive ? x.lastError : null } : x)));
    await fetch("/api/responses", { method: "PATCH", body: JSON.stringify({ id: r.id, isActive: !r.isActive }), headers: { "Content-Type": "application/json" } });
  }

  const activeCount = responses.filter((r) => r.isActive).length;
  const totalSent   = responses.reduce((s, r) => s + (r.repliesSent ?? 0), 0);
  const lastChecked = responses.map((r) => parseDbTime(r.lastCheckedAt)).sort((a, b) => b - a)[0];
  const problems    = responses.filter((r) => r.isActive && r.lastError);
  const { pageItems: pagedRules, ...pager } = usePagination(responses, 12);

  return (
    <div className="min-h-full bg-d0a text-white">
      <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-8">

        <PageHeader
          eyebrow="Auto-Respond"
          title="Reply on autopilot"
          description="Auto-reply to new comments on your YouTube and Instagram posts."
          actions={<>
            <button onClick={runNow} disabled={running || activeCount === 0}
              title={activeCount === 0 ? "Turn on a rule first" : "Check for new comments now"}
              className="flex items-center gap-2 px-4 py-2 bg-white/[0.06] hover:bg-white/[0.09] border border-white/[0.08] text-white/70 rounded-lg text-sm font-medium transition-colors disabled:opacity-40">
              {running ? <><Loader2 size={14} className="animate-spin" /> Checking…</> : <><Zap size={14} /> Run now</>}
            </button>
            <button onClick={() => (formOpen ? closeForm() : openNew())}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${formOpen
                ? "bg-white/[0.06] border border-white/[0.08] text-white/70 hover:bg-white/[0.09]"
                : "bg-violet-600 hover:bg-violet-500 text-white"}`}>
              {formOpen ? <><X size={14} /> Cancel</> : <><Plus size={14} /> New rule</>}
            </button>
          </>}
        />

        {runResult && (
          <div className={`mb-5 px-4 py-3 rounded-xl text-sm border ${runResult.ok
            ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-amber-500/10 border-amber-500/20 text-amber-300"}`}>
            <div className="flex items-center gap-2 font-medium">
              {runResult.ok ? <Check size={14} /> : <AlertCircle size={14} />}
              {runResult.msg}
              <button onClick={() => setRunResult(null)} className="ml-auto opacity-50 hover:opacity-100" aria-label="Dismiss"><X size={13} /></button>
            </div>
            {runResult.notes?.map((n, i) => <p key={i} className="text-xs opacity-75 mt-1 pl-6">{n}</p>)}
          </div>
        )}

        {problems.length > 0 && !runResult && (
          <div className="mb-5 flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm">
            <AlertTriangle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-red-300 font-medium">{problems.length} rule{problems.length > 1 ? "s" : ""} couldn&apos;t run last time</p>
              <p className="text-xs text-red-200/60 mt-0.5 truncate">{problems[0].lastError}</p>
            </div>
            <Link href="/accounts" className="ml-auto text-xs text-red-200 underline flex-shrink-0">Reconnect</Link>
          </div>
        )}

        {/* Stats */}
        {responses.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: "Active rules",  value: `${activeCount}/${responses.length}`, icon: Power, color: "text-emerald-300", glow: "bg-emerald-500/20" },
              { label: "Replies sent",  value: totalSent.toLocaleString(),           icon: Send,  color: "text-violet-300",  glow: "bg-violet-500/20" },
              { label: "Last check",    value: lastChecked ? ago(new Date(lastChecked).toISOString()) : "never", icon: Clock, color: "text-sky-300", glow: "bg-sky-500/20", small: true },
              { label: "Daily limit",   value: `${MAX_REPLIES_PER_DAY}/acct`,        icon: ShieldCheck, color: "text-amber-300", glow: "bg-amber-500/20", small: true },
            ].map(({ label, value, icon: Icon, color, glow, small }) => (
              <div key={label} className="relative overflow-hidden bg-gradient-to-br from-d16 to-d0e border border-white/[0.06] rounded-2xl p-4">
                <div className={`absolute -right-5 -top-5 w-16 h-16 rounded-full blur-2xl ${glow} pointer-events-none`} />
                <div className="relative">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] uppercase tracking-wider text-white/35 font-semibold">{label}</span>
                    <Icon size={14} className={color} />
                  </div>
                  <div className={`${small ? "text-base" : "text-2xl"} font-bold text-white/95 leading-none tabular-nums`}>{value}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {formOpen && (
          <RuleForm
            key={editing?.id ?? "new"}
            accounts={accounts}
            editing={editing}
            initial={editing ? {
              accountId: String(editing.accountId),
              keywords: parseKeywords(editing.triggerKeyword),
              variants: splitVariants(editing.responseTemplate).length ? splitVariants(editing.responseTemplate) : [""],
              respondToComments: editing.respondToComments,
            } : EMPTY_FORM}
            onCancel={closeForm}
            onSaved={(row) => {
              setResponses((prev) => (editing ? prev.map((x) => (x.id === row.id ? row : x)) : [...prev, row]));
              closeForm();
            }}
          />
        )}

        {responses.length > 0 && (
          <div className="flex gap-1.5 mb-4" role="tablist">
            {([["rules", "Rules", Bot, responses.length], ["activity", "Activity", Activity, activity.length]] as const).map(([key, label, Icon, n]) => (
              <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === key ? "bg-white/[0.08] text-white/85" : "text-white/35 hover:text-white/60 hover:bg-white/[0.04]"}`}>
                <Icon size={13} /> {label}
                <span className={`text-[10px] tabular-nums rounded-full px-1.5 py-px ${tab === key ? "bg-violet-500/25 text-violet-200" : "bg-white/[0.06] text-white/30"}`}>{n}</span>
              </button>
            ))}
          </div>
        )}

        {responses.length === 0 ? (
          !formOpen && (
            <div className="bg-d12 border border-white/[0.06] rounded-2xl px-6 py-14 text-center">
              <div className="inline-flex p-4 bg-white/[0.03] rounded-2xl mb-4 border border-white/[0.05]">
                <Bot size={28} className="text-white/15" />
              </div>
              <p className="text-white/50 text-sm font-semibold mb-1">No rules yet</p>
              <p className="text-white/25 text-xs max-w-sm mx-auto leading-relaxed mb-5">
                Reply to every new comment, or only ones mentioning words like &ldquo;price&rdquo; or &ldquo;link&rdquo;. Works on YouTube and Instagram.
              </p>
              <button onClick={openNew} className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm font-medium transition-colors">
                <Plus size={14} /> Create your first rule
              </button>
            </div>
          )
        ) : tab === "rules" ? (
          <>
            <RuleTester rules={responses} />
            <div className="bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
              {pagedRules.map((r, i) => {
                const pc = PLATFORM[r.account?.platform ?? ""] ?? fallbackPlatform;
                const kws = parseKeywords(r.triggerKeyword);
                const variants = splitVariants(r.responseTemplate);
                const accountPaused = r.account?.isActive === false;
                return (
                  <div key={r.id} className={`border-l-2 ${i !== 0 ? "border-t border-white/[0.05]" : ""} ${r.isActive ? "" : "opacity-60"}`} style={{ borderLeftColor: pc.leftColor }}>
                    <div className="px-5 py-4 space-y-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-lg border ${pc.bg} ${pc.text} ${pc.border}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${pc.dot}`} /> {pc.label}
                        </span>
                        <span className="text-sm font-medium text-white/65 truncate">@{r.account?.username ?? "unknown"}</span>
                        {kws.length ? kws.map((k) => (
                          <span key={k} className="inline-flex items-center gap-1 text-xs bg-amber-500/10 text-amber-400/80 border border-amber-500/20 px-2 py-0.5 rounded-lg">
                            <Hash size={10} />{k}
                          </span>
                        )) : (
                          <span className="text-xs text-white/30 bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-lg">all comments</span>
                        )}

                        <div className="ml-auto flex items-center gap-1">
                          <Toggle label={r.isActive ? "Pause rule" : "Activate rule"} checked={r.isActive} onChange={() => toggle(r)} />
                          <button onClick={() => openEdit(r)} title="Edit rule" aria-label="Edit rule"
                            className="p-1.5 text-white/30 hover:text-white/80 rounded-lg hover:bg-white/[0.06] transition-colors"><Pencil size={14} /></button>
                          <button onClick={() => remove(r)} title="Delete rule" aria-label="Delete rule"
                            className="p-1.5 text-white/30 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"><Trash2 size={14} /></button>
                        </div>
                      </div>

                      <div className="flex items-start gap-2">
                        <MessageSquare size={12} className="text-white/20 flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-white/45 italic line-clamp-2">&ldquo;{variants[0]}&rdquo;</p>
                        {variants.length > 1 && (
                          <span className="text-[10px] text-violet-300/70 bg-violet-500/10 border border-violet-500/20 rounded px-1.5 py-px flex-shrink-0">+{variants.length - 1} variation{variants.length > 2 ? "s" : ""}</span>
                        )}
                      </div>

                      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-white/30">
                        <span className="flex items-center gap-1"><Send size={10} /> {(r.repliesSent ?? 0).toLocaleString()} sent</span>
                        <span className="flex items-center gap-1"><Clock size={10} /> checked {ago(r.lastCheckedAt)}</span>
                        {r.lastReplyAt && <span>last reply {ago(r.lastReplyAt)}</span>}
                        {accountPaused && <span className="text-amber-300/70">account paused — rule won&apos;t run</span>}
                      </div>

                      {r.isActive && r.lastError && (
                        <p className="flex items-start gap-1.5 text-[11px] text-red-300/80 bg-red-500/[0.07] border border-red-500/15 rounded-lg px-2.5 py-1.5">
                          <AlertCircle size={11} className="flex-shrink-0 mt-0.5" /> {r.lastError}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              <Pagination pager={pager} />
            </div>
          </>
        ) : (
          <div className="bg-d12 border border-white/[0.06] rounded-2xl overflow-hidden">
            {activity.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-white/30">No replies yet. They&apos;ll show up here as comments come in.</div>
            ) : activity.map((a, i) => {
              const pc = PLATFORM[a.platform] ?? fallbackPlatform;
              return (
                <div key={a.id} className={`px-5 py-3.5 space-y-1.5 ${i ? "border-t border-white/[0.04]" : ""}`}>
                  <div className="flex items-center gap-2 text-[11px] text-white/30">
                    <span className={`w-1.5 h-1.5 rounded-full ${pc.dot}`} />
                    <span className="text-white/50">@{a.username}</span>
                    {a.postContent && <span className="truncate">on &ldquo;{a.postContent}&rdquo;</span>}
                    <span className="ml-auto flex-shrink-0">{ago(a.createdAt)}</span>
                    <span className={`flex-shrink-0 text-[10px] px-1.5 py-px rounded border ${
                      a.status === "sent" ? "text-emerald-300 border-emerald-500/25 bg-emerald-500/10"
                      : a.status === "failed" ? "text-red-300 border-red-500/25 bg-red-500/10"
                      : "text-white/40 border-white/10"}`}>{a.status}</span>
                  </div>
                  <p className="text-xs text-white/60"><span className="text-white/35 font-medium">{a.commentAuthor}:</span> {a.commentText}</p>
                  <p className="text-xs text-violet-200/70 flex gap-1.5"><CornerDownRight size={12} className="flex-shrink-0 mt-0.5 text-white/25" /> {a.replyText}</p>
                  {a.error && <p className="text-[11px] text-red-300/70 pl-5">{a.error}</p>}
                </div>
              );
            })}
          </div>
        )}

        {/* How it works */}
        <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-white/[0.05] bg-white/[0.02] px-4 py-3">
          <Info size={13} className="text-white/25 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-white/30 leading-relaxed">
            Checks for new comments automatically every 5 minutes on posts from the last {POST_WINDOW_DAYS} days. Each comment gets at most one reply —
            keyword rules win over catch-alls. Your own comments and threads you already answered are skipped. To stay clear of spam filters,
            Vybe sends at most {MAX_REPLIES_PER_RUN} replies per check and {MAX_REPLIES_PER_DAY} per day per account.
          </p>
        </div>
      </div>
    </div>
  );
}
