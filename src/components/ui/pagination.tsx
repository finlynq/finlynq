"use client";

/**
 * Pagination — the shared offset-pagination control for server-paged tables.
 *
 * Lifted from the inline block that lived in `transactions-workspace.tsx`
 * (page-number logic at :610-620, markup at :1072-1094), which was the only
 * complete implementation in the app; a second, cruder prev/next copy lives in
 * `portfolio/_components/etf-xray-card.tsx`. The admin users table would have
 * been a third copy, so the logic was extracted here instead.
 *
 * Pairs with `DataTable`'s `manualSort` mode: `DataTable` renders the rows the
 * server returned, this renders the pager, and the page owns the fetch. The
 * page index is **0-indexed** throughout (as it was in transactions) — only the
 * button labels are 1-indexed.
 */

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The page numbers to render, with "ellipsis" gaps — 0-indexed.
 *
 * Up to 7 pages render in full; beyond that it collapses to
 * `first … prev current next … last`. Extracted verbatim from the transactions
 * table so its output is unchanged there. Pure + exported for unit tests.
 *
 * `totalPages <= 0` yields `[]`, which is what lets the caller render the
 * control unconditionally on an empty result set.
 */
export function getPageNumbers(
  page: number,
  totalPages: number,
): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: Math.max(0, totalPages) }, (_, i) => i);
  }
  const pages: (number | "ellipsis")[] = [0];
  if (page > 2) pages.push("ellipsis");
  for (
    let i = Math.max(1, page - 1);
    i <= Math.min(totalPages - 2, page + 1);
    i++
  ) {
    pages.push(i);
  }
  if (page < totalPages - 3) pages.push("ellipsis");
  pages.push(totalPages - 1);
  return pages;
}

export interface PaginationProps {
  /** Current page, 0-indexed. */
  page: number;
  /** Rows per page. */
  limit: number;
  /** Total rows matching the CURRENT filter — not the unfiltered table size. */
  total: number;
  onPageChange: (page: number) => void;
  /** Noun for the "Showing X–Y of Z <label>" summary. Default: no noun. */
  label?: string;
  className?: string;
}

export function Pagination({
  page,
  limit,
  total,
  onPageChange,
  label,
  className,
}: PaginationProps) {
  const totalPages = Math.ceil(total / limit);
  const pages = getPageNumbers(page, totalPages);

  return (
    <div className={cn("flex items-center justify-between", className)}>
      <p className="text-sm text-muted-foreground">
        Showing {total === 0 ? 0 : page * limit + 1}–
        {Math.min((page + 1) * limit, total)} of {total}
        {label ? ` ${label}` : ""}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {pages.map((p, idx) =>
          p === "ellipsis" ? (
            <span
              key={`ellipsis-${idx}`}
              className="px-2 text-sm text-muted-foreground"
            >
              ...
            </span>
          ) : (
            <Button
              key={p}
              variant={page === p ? "default" : "outline"}
              size="sm"
              className="h-8 w-8 p-0 text-sm"
              onClick={() => onPageChange(p)}
              aria-label={`Page ${p + 1}`}
              aria-current={page === p ? "page" : undefined}
            >
              {p + 1}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
