"use client";
// Account & data: who you're signed in as, a "download my data" export, and
// permanent account deletion (typed-email confirmation).
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Trash2, Loader2, AlertTriangle, X, ShieldCheck, CreditCard } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { useIsDesktop } from "@/lib/desktop-bridge";

type Me = { name: string | null; email: string; plan: string | null };

export default function AccountPage() {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const [me, setMe] = useState<Me | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then((d) => d?.email && setMe(d)).catch(() => {});
  }, []);

  async function exportData() {
    setExporting(true); setExportError("");
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Export failed");
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "vybe-data.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    }
    setExporting(false);
  }

  const paid = !!me?.plan && me.plan !== "free";

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <PageHeader eyebrow="Settings" title="Account & data" description="Your sign-in details, a copy of your data, and account deletion." />

      {/* Profile */}
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 sm:p-6 mb-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-lg font-bold text-white flex-shrink-0">
            {(me?.name ?? me?.email ?? "?")[0]?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-white/90 truncate">{me?.name ?? me?.email.split("@")[0] ?? "…"}</p>
            <p className="text-[13px] text-white/45 truncate">{me?.email ?? "Loading…"}</p>
          </div>
          {!isDesktop && (
            <Link href="/billing" className="flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium text-white/70 bg-white/[0.04] border border-white/[0.08] hover:text-white hover:border-white/[0.15] transition-colors flex-shrink-0">
              <CreditCard size={14} /> <span className="capitalize">{me?.plan ?? "free"}</span> plan
            </Link>
          )}
        </div>
      </section>

      {/* Export */}
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 sm:p-6 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-white/90 flex items-center gap-2">
              <ShieldCheck size={16} className="text-violet-300" /> Download your data
            </h2>
            <p className="mt-1 text-[13px] text-white/45 leading-relaxed">
              A JSON file with your profile, connected accounts, posts, analytics, clips, styles and Auto-Pilot settings.
              Media files are included as links. Passwords and platform tokens are never exported.
            </p>
          </div>
          <button type="button" onClick={exportData} disabled={exporting}
            className="flex items-center justify-center gap-2 h-10 px-4 rounded-xl text-[13px] font-semibold text-white bg-white/[0.07] border border-white/[0.12] hover:bg-white/[0.11] disabled:opacity-50 transition-colors flex-shrink-0">
            {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            {exporting ? "Preparing…" : "Export data"}
          </button>
        </div>
        {exportError && <p className="mt-3 text-[13px] text-red-300">{exportError}</p>}
      </section>

      {/* Danger zone */}
      <section className="rounded-2xl border border-red-500/20 bg-red-500/[0.03] p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-red-200 flex items-center gap-2">
          <Trash2 size={16} /> Delete account
        </h2>
        {isDesktop ? (
          <p className="mt-1 text-[13px] text-white/45 leading-relaxed">
            The desktop app keeps everything on this computer. To remove it, uninstall Vybe and delete its data folder.
          </p>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-1">
            <p className="flex-1 text-[13px] text-white/45 leading-relaxed">
              Permanently deletes your account, connected accounts, scheduled posts, clips, styles and Auto-Pilots.
              {paid && " Your subscription is cancelled immediately."} This can’t be undone.
            </p>
            <button type="button" onClick={() => setDeleteOpen(true)}
              className="flex items-center justify-center gap-2 h-10 px-4 rounded-xl text-[13px] font-semibold text-red-200 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 transition-colors flex-shrink-0">
              <Trash2 size={15} /> Delete account
            </button>
          </div>
        )}
      </section>

      <p className="mt-6 text-[12px] text-white/30">
        See our <Link href="/privacy" className="underline underline-offset-2 hover:text-white/60">Privacy Policy</Link> for how your data is handled.
      </p>

      {deleteOpen && me && (
        <DeleteModal email={me.email} paid={paid} onClose={() => setDeleteOpen(false)} onExport={exportData}
          onDeleted={() => { router.push("/"); router.refresh(); }} />
      )}
    </div>
  );
}

function DeleteModal({ email, paid, onClose, onExport, onDeleted }: {
  email: string; paid: boolean; onClose: () => void; onExport: () => void; onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function confirmDelete() {
    if (!matches || busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not delete your account");
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete your account");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/70 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="delete-title"
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-white/[0.09] bg-d11 shadow-2xl p-5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={18} className="text-red-300" />
            </span>
            <h2 id="delete-title" className="text-[16px] font-semibold text-white">Delete your account?</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
            className="w-8 h-8 -mr-1 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/[0.06]">
            <X size={16} />
          </button>
        </div>

        <ul className="space-y-1.5 text-[13px] text-white/60 mb-4">
          <li>• All clips, uploads and exports are deleted from our storage.</li>
          <li>• Scheduled posts are cancelled and connected accounts disconnected.</li>
          {paid && <li>• Your subscription is cancelled immediately (see the <Link href="/refunds" className="underline underline-offset-2">Refund Policy</Link>).</li>}
          <li>• Posts already published stay on those platforms.</li>
        </ul>

        <button type="button" onClick={onExport} className="text-[13px] text-violet-300 hover:text-violet-200 mb-4 inline-flex items-center gap-1.5">
          <Download size={13} /> Download your data first
        </button>

        <label className="block text-[13px] text-white/55 mb-1.5">
          Type <span className="font-mono text-white/85">{email}</span> to confirm
        </label>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter") confirmDelete(); }}
          className="w-full h-11 bg-black/40 border border-white/[0.1] rounded-xl px-3 text-[14px] text-white outline-none focus:border-red-400/50" />

        {error && <p className="mt-3 text-[13px] text-red-300 leading-relaxed">{error}</p>}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} disabled={busy}
            className="h-11 rounded-xl text-[14px] font-medium text-white/75 bg-white/[0.05] border border-white/[0.09] hover:bg-white/[0.09]">
            Cancel
          </button>
          <button type="button" onClick={confirmDelete} disabled={!matches || busy}
            className="h-11 rounded-xl text-[14px] font-semibold text-white bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-600 flex items-center justify-center gap-2 transition-colors">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            {busy ? "Deleting…" : "Delete forever"}
          </button>
        </div>
      </div>
    </div>
  );
}
