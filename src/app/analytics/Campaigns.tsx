"use client";
// Campaign manager (add / edit / set default / delete) and the per-video
// campaign picker used on the Analytics page.
import { useState } from "react";
import { Plus, Star, Trash2, Pencil, Check, X, Loader2 } from "lucide-react";
import { CURRENCIES, formatMoney, viewsToQualify, type CampaignLike } from "@/lib/campaigns";

export type Campaign = CampaignLike & { createdAt?: string | null };

type Draft = { name: string; cpm: string; minPayout: string; maxPayout: string; currency: string };
const emptyDraft: Draft = { name: "", cpm: "", minPayout: "", maxPayout: "", currency: "USD" };

const inputCls =
  "w-full bg-white/[0.04] border border-white/[0.09] text-white placeholder:text-white/25 rounded-lg px-3 py-2 text-sm outline-none focus:border-violet-500/60 focus:ring-2 focus:ring-violet-500/15 transition-all";

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

function DraftFields({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-[1fr_90px_110px_110px_84px] gap-2">
      <label className="col-span-2 sm:col-span-1">
        <span className="block text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1">Campaign name</span>
        <input className={inputCls} value={draft.name} maxLength={80} placeholder="e.g. Streamer X clipping"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label>
        <span className="block text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1">CPM</span>
        <input className={inputCls} value={draft.cpm} inputMode="decimal" placeholder="1.50"
          onChange={(e) => setDraft({ ...draft, cpm: e.target.value })} />
      </label>
      <label>
        <span className="block text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1">Min payout</span>
        <input className={inputCls} value={draft.minPayout} inputMode="decimal" placeholder="None"
          title="A video earning less than this doesn't qualify (earns 0)"
          onChange={(e) => setDraft({ ...draft, minPayout: e.target.value })} />
      </label>
      <label>
        <span className="block text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1">Max per video</span>
        <input className={inputCls} value={draft.maxPayout} inputMode="decimal" placeholder="No cap"
          onChange={(e) => setDraft({ ...draft, maxPayout: e.target.value })} />
      </label>
      <label>
        <span className="block text-[10px] uppercase tracking-wider text-white/35 font-semibold mb-1">Currency</span>
        <select className={inputCls} value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>
          {CURRENCIES.map((c) => <option key={c} value={c} className="bg-d12">{c}</option>)}
        </select>
      </label>
    </div>
  );
}

const toBody = (d: Draft) => ({
  name: d.name,
  cpm: d.cpm.replace(",", "."),
  minPayout: d.minPayout.trim() === "" ? null : d.minPayout.replace(",", "."),
  maxPayout: d.maxPayout.trim() === "" ? null : d.maxPayout.replace(",", "."),
  currency: d.currency,
});

export function CampaignManager({ campaigns, onChange, revenueByCampaign, videosByCampaign }: {
  campaigns: Campaign[];
  onChange: () => Promise<void> | void;   // reload after any change
  revenueByCampaign: Map<number, number>;
  videosByCampaign: Map<number, number>;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setError("");
    try { await fn(); await onChange(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); return false; }
    finally { setBusy(null); }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (await run("add", () => send("/api/campaigns", "POST", toBody(draft)))) setDraft(emptyDraft);
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/25 text-red-400 rounded-lg text-xs">{error}</div>
      )}

      {campaigns.length > 0 && (
        <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.06] overflow-hidden">
          {campaigns.map((c) => editingId === c.id ? (
            <div key={c.id} className="p-3 space-y-2 bg-white/[0.02]">
              <DraftFields draft={editDraft} setDraft={setEditDraft} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setEditingId(null)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white/80 hover:bg-white/[0.05]">
                  <X size={12} /> Cancel
                </button>
                <button type="button" disabled={busy !== null}
                  onClick={async () => { if (await run(`edit${c.id}`, () => send(`/api/campaigns/${c.id}`, "PATCH", toBody(editDraft)))) setEditingId(null); }}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50">
                  {busy === `edit${c.id}` ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
                </button>
              </div>
            </div>
          ) : (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white/85 font-medium truncate">{c.name}</span>
                  {c.isDefault && (
                    <span className="text-[9px] uppercase tracking-wider font-semibold text-amber-300 bg-amber-500/15 border border-amber-500/25 rounded px-1.5 py-px">Default</span>
                  )}
                </div>
                <p className="text-[11px] text-white/35 mt-0.5">
                  {formatMoney(c.cpm, c.currency)} CPM
                  {c.minPayout != null && c.minPayout > 0 && <> · min {formatMoney(c.minPayout, c.currency)} ({viewsToQualify(c)?.toLocaleString()} views)</>}
                  {c.maxPayout != null && <> · max {formatMoney(c.maxPayout, c.currency)}/video</>}
                  {" · "}{videosByCampaign.get(c.id) ?? 0} video{(videosByCampaign.get(c.id) ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-emerald-300 tabular-nums">{formatMoney(revenueByCampaign.get(c.id) ?? 0, c.currency)}</div>
                <div className="text-[9px] uppercase tracking-wider text-white/25">est. earned</div>
              </div>
              <div className="flex items-center gap-0.5">
                {!c.isDefault && (
                  <button type="button" title="Make default" aria-label={`Make ${c.name} the default campaign`} disabled={busy !== null}
                    onClick={() => run(`def${c.id}`, () => send(`/api/campaigns/${c.id}`, "PATCH", { isDefault: true }))}
                    className="p-1.5 rounded-md text-white/30 hover:text-amber-300 hover:bg-amber-500/10">
                    <Star size={14} />
                  </button>
                )}
                <button type="button" title="Edit" aria-label={`Edit ${c.name}`}
                  onClick={() => {
                    setEditingId(c.id);
                    setEditDraft({ name: c.name, cpm: String(c.cpm), minPayout: c.minPayout != null ? String(c.minPayout) : "", maxPayout: c.maxPayout != null ? String(c.maxPayout) : "", currency: c.currency });
                  }}
                  className="p-1.5 rounded-md text-white/30 hover:text-white/80 hover:bg-white/[0.06]">
                  <Pencil size={14} />
                </button>
                <button type="button" title="Delete" aria-label={`Delete ${c.name}`} disabled={busy !== null}
                  onClick={() => {
                    const n = videosByCampaign.get(c.id) ?? 0;
                    const msg = `Delete “${c.name}”?` + (n > 0 ? ` Its ${n} video${n === 1 ? "" : "s"} will move to the default campaign.` : "")
                      + (c.isDefault && campaigns.length > 1 ? " Your oldest other campaign becomes the default." : "");
                    if (window.confirm(msg)) run(`del${c.id}`, () => send(`/api/campaigns/${c.id}`, "DELETE"));
                  }}
                  className="p-1.5 rounded-md text-white/30 hover:text-red-400 hover:bg-red-500/10">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={add} className="space-y-2">
        <p className="text-xs text-white/45 font-medium">
          {campaigns.length === 0 ? "Add your first campaign — it becomes the default for every video." : "Add a campaign"}
        </p>
        <DraftFields draft={draft} setDraft={setDraft} />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-white/25">Revenue = views ÷ 1,000 × CPM, up to the max per video. Videos under the min payout earn nothing.</p>
          <button type="submit" disabled={busy !== null || !draft.name.trim() || !draft.cpm.trim()}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 flex-shrink-0">
            {busy === "add" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add campaign
          </button>
        </div>
      </form>
    </div>
  );
}

// Per-video picker: "Default (name)" follows whatever the default is; or a specific campaign.
export function CampaignSelect({ postId, value, campaigns, onAssigned }: {
  postId: number;
  value: number | null;
  campaigns: Campaign[];
  onAssigned: (postId: number, campaignId: number | null) => void;
}) {
  const [saving, setSaving] = useState(false);
  const def = campaigns.find((c) => c.isDefault);
  // A stale id (deleted campaign) displays as "Default".
  const current = value != null && campaigns.some((c) => c.id === value) ? String(value) : "";

  async function change(v: string) {
    const campaignId = v === "" ? null : Number(v);
    setSaving(true);
    try {
      await send(`/api/posts/${postId}/campaign`, "PUT", { campaignId });
      onAssigned(postId, campaignId);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Couldn't change the campaign");
    } finally {
      setSaving(false);
    }
  }

  if (campaigns.length === 0) return <span className="text-white/20 text-[11px]">—</span>;
  return (
    <select value={current} disabled={saving} onChange={(e) => change(e.target.value)}
      aria-label="Campaign for this video"
      className="max-w-[150px] bg-white/[0.04] border border-white/[0.08] hover:border-white/[0.15] text-white/70 rounded-md px-2 py-1 text-[11px] outline-none focus:border-violet-500/50 disabled:opacity-50">
      <option value="" className="bg-d12">{def ? `Default · ${def.name}` : "No campaign"}</option>
      {campaigns.map((c) => <option key={c.id} value={c.id} className="bg-d12">{c.name}</option>)}
    </select>
  );
}
