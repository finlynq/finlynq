"use client";

/**
 * useTransactions (FINLYNQ-111 Phase 2; SWR adoption FINLYNQ-115).
 *
 * Owns the main list state (`txns` / `total` / `loading` / `page`) + `loadTxns`.
 * The PUBLIC SIGNATURE is unchanged from the FINLYNQ-111 extraction —
 * `{ txns, total, loading, limit, loadTxns }` — so the consuming page is
 * untouched. The INTERNALS now run on `useSWR`:
 *
 *   - Cache key = the request URL string, built by the pure, unit-tested
 *     `buildTransactionQuery(...)` (same `{data,total}` shape, issue #59). The
 *     key changes exactly when the effective request changes — which is exactly
 *     when the pre-115 `loadTxns` `useCallback` was re-created and re-fired.
 *   - `loadTxns()` is a bound `mutate()` (imperative "refetch now") — same call
 *     sites in the page (after create / edit / delete / dialog save).
 *   - `swrListOptions` keeps the request pattern no noisier than before
 *     (no focus/reconnect revalidation; dedup; background revalidate on
 *     nav-back; keepPreviousData so paging/filtering doesn't blank the table).
 */

import { useCallback } from "react";
import useSWR from "swr";
import { buildTransactionQuery } from "@/lib/transactions/build-query";
import { jsonFetcher, swrListOptions } from "@/lib/swr";
import type { DayTotalsPayload } from "@/lib/transactions/by-day";
import type { Account, ColFilterShape, SortPref, Transaction } from "../_types";

const limit = 50;

export const TX_PAGE_LIMIT = limit;

type TxListResponse = { data?: Transaction[]; total?: number; dayTotals?: DayTotalsPayload };

export function useTransactions(
  filters: {
    // FINLYNQ-177 — single-transaction id deep link.
    id: string;
    startDate: string;
    endDate: string;
    accountId: string;
    categoryId: string;
    search: string;
    portfolioHolding: string;
    tag: string;
  },
  sortPref: SortPref,
  colFilters: ColFilterShape[],
  accounts: Account[],
  page: number,
  // GH #465 — the "By day" view also asks the same request for each day's
  // whole-day totals (`dayTotals=1`); the rows and their paging are unchanged.
  opts: { dayTotals?: boolean } = {},
) {
  // Issue #59 — the top-bar quick filters are URL-driven (deep links from
  // /portfolio etc. must keep working); per-column filters + sort are persisted
  // server-side. Both sets narrow the result. The param assembly is the pure,
  // unit-tested buildTransactionQuery (FINLYNQ-111 Phase 1), and its string is
  // the SWR cache key (FINLYNQ-115) — deterministic per filter/sort/page combo.
  const params = buildTransactionQuery(filters, sortPref, colFilters, accounts, { page, limit });
  if (opts.dayTotals) params.set("dayTotals", "1");
  const key = `/api/transactions?${params}`;

  const { data, isLoading, isValidating, mutate } = useSWR<TxListResponse>(
    key,
    jsonFetcher,
    swrListOptions,
  );

  // `loading` matches the pre-115 contract: it was set true at the start of
  // EVERY fetch (mount, dep change, manual loadTxns) and cleared in `finally`.
  // SWR's isLoading is the first-load-with-no-data signal; isValidating covers
  // the in-flight refetches (dep change with cached data, manual mutate).
  const loading = isLoading || isValidating;

  // Same imperative-refetch surface the page calls after create/edit/delete and
  // from the split dialog's onSaved. Backed by SWR's bound mutate (revalidate).
  const loadTxns = useCallback(() => {
    void mutate();
  }, [mutate]);

  return {
    txns: data?.data ?? [],
    total: data?.total ?? 0,
    dayTotals: data?.dayTotals ?? null,
    loading,
    limit,
    loadTxns,
  };
}
