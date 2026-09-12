"use client";

/**
 * Transactions-page data hooks (FINLYNQ-111 Phase 2; SWR adoption FINLYNQ-115).
 *
 * The PUBLIC SIGNATURES are unchanged from the FINLYNQ-111 extraction — the
 * consuming page is untouched. The GET-on-mount fetches now run on `useSWR`
 * (shared fetcher + key convention, cache + dedup + background revalidate),
 * while the editable local state + the debounced-PUT-on-change effects are kept
 * verbatim (same 400ms debounce, same PUT contract). The legacy localStorage
 * migration in useTxColumnPrefs is preserved exactly.
 *
 * Pattern for the editable prefs (columns / sort / filters): SWR owns the GET;
 * its result seeds the editable `useState` ONCE on first arrival (a guard ref so
 * a later background revalidate doesn't clobber unsaved local edits). This keeps
 * SWR's caching/dedup benefit on the read while leaving the write path (the
 * debounced PUT) exactly as it was.
 */

import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import { jsonFetcher, softJsonFetcher, swrListOptions, swrKey } from "@/lib/swr";
import {
  DEFAULT_COLUMNS as SHARED_DEFAULT_COLUMNS,
  COLUMN_IDS as SHARED_COLUMN_IDS,
  isSortableColumnId,
  type ColumnId,
  type SortableColumnId,
} from "@/lib/transactions/columns";
import type { Account, Category, Holding, ColFilterShape, SortPref, ColumnPref } from "../_types";

const ALL_COLUMNS = SHARED_COLUMN_IDS as readonly ColumnId[];
const DEFAULT_COL_PREFS = SHARED_DEFAULT_COLUMNS;

function mergeColPrefs(saved: ColumnPref[] | null | undefined): ColumnPref[] {
  if (!saved || saved.length === 0) return DEFAULT_COL_PREFS;
  const seen = new Set<ColumnId>();
  const out: ColumnPref[] = [];
  for (const entry of saved) {
    if (!ALL_COLUMNS.includes(entry.id)) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push({ id: entry.id, visible: !!entry.visible });
  }
  for (const def of DEFAULT_COL_PREFS) {
    if (seen.has(def.id)) continue;
    out.push(def);
  }
  return out;
}

/**
 * Mount triplet — accounts / categories / holdings lookups. Pre-115 this was a
 * single mount effect firing three uncoordinated parallel fetches that
 * soft-failed to `[]`. Now three `useSWR` reads with the soft fetcher (same
 * `[]` fallback) — SWR de-dups + caches them across the app's transactions
 * subtree. Returns the same `{ accounts, categories, holdings }` arrays.
 */
export function useLookups() {
  // `includeArchived=1`: the transactions LIST already returns rows from
  // archived accounts (the query never filtered on `archived`), but this lookup
  // did — so an archived account was missing from the account filter and the
  // filter chips, and `buildTransactionQuery`'s `accountType` → account-ids
  // resolution silently dropped its rows from an Asset/Liability filter.
  // Create-mode pickers filter archived back out themselves (`!!editId ||` in
  // TransactionDialog); edit mode keeps them so an archived row still shows
  // its own account.
  const { data: accounts } = useSWR<Account[]>(
    swrKey("/api/accounts?includeArchived=1"),
    softJsonFetcher<Account[]>([]),
    swrListOptions,
  );
  const { data: categories } = useSWR<Category[]>(
    swrKey("/api/categories"),
    softJsonFetcher<Category[]>([]),
    swrListOptions,
  );
  const { data: holdings } = useSWR<Holding[]>(
    swrKey("/api/portfolio"),
    softJsonFetcher<Holding[]>([]),
    swrListOptions,
  );
  return {
    accounts: accounts ?? [],
    categories: categories ?? [],
    holdings: holdings ?? [],
  };
}

/**
 * Per-user table column layout (visibility + order) persisted via
 * /api/settings/tx-columns. Migrates the legacy localStorage["pf-tx-cols-v1"]
 * blob on first load (then clears it). Last-writer-wins on save (debounced 400ms).
 *
 * SWR fetches the raw server payload; the legacy-migration logic + editable
 * state seeding is run once on first arrival (the pre-115 load effect, verbatim,
 * minus the now-SWR-owned `fetch`).
 */
export function useTxColumnPrefs() {
  const [columnPrefs, setColumnPrefs] = useState<ColumnPref[]>(DEFAULT_COL_PREFS);
  const colPrefsLoaded = useRef(false);
  const colPrefsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: serverPayload, error } = useSWR<{ columns?: ColumnPref[] } | undefined>(
    swrKey("/api/settings/tx-columns"),
    jsonFetcher,
    swrListOptions,
  );

  // Seed editable state ONCE on first arrival (success OR error), running the
  // legacy-localStorage migration the pre-115 load effect did. The guard ref
  // stops a later background revalidate from clobbering unsaved local edits.
  useEffect(() => {
    if (colPrefsLoaded.current) return;
    if (serverPayload === undefined && !error) return; // still loading

    // Read the legacy localStorage blob only when the server endpoint has never
    // been written for this user — otherwise the server-side layout wins
    // (cross-device sync). The legacy blob is cleared after one migration.
    let legacy: ColumnPref[] | null = null;
    try {
      const raw = localStorage.getItem("pf-tx-cols-v1");
      if (raw) {
        const parsed = JSON.parse(raw) as { portfolio?: boolean };
        if (parsed && typeof parsed === "object") {
          legacy = DEFAULT_COL_PREFS.map((c) =>
            c.id === "portfolio" ? { ...c, visible: !!parsed.portfolio } : c,
          );
        }
      }
    } catch { /* ignore */ }

    if (!error && serverPayload !== undefined) {
      const d = serverPayload;
      const serverPrefs = mergeColPrefs(d?.columns ?? null);
      const isServerDefault = !d?.columns || d.columns.length === 0;
      if (legacy && isServerDefault) {
        setColumnPrefs(legacy);
        // Push the legacy preferences up so the migration sticks.
        void (async () => {
          try {
            await fetch("/api/settings/tx-columns", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ columns: legacy }),
            });
            localStorage.removeItem("pf-tx-cols-v1");
          } catch { /* best-effort */ }
        })();
      } else {
        setColumnPrefs(serverPrefs);
        try { localStorage.removeItem("pf-tx-cols-v1"); } catch { /* ignore */ }
      }
    } else if (legacy) {
      // GET failed (the pre-115 `else if (legacy)` / catch branch).
      setColumnPrefs(legacy);
    }
    colPrefsLoaded.current = true;
  }, [serverPayload, error]);

  // Debounced PUT-on-change — verbatim (same 400ms, same PUT contract).
  useEffect(() => {
    if (!colPrefsLoaded.current) return;
    if (colPrefsSaveTimer.current) clearTimeout(colPrefsSaveTimer.current);
    colPrefsSaveTimer.current = setTimeout(() => {
      fetch("/api/settings/tx-columns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columns: columnPrefs }),
      }).catch(() => { /* swallow — next save retries */ });
    }, 400);
    return () => {
      if (colPrefsSaveTimer.current) clearTimeout(colPrefsSaveTimer.current);
    };
  }, [columnPrefs]);

  const resetColPrefs = () => setColumnPrefs(DEFAULT_COL_PREFS);
  return { columnPrefs, setColumnPrefs, resetColPrefs };
}

/**
 * Per-user header sort (issue #59). Cycles desc → asc → null on repeated
 * clicks. Persisted via /api/settings/tx-sort (debounced 400ms).
 */
export function useTxSortPref(onChange?: () => void) {
  const [sortPref, setSortPref] = useState<SortPref>({ columnId: null, direction: null });
  const sortPrefLoaded = useRef(false);
  const sortPrefSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Soft GET: the pre-115 hook fell back to the default (unsorted) on !ok / error.
  const { data: loaded } = useSWR<SortPref | null>(
    swrKey("/api/settings/tx-sort"),
    softJsonFetcher<SortPref | null>(null),
    swrListOptions,
  );

  useEffect(() => {
    if (sortPrefLoaded.current) return;
    if (loaded === undefined) return; // still loading
    const d = loaded;
    if (
      d &&
      (d.columnId === null || isSortableColumnId(d.columnId)) &&
      (d.direction === null || d.direction === "asc" || d.direction === "desc")
    ) {
      setSortPref({ columnId: d.columnId, direction: d.direction });
    }
    sortPrefLoaded.current = true;
  }, [loaded]);

  useEffect(() => {
    if (!sortPrefLoaded.current) return;
    if (sortPrefSaveTimer.current) clearTimeout(sortPrefSaveTimer.current);
    sortPrefSaveTimer.current = setTimeout(() => {
      fetch("/api/settings/tx-sort", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sortPref),
      }).catch(() => { /* swallow */ });
    }, 400);
    return () => {
      if (sortPrefSaveTimer.current) clearTimeout(sortPrefSaveTimer.current);
    };
  }, [sortPref]);

  function cycleSort(columnId: SortableColumnId) {
    setSortPref((prev) => {
      if (prev.columnId !== columnId) return { columnId, direction: "desc" };
      if (prev.direction === "desc") return { columnId, direction: "asc" };
      return { columnId: null, direction: null };
    });
    onChange?.();
  }
  return { sortPref, setSortPref, cycleSort };
}

/**
 * Per-column filters (issue #59). Discriminated union by column type; persisted
 * via /api/settings/tx-filters (debounced 400ms). Each column has at most one
 * filter active at a time.
 */
export function useTxFilterPrefs(onChange?: () => void) {
  const [colFilters, setColFilters] = useState<ColFilterShape[]>([]);
  const colFiltersLoaded = useRef(false);
  const colFiltersSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Soft GET: the pre-115 hook fell back to no filters on !ok / error.
  const { data: loaded } = useSWR<{ filters?: ColFilterShape[] } | null>(
    swrKey("/api/settings/tx-filters"),
    softJsonFetcher<{ filters?: ColFilterShape[] } | null>(null),
    swrListOptions,
  );

  useEffect(() => {
    if (colFiltersLoaded.current) return;
    if (loaded === undefined) return; // still loading
    if (loaded?.filters) setColFilters(loaded.filters);
    colFiltersLoaded.current = true;
  }, [loaded]);

  useEffect(() => {
    if (!colFiltersLoaded.current) return;
    if (colFiltersSaveTimer.current) clearTimeout(colFiltersSaveTimer.current);
    colFiltersSaveTimer.current = setTimeout(() => {
      fetch("/api/settings/tx-filters", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: colFilters }),
      }).catch(() => { /* swallow */ });
    }, 400);
    return () => {
      if (colFiltersSaveTimer.current) clearTimeout(colFiltersSaveTimer.current);
    };
  }, [colFilters]);

  function findColFilter(columnId: ColumnId): ColFilterShape | undefined {
    return colFilters.find((f) => f.columnId === columnId);
  }
  function setColFilter(filter: ColFilterShape | null, columnId: ColumnId) {
    setColFilters((prev) => {
      const without = prev.filter((f) => f.columnId !== columnId);
      return filter ? [...without, filter] : without;
    });
    onChange?.();
  }
  return { colFilters, setColFilters, findColFilter, setColFilter };
}
