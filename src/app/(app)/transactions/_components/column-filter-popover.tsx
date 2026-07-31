"use client";

/**
 * ColumnFilterPopover (transactions) — now a thin adapter over the SHARED
 * popover at `@/components/ui/column-filter`.
 *
 * The body of this component moved there verbatim when the admin users table
 * needed the same affordance (2026-07-31); the only transaction-specific part
 * was the enum branch, which hardcoded four `columnId` cases and read the
 * `accounts` / `categories` props directly. That is now an injected option
 * list, built here so the shared component knows nothing about sources,
 * categories or accounts.
 *
 * The props and the emitted `ColFilterShape` are unchanged, so the page,
 * `buildTransactionQuery` and the persisted `/api/settings/tx-filters` blobs
 * all see identical behaviour.
 */

import { useMemo } from "react";
import { ColumnFilterPopover as SharedColumnFilterPopover } from "@/components/ui/column-filter";
import type { FilterOption } from "@/lib/table-filters";
import { labelForSource, SOURCES } from "@/lib/tx-source";
import type { ColumnId as SharedColumnId, FilterType } from "@/lib/transactions/columns";
import type { ColFilterShape } from "../_types";

export function ColumnFilterPopover({
  columnId,
  filterType,
  activeFilter,
  onChange,
  accounts,
  categories,
}: {
  columnId: SharedColumnId;
  filterType: FilterType;
  activeFilter: ColFilterShape | undefined;
  onChange: (f: ColFilterShape | null) => void;
  accounts: Array<{ id: number; name: string; type?: string | null; alias?: string | null }>;
  categories: Array<{ id: number; name: string }>;
}) {
  // The four enum columns the transactions table offers. Values stay strings
  // and keep their exact prior meaning (ids for account/category, the raw
  // source token, the account type) because they feed buildTransactionQuery.
  const options: FilterOption[] = useMemo(() => {
    switch (columnId) {
      case "source":
        return SOURCES.map((s) => ({ value: s, label: labelForSource(s) }));
      case "category":
        return categories.map((c) => ({ value: String(c.id), label: c.name }));
      case "account":
        return accounts.map((a) => ({ value: String(a.id), label: a.name }));
      case "accountType":
        return Array.from(
          new Set(accounts.map((a) => a.type).filter(Boolean) as string[]),
        ).map((t) => ({ value: t, label: t }));
      default:
        return [];
    }
  }, [columnId, accounts, categories]);

  return (
    <SharedColumnFilterPopover
      columnId={columnId}
      filterType={filterType}
      options={options}
      activeFilter={activeFilter}
      // The shared component is typed against the generic TableColFilter, whose
      // columnId is a plain string. Transactions' ColFilterShape is the same
      // union narrowed to its own ColumnId, and the value round-trips from the
      // columnId we passed in, so this cast is safe by construction.
      onChange={(f) => onChange(f as ColFilterShape | null)}
    />
  );
}
