"use client";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Client-side list pagination. `usePagination` slices the list and clamps the
// page when a filter shrinks it (derived at render — no state sync needed);
// `<Pagination/>` renders the footer bar and disappears entirely when
// everything fits on one page.

export function usePagination<T>(items: T[], perPage: number) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, pages);
  const pageItems = useMemo(
    () => items.slice((current - 1) * perPage, current * perPage),
    [items, current, perPage],
  );
  return {
    pageItems,
    pages,
    setPage,
    page: current,
    total: items.length,
    from: items.length === 0 ? 0 : (current - 1) * perPage + 1,
    to: Math.min(items.length, current * perPage),
  };
}

export type Pager = Omit<ReturnType<typeof usePagination>, "pageItems">;

const btnCls =
  "p-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] text-white/40 " +
  "hover:text-violet-300 hover:border-violet-500/30 hover:bg-violet-500/10 " +
  "disabled:opacity-30 disabled:pointer-events-none transition-all";

export default function Pagination({ pager, className = "" }: { pager: Pager; className?: string }) {
  const { page, pages, setPage, from, to, total } = pager;
  if (pages <= 1) return null;
  return (
    <div className={`flex items-center justify-between gap-3 px-4 sm:px-5 py-2.5 border-t border-white/[0.05] ${className}`}>
      <span className="text-[10px] text-white/25 font-mono tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button type="button" aria-label="Previous page" disabled={page <= 1}
          onClick={() => setPage(page - 1)} className={btnCls}>
          <ChevronLeft size={13} />
        </button>
        <span className="text-[10px] text-white/40 font-mono tabular-nums px-1">
          {page} / {pages}
        </span>
        <button type="button" aria-label="Next page" disabled={page >= pages}
          onClick={() => setPage(page + 1)} className={btnCls}>
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}
