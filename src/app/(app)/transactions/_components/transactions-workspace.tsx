"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OnboardingTips } from "@/components/onboarding-tips";
import { Badge } from "@/components/ui/badge";
import { Plus, ChevronLeft, ChevronRight, SlidersHorizontal, ChevronDown, Receipt, Search, X, AlertTriangle, ArrowRightLeft, Columns3, TrendingUp, Download } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { SplitDialog } from "./split-dialog";
import { TransactionDialog, type TransactionDialogInitialState, type DialogLinkedSibling } from "@/components/transactions/transaction-dialog";
import { formatAccountLabel } from "@/lib/account-label";
import { type TransactionSource, labelForSource } from "@/lib/tx-source";
import {
  COLUMN_LABELS as SHARED_COLUMN_LABELS,
  TOGGLEABLE_COLUMN_IDS as SHARED_TOGGLEABLE_COLUMN_IDS,
  type ColumnId as SharedColumnId,
} from "@/lib/transactions/columns";
import type {
  Transaction,
  LinkedSibling,
} from "../_types";
import { useLookups, useTxColumnPrefs, useTxSortPref, useTxFilterPrefs } from "../_hooks/use-tx-prefs";
import { useTransactions } from "../_hooks/use-transactions";
import { TransactionTable } from "./transaction-table";
import { buildTransactionQuery } from "@/lib/transactions/build-query";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { exportCsv, type CsvColumn } from "@/lib/csv-export";
import { todayISO } from "@/lib/utils/date";
import { LotReallocationNotice } from "@/components/portfolio/lot-reallocation-notice";
import type { LotReallocationPreview } from "@/lib/portfolio/lots/types";

/**
 * TransactionsWorkspace — the full transactions surface (filters, per-column
 * customize, header sort, multi-select bulk update/delete, CSV export,
 * pagination, add/edit/split dialogs). Extracted from the `/transactions` page
 * so it can be REUSED verbatim on the account detail page (DRY).
 *
 * `/transactions` renders it with no props (full page). `/accounts/[id]`
 * renders it with `lockedAccountId` set, which:
 *   - seeds + FORCES the account filter to that account,
 *   - hides the account picker (the view is already scoped),
 *   - disables the URL⇄filter sync (the embedding page owns the URL/hash).
 * `showHeader={false}` drops the page title + Add-Transaction buttons (the
 * account page has its own quick-actions), and `onDataChange` lets the
 * embedding page refresh sibling data (e.g. the account balance header) after
 * any create/edit/delete/bulk mutation.
 */
export interface TransactionsWorkspaceProps {
  /** When set, scope the workspace to this account: force + hide the account
   *  filter and disable URL sync so it can be embedded in a page that owns the
   *  URL (e.g. `/accounts/[id]`). */
  lockedAccountId?: number;
  /** Render the page header (title + Add Transaction split-button). Default
   *  true; the account page passes false and keeps its own quick-actions. */
  showHeader?: boolean;
  /** Called after any create / edit / delete / bulk mutation so an embedding
   *  page can refresh sibling data (e.g. the account balance header). */
  onDataChange?: () => void;
}

export function TransactionsWorkspace({
  lockedAccountId,
  showHeader = true,
  onDataChange,
}: TransactionsWorkspaceProps = {}) {
  const locked = lockedAccountId != null;
  const urlParams = useSearchParams();
  const router = useRouter();
  // Lookups (accounts / categories / holdings) — extracted to useLookups
  // (FINLYNQ-111 Phase 2). Same uncoordinated mount-time parallel fetch.
  const { accounts, categories, holdings } = useLookups();
  const sortAccount = useDropdownOrder("account");
  const sortCategory = useDropdownOrder("category");
  const sortHolding = useDropdownOrder("holding");
  const [searchInput, setSearchInput] = useState("");
  // Filter state is synced FROM the URL via the `useEffect` below (not a
  // `useState(urlParams.get(...))` initialiser). `useState` only runs on
  // mount, so client-side drill-through navigation while already on
  // `/transactions` (e.g. clicking a dashboard/budget/portfolio drill link)
  // would NOT remount the component and the new query params were silently
  // ignored, leaving stale filters in place (FINLYNQ-130). The effect
  // re-syncs `filters` + `searchInput` and resets the page on every
  // `urlParams` change so a drill REPLACES (not merges) the prior filters.
  // `portfolioHolding` is a server-side post-decrypt filter (ciphertext-at-
  // rest on this column), `accountId` is a standard SQL filter.
  //
  // When `locked`, the account filter is seeded to `lockedAccountId` and the
  // URL⇄filter sync below is skipped entirely (the embedding page owns the URL).
  const [filters, setFilters] = useState({
    // FINLYNQ-177 — single-transaction deep link (`/transactions?id=<n>`).
    id: "",
    startDate: "",
    endDate: "",
    accountId: locked ? String(lockedAccountId) : "",
    categoryId: "",
    search: "",
    portfolioHolding: "",
    tag: "",
  });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  type ColumnId = SharedColumnId;
  const COLUMN_LABELS = SHARED_COLUMN_LABELS;
  const TOGGLEABLE_COLUMNS = new Set<ColumnId>(SHARED_TOGGLEABLE_COLUMN_IDS);

  // Pagination index lives at the page level (as it did pre-refactor) so the
  // sort/filter hooks can reset it to 0 on change without a forward reference.
  const [page, setPage] = useState(0);

  // FINLYNQ-130 — re-sync filters from the URL on every navigation (including
  // client-side drill-through while already mounted on /transactions). Resets
  // the page index and the controlled search input so a drill fully REPLACES
  // any prior filter state rather than merging into it. Skipped when `locked`
  // (the account-scoped embed keeps its forced accountId and ignores the URL).
  useEffect(() => {
    if (locked) return;
    setFilters({
      // FINLYNQ-177 — single-tx id deep link is URL-driven like the rest, so a
      // drill while already mounted REPLACES (not merges) prior filters.
      id: urlParams.get("id") ?? "",
      startDate: urlParams.get("startDate") ?? "",
      endDate: urlParams.get("endDate") ?? "",
      accountId: urlParams.get("accountId") ?? "",
      categoryId: urlParams.get("categoryId") ?? "",
      search: urlParams.get("search") ?? "",
      portfolioHolding: urlParams.get("portfolioHolding") ?? "",
      tag: urlParams.get("tag") ?? "",
    });
    setSearchInput(urlParams.get("search") ?? "");
    setPage(0);
  }, [urlParams, locked]);

  // Per-user table column layout (visibility + order), header sort, and
  // per-column filters — all extracted to hooks (FINLYNQ-111 Phase 2). Each
  // hook owns the same load-on-mount + debounced-PUT-on-change effects + the
  // legacy localStorage migration. `cycleSort` / `setColFilter` reset the page
  // to 0 via the onChange callback (verbatim with the old inline setPage(0)).
  const { columnPrefs, setColumnPrefs, resetColPrefs } = useTxColumnPrefs();
  const { sortPref, setSortPref, cycleSort } = useTxSortPref(() => setPage(0));
  const { colFilters, setColFilters, findColFilter, setColFilter } = useTxFilterPrefs(() => setPage(0));

  // Main list (txns / total / loading) + loadTxns — extracted to
  // useTransactions (FINLYNQ-111 Phase 2). Same deps, fetch URL, {data,total}
  // unwrap, and driving effect; `page` is owned by the page-level state above.
  const { txns, total, loading, limit, loadTxns } = useTransactions(
    filters,
    sortPref,
    colFilters,
    accounts,
    page,
  );

  // Post-mutation refresh: reload the list AND notify the embedding page so it
  // can refresh sibling data (e.g. the account balance header). Used after
  // every create / edit / delete / bulk action below.
  const afterMutate = useCallback(() => {
    loadTxns();
    onDataChange?.();
  }, [loadTxns, onDataChange]);

  // Native HTML5 drag state — id of the column currently being dragged. The
  // ondragover handler reorders in place, so we only need to track the source.
  const [draggingCol, setDraggingCol] = useState<ColumnId | null>(null);
  const onColDragStart = (id: ColumnId) => (e: React.DragEvent<HTMLTableCellElement>) => {
    setDraggingCol(id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch { /* ignore */ }
  };
  const onColDragOver = (id: ColumnId) => (e: React.DragEvent<HTMLTableCellElement>) => {
    if (!draggingCol || draggingCol === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setColumnPrefs((prev) => {
      const fromIdx = prev.findIndex((c) => c.id === draggingCol);
      const toIdx = prev.findIndex((c) => c.id === id);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };
  const onColDragEnd = () => setDraggingCol(null);

  const toggleCol = (id: ColumnId, value: boolean) => {
    setColumnPrefs((prev) => prev.map((c) => (c.id === id ? { ...c, visible: value } : c)));
  };

  // Add/edit dialog. State that used to live inline (form, transferForm,
  // FX preview, splits, etc.) now belongs to TransactionDialog. The parent
  // only tracks open + the seed `initialState` it hands the dialog on
  // open. startEdit builds the appropriate initialState; the dialog reads
  // it on the open transition.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] = useState<TransactionDialogInitialState | null>(null);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  // Phase 2 portfolio-ops refactor: server returns 409 with this shape when
  // the row being deleted is the open-tx of a lot that's already been sold
  // or transferred out. UI surfaces the blocking tx ids so the user knows
  // exactly which rows to delete first.
  const [deleteBlockedError, setDeleteBlockedError] = useState<{
    message: string;
    blockingIds: number[];
  } | null>(null);
  const [deleteConfirmPayee, setDeleteConfirmPayee] = useState("");
  const [deleting, setDeleting] = useState(false);
  // FINLYNQ-176 — warn-and-reallocate. When a delete is lot-locked, fetch the
  // dry-run preview so the user can see the proposed reallocation (affected
  // calendar years + any short lot that will open) and choose to proceed.
  const [reallocPreview, setReallocPreview] = useState<LotReallocationPreview | null>(null);
  const [reallocLoading, setReallocLoading] = useState(false);

  // Split dialog (for existing transactions)
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [splitTxn, setSplitTxn] = useState<Transaction | null>(null);

  // Bulk selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkAction, setBulkAction] = useState("");
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkAccountId, setBulkAccountId] = useState("");
  const [bulkDate, setBulkDate] = useState("");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkPayee, setBulkPayee] = useState("");
  const [bulkTags, setBulkTags] = useState("");
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  function handleSearchChange(value: string) {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: value }));
      setPage(0);
    }, 350);
  }

  function clearFilters() {
    setSearchInput("");
    // When locked, keep the account scope — only the OTHER filters clear.
    setFilters({ id: "", startDate: "", endDate: "", accountId: locked ? String(lockedAccountId) : "", categoryId: "", search: "", portfolioHolding: "", tag: "" });
    // Issue #59 — also wipe the per-column filters + sort. The chip row
    // below the top-bar shows both, so "Clear all" should drop both.
    setColFilters([]);
    setSortPref({ columnId: null, direction: null });
    setPage(0);
  }

  // ── CSV export of the current filtered view ──────────────────────────
  // Re-fetches GET /api/transactions with the SAME buildTransactionQuery the
  // table uses (FINLYNQ-115 — never hand-roll params), but with page 0 + a
  // high limit so a single request returns the whole filtered set. The route
  // caps the underlying candidate set at 1000 rows whenever a post-decrypt
  // (search / tag / encrypted-substring) filter is active — surfaced inline.
  const [exporting, setExporting] = useState(false);
  // Mirrors the server's `postDecryptFilter`: text search, tag, or any
  // text-type per-column filter forces the in-memory 1000-row pass.
  const hasTextSearchFilter =
    !!filters.search ||
    !!filters.tag ||
    colFilters.some((f) => f.type === "text");
  const exportColumns: CsvColumn<Transaction>[] = [
    { header: "Date", accessor: (t) => t.date },
    { header: "Account", accessor: (t) => t.accountAlias || t.accountName },
    { header: "Category", accessor: (t) => t.categoryName },
    { header: "Payee", accessor: (t) => t.payee },
    { header: "Note", accessor: (t) => t.note },
    { header: "Tags", accessor: (t) => t.tags },
    { header: "Quantity", accessor: (t) => t.quantity ?? "" },
    { header: "Amount", accessor: (t) => t.amount },
    { header: "Currency", accessor: (t) => t.currency },
    { header: "Portfolio", accessor: (t) => t.portfolioHolding ?? "" },
    { header: "Source", accessor: (t) => t.source ?? "" },
  ];

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      // Same builder + filter/sort state the table uses; page 0 + high limit
      // pulls the entire filtered view in one shot (the route honors `limit`
      // directly when no post-decrypt filter is set, else caps at 1000).
      const params = buildTransactionQuery(filters, sortPref, colFilters, accounts, {
        page: 0,
        limit: 100000,
      });
      const res = await fetch(`/api/transactions?${params}`);
      if (!res.ok) return;
      const json: { data?: Transaction[] } = await res.json();
      const rows = json.data ?? [];
      exportCsv(rows, exportColumns, `transactions-${todayISO()}.csv`);
    } finally {
      setExporting(false);
    }
  }

  /* resetForm / handleSubmit / handleTransferSubmit / handleTransferDelete
   * now live inside <TransactionDialog>. The parent only builds the
   * initialState seed in startEdit and refreshes the table via onSaved. */


  /** Edit-row entry point. Runs the four-check transfer detection by
   *  fetching siblings off `linkId` and decides which TransactionDialog
   *  initialState shape to seed. Async to keep the dialog from flickering
   *  open in transaction mode before flipping to transfer mode. */
  async function startEdit(t: Transaction) {
    // Phase 2 portfolio-ops refactor: portfolio-kind rows go to /portfolio/new
    // — the generic dialog can't safely edit paired rows because it would
    // leave the cash-leg sibling stale. `*_cash_leg` rows resolve back via
    // trade_link_id on the form's load path.
    if (t.kind) {
      const portfolioKinds = new Set([
        "buy",
        "sell",
        "buy_cash_leg",
        "sell_cash_leg",
        "in_kind_transfer_in",
        "in_kind_transfer_out",
        "fx_from",
        "fx_to",
        "fx_fee",
        "portfolio_income",
        "portfolio_expense",
        "brokerage_deposit_in",
        "brokerage_deposit_out",
        "brokerage_withdrawal_in",
        "brokerage_withdrawal_out",
      ]);
      if (portfolioKinds.has(t.kind)) {
        const opForKind: Record<string, string> = {
          buy: "buy",
          buy_cash_leg: "buy",
          sell: "sell",
          sell_cash_leg: "sell",
          in_kind_transfer_in: "transfer",
          in_kind_transfer_out: "transfer",
          fx_from: "fx-conversion",
          fx_to: "fx-conversion",
          fx_fee: "fx-conversion",
          portfolio_income: "income-expense",
          portfolio_expense: "income-expense",
          brokerage_deposit_in: "deposit",
          brokerage_deposit_out: "deposit",
          brokerage_withdrawal_in: "withdrawal",
          brokerage_withdrawal_out: "withdrawal",
        };
        const op = opForKind[t.kind] ?? "buy";
        router.push(`/portfolio/new?op=${op}&editId=${t.id}`);
        return;
      }
    }

    // Four-check rule for "open this in unified Transfer mode":
    //   1. row has link_id
    //   2. exactly one sibling shares the link_id (so N≤2 legs)
    //   3. the two rows reference DIFFERENT accounts
    // The legacy `category_type === 'R'` check was intentionally relaxed
    // (#8): transfer-shaped pairs whose category was renamed by the user
    // (e.g. `Non-Cash - Transfers`) still open here. Anything that fails
    // the rule (WP liquidations with N>2 legs, same-account conversions)
    // falls back to the standard transaction-mode edit + linked-siblings.
    let siblings: LinkedSibling[] = [];
    if (t.linkId) {
      try {
        const r = await fetch(
          `/api/transactions/linked?linkId=${encodeURIComponent(t.linkId)}&excludeId=${t.id}`,
        );
        const d = r.ok ? ((await r.json()) as { data?: LinkedSibling[] }) : { data: [] };
        siblings = Array.isArray(d.data) ? d.data : [];
      } catch {
        siblings = [];
      }
      const isCleanPair =
        siblings.length === 1 &&
        siblings[0].accountId != null &&
        siblings[0].accountId !== t.accountId;
      if (isCleanPair) {
        const sibling = siblings[0];
        // Direction: the negative-amount leg is the source.
        const debit: Transaction = t.amount < 0 ? t : ({ ...siblingToTransaction(sibling) });
        const credit: Transaction = t.amount < 0 ? siblingToTransaction(sibling) : t;
        setDialogInitial({
          kind: "transfer-edit",
          debit: debit as never,
          credit: credit as never,
          linkId: t.linkId!,
        });
        setDialogOpen(true);
        return;
      }
    }

    setDialogInitial({
      kind: "transaction-edit",
      tx: t as never,
      linkedSiblings: siblings as unknown as DialogLinkedSibling[],
    });
    setDialogOpen(true);
  }

  /** Convert a /api/transactions/linked sibling row into the Transaction
   *  shape the dialog expects. Sibling responses are partial — we coerce
   *  defaults where the table-row shape is wider. */
  function siblingToTransaction(s: LinkedSibling): Transaction {
    return {
      id: s.id,
      date: s.date,
      accountId: s.accountId ?? 0,
      accountName: s.accountName ?? "",
      categoryId: s.categoryId ?? 0,
      categoryName: s.categoryName ?? "",
      categoryType: s.categoryType ?? "",
      currency: s.currency,
      amount: s.amount,
      enteredAmount: s.enteredAmount,
      enteredCurrency: s.enteredCurrency,
      enteredFxRate: s.enteredFxRate,
      quantity: s.quantity,
      portfolioHolding: s.portfolioHolding,
      note: s.note ?? "",
      payee: s.payee ?? "",
      tags: s.tags ?? "",
      isBusiness: null,
      linkId: null,
    };
  }

  function openLinkedSibling(sibling: LinkedSibling) {
    const match = txns.find((t) => t.id === sibling.id);
    if (match) {
      startEdit(match);
      return;
    }
    // Sibling isn't on the current page — jump to the first page filtered
    // by date so the user can find it. The user can then click Edit.
    setFilters((f) => ({ ...f, startDate: sibling.date, endDate: sibling.date }));
    setPage(0);
    setDialogOpen(false);
  }

  function confirmDelete(t: Transaction) {
    setDeleteConfirmId(t.id);
    setDeleteConfirmPayee(t.payee || `Transaction #${t.id}`);
  }

  async function handleDelete() {
    if (!deleteConfirmId) return;
    setDeleting(true);
    setDeleteBlockedError(null);
    const res = await fetch(`/api/transactions?id=${deleteConfirmId}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      // Portfolio edit-guard refusal. The server returns 409 + the list of
      // dependent closure tx ids when the row being deleted opens a lot that's
      // been sold or transferred out. FINLYNQ-176 — instead of dead-ending,
      // fetch the reallocation preview so the user can proceed.
      const data = await res.json().catch(() => ({}));
      if (data?.code === "portfolio_edit_blocked") {
        const blockingIds: number[] = Array.isArray(data.blockingClosureTxIds)
          ? (data.blockingClosureTxIds as number[])
          : [];
        setDeleteBlockedError({
          message: data.error ?? "Delete blocked by portfolio dependencies",
          blockingIds,
        });
        // Fetch the dry-run reallocation preview (best-effort).
        setReallocPreview(null);
        setReallocLoading(true);
        try {
          const pRes = await fetch("/api/transactions/lot-replan-preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "delete", id: deleteConfirmId }),
          });
          if (pRes.ok) {
            const pData = await pRes.json().catch(() => null);
            if (pData?.preview) setReallocPreview(pData.preview as LotReallocationPreview);
          }
        } finally {
          setReallocLoading(false);
        }
        return;
      }
      alert(data?.error ?? `Delete failed (${res.status})`);
      return;
    }
    setDeleteConfirmId(null);
    setReallocPreview(null);
    afterMutate();
  }

  // FINLYNQ-176 — proceed with the lot-locked delete, reallocating dependents.
  async function handleReallocateDelete() {
    if (!deleteConfirmId) return;
    setDeleting(true);
    const res = await fetch(
      `/api/transactions?id=${deleteConfirmId}&confirmReallocation=1`,
      { method: "DELETE" },
    );
    setDeleting(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data?.error ?? `Delete failed (${res.status})`);
      return;
    }
    setDeleteConfirmId(null);
    setDeleteBlockedError(null);
    setReallocPreview(null);
    afterMutate();
  }

  function openSplitDialog(t: Transaction) {
    setSplitTxn(t);
    setSplitDialogOpen(true);
  }

  // Bulk selection helpers
  const allSelected = txns.length > 0 && txns.every((t) => selected.has(t.id));
  const someSelected = selected.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(txns.map((t) => t.id)));
    }
  }

  function toggleOne(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function resetBulkFields() {
    setBulkCategoryId("");
    setBulkAccountId("");
    setBulkDate("");
    setBulkNote("");
    setBulkPayee("");
    setBulkTags("");
  }

  async function executeBulkAction() {
    if (!someSelected) return;
    const ids = Array.from(selected);

    if (bulkAction === "delete") {
      setBulkDeleteConfirm(true);
      return;
    }

    setBulkProcessing(true);
    const body: Record<string, unknown> = { action: bulkAction, ids };
    if (bulkAction === "update_category") body.categoryId = Number(bulkCategoryId);
    if (bulkAction === "update_account") body.accountId = Number(bulkAccountId);
    if (bulkAction === "update_date") body.date = bulkDate;
    if (bulkAction === "update_note") body.note = bulkNote;
    if (bulkAction === "update_payee") body.payee = bulkPayee;
    if (bulkAction === "update_tags") body.tags = bulkTags;

    await fetch("/api/transactions/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSelected(new Set());
    setBulkAction("");
    resetBulkFields();
    setBulkProcessing(false);
    afterMutate();
  }

  async function confirmBulkDelete() {
    setBulkProcessing(true);
    await fetch("/api/transactions/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", ids: Array.from(selected) }),
    });
    setSelected(new Set());
    setBulkAction("");
    setBulkDeleteConfirm(false);
    setBulkProcessing(false);
    afterMutate();
  }

  const isBulkApplyDisabled =
    bulkProcessing ||
    !bulkAction ||
    (bulkAction === "update_category" && !bulkCategoryId) ||
    (bulkAction === "update_account" && !bulkAccountId) ||
    (bulkAction === "update_date" && !bulkDate) ||
    (bulkAction === "update_note" && bulkNote === "" && bulkAction === "update_note") ||
    (bulkAction === "update_payee" && bulkPayee === "" && bulkAction === "update_payee");

  const totalPages = Math.ceil(total / limit);

  function getPageNumbers(): (number | "ellipsis")[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i);
    const pages: (number | "ellipsis")[] = [0];
    if (page > 2) pages.push("ellipsis");
    for (let i = Math.max(1, page - 1); i <= Math.min(totalPages - 2, page + 1); i++) {
      pages.push(i);
    }
    if (page < totalPages - 3) pages.push("ellipsis");
    pages.push(totalPages - 1);
    return pages;
  }

  // Split allocated total for inline split editor
  return (
    /* FINLYNQ-52 (was issue #59 workaround): the (app)-shell width clamp
       was removed in src/app/(app)/layout.tsx, so this page no longer
       needs the negative-margin escape hatch. The card body still wraps
       the table in `overflow-x-auto` so long column lists scroll
       horizontally rather than truncate. */
    <div className="space-y-6">
      {showHeader && (
        <>
          <OnboardingTips page="transactions" />
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Transactions</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Manage and track all your financial transactions</p>
            </div>
            <div className="flex items-center gap-1.5">
              {/* Split button: main click → quick Transaction dialog. Chevron →
                  dropdown with every kind (Transfer + the 6 portfolio operations).
                  Phase 2 portfolio-ops UX (2026-05-25). */}
              <Button
                className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-sm"
                onClick={() => {
                  setDialogInitial(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4 mr-2" /> Add Transaction
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="More transaction types"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="min-w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Quick add</DropdownMenuLabel>
                    <DropdownMenuItem
                      onClick={() => {
                        setDialogInitial(null);
                        setDialogOpen(true);
                      }}
                    >
                      <Receipt className="h-4 w-4 mr-2" /> Transaction
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setDialogInitial({ kind: "transfer-create" });
                        setDialogOpen(true);
                      }}
                    >
                      <ArrowRightLeft className="h-4 w-4 mr-2" /> Transfer
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Portfolio operations</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=buy")}>
                      Buy
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=sell")}>
                      Sell
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=swap")}>
                      Swap
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=transfer")}>
                      In-kind transfer
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=income-expense")}>
                      Income / expense
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=fx-conversion")}>
                      FX conversion
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=deposit")}>
                      Brokerage deposit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => router.push("/portfolio/new?op=withdrawal")}>
                      Brokerage withdrawal
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                onClick={() => router.push("/portfolio/new")}
              >
                <TrendingUp className="h-4 w-4 mr-2" /> Investment Transactions
              </Button>
            </div>
          </div>
        </>
      )}
      {/* Add/edit dialog is always mounted — startEdit opens it even when the
          page header (and its Add button) is hidden on the account embed. */}
      <TransactionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        accounts={accounts}
        categories={categories}
        holdings={holdings}
        initialState={dialogInitial}
        onSaved={async () => {
          afterMutate();
        }}
        onRequestDelete={(t) => confirmDelete(t as Transaction)}
        onLinkedSiblingClick={(s) => openLinkedSibling(s as LinkedSibling)}
      />

      {/* Search + Filters */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-9 pr-8"
              placeholder="Search payee, note, or tags…"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {searchInput && (
              <button onClick={() => { setSearchInput(""); setFilters({ ...filters, search: "" }); setPage(0); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted transition-colors">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input type="date" className="w-36 h-8 text-xs" value={filters.startDate} onChange={(e) => { setFilters({ ...filters, startDate: e.target.value }); setPage(0); }} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" className="w-36 h-8 text-xs" value={filters.endDate} onChange={(e) => { setFilters({ ...filters, endDate: e.target.value }); setPage(0); }} />
            {/* Account picker is hidden on the account-scoped embed — the view
                is already locked to a single account (keep the other filters). */}
            {!locked && (
              <Combobox
                value={filters.accountId}
                onValueChange={(v) => { setFilters({ ...filters, accountId: v === "all" ? "" : v }); setPage(0); }}
                items={[
                  { value: "all", label: "All accounts" } satisfies ComboboxItemShape,
                  ...sortAccount(
                    accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: formatAccountLabel(a) })),
                    (a) => Number(a.value),
                    (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                  ),
                ]}
                placeholder="All accounts"
                searchPlaceholder="Search accounts…"
                emptyMessage="No matches"
                size="sm"
                className="h-8 w-40 text-xs"
              />
            )}
            <Combobox
              value={filters.categoryId}
              onValueChange={(v) => { setFilters({ ...filters, categoryId: v === "all" ? "" : v }); setPage(0); }}
              items={[
                { value: "all", label: "All categories" } satisfies ComboboxItemShape,
                ...sortCategory(
                  categories.map((c): ComboboxItemShape => ({ value: String(c.id), label: c.name })),
                  (c) => Number(c.value),
                  (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                ),
              ]}
              placeholder="All categories"
              searchPlaceholder="Search categories…"
              emptyMessage="No matches"
              size="sm"
              className="h-8 w-44 text-xs"
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
                    <Columns3 className="h-3.5 w-3.5" />
                    Columns
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="min-w-56 max-h-96 overflow-y-auto">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                  {columnPrefs
                    .filter((c) => TOGGLEABLE_COLUMNS.has(c.id))
                    .map((c) => (
                      <DropdownMenuCheckboxItem
                        key={c.id}
                        checked={c.visible}
                        onCheckedChange={(v) => toggleCol(c.id, !!v)}
                        closeOnClick={false}
                      >
                        {COLUMN_LABELS[c.id]}
                      </DropdownMenuCheckboxItem>
                    ))}
                  <button
                    type="button"
                    onClick={resetColPrefs}
                    className="w-full text-left px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors mt-1 border-t"
                  >
                    Reset to default
                  </button>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {(filters.id || filters.startDate || filters.endDate || (!locked && filters.accountId) || filters.categoryId || filters.search || filters.portfolioHolding || filters.tag || colFilters.length > 0 || sortPref.columnId) && (
              <button onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors ml-1">
                <X className="h-3 w-3" /> Clear all
              </button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5 ml-auto"
              onClick={handleExport}
              disabled={exporting || total === 0}
            >
              <Download className="h-3.5 w-3.5" />
              {exporting ? "Exporting…" : "Export CSV"}
            </Button>
          </div>
          {hasTextSearchFilter && (
            <p className="text-xs text-muted-foreground">
              Exports of a text-searched view are capped at the first 1,000 matching transactions.
            </p>
          )}
          {/* Issue #59 — per-column filter chips. Each chip drops just its
              own filter when clicked; "Clear all" above wipes the lot. */}
          {(colFilters.length > 0 || sortPref.columnId) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Column filters:</span>
              {sortPref.columnId && sortPref.direction && (
                <Badge variant="outline" className="h-7 gap-1.5 pr-1 border-primary/30 bg-primary/5 text-primary">
                  <span className="font-medium text-xs">
                    Sort: {COLUMN_LABELS[sortPref.columnId]} {sortPref.direction === "asc" ? "↑" : "↓"}
                  </span>
                  <button
                    onClick={() => setSortPref({ columnId: null, direction: null })}
                    className="p-0.5 rounded hover:bg-primary/10 transition-colors"
                    aria-label="Clear sort"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {colFilters.map((f) => {
                const label = COLUMN_LABELS[f.columnId];
                let summary: string;
                if (f.type === "date") {
                  summary = `${f.from ?? "…"} → ${f.to ?? "…"}`;
                } else if (f.type === "text") {
                  summary = `“${f.value}”`;
                } else if (f.type === "numeric") {
                  if (f.op === "between") summary = `${f.value} – ${f.value2 ?? "?"}`;
                  else summary = `${f.op === "eq" ? "=" : f.op === "gt" ? ">" : "<"} ${f.value}`;
                } else {
                  // enum — render labelled values where we can
                  const labels = f.values.map((v) => {
                    if (f.columnId === "source") return labelForSource(v as TransactionSource);
                    if (f.columnId === "category") {
                      const cat = categories.find((c) => String(c.id) === v);
                      return cat?.name ?? v;
                    }
                    if (f.columnId === "account") {
                      const a = accounts.find((aa) => String(aa.id) === v);
                      return a?.name ?? v;
                    }
                    return v;
                  });
                  summary = labels.length <= 2 ? labels.join(", ") : `${labels[0]} + ${labels.length - 1} more`;
                }
                return (
                  <Badge key={f.columnId} variant="outline" className="h-7 gap-1.5 pr-1">
                    <span className="font-medium text-xs">{label}: {summary}</span>
                    <button
                      onClick={() => setColFilter(null, f.columnId)}
                      className="p-0.5 rounded hover:bg-muted transition-colors"
                      aria-label={`Clear ${label} filter`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          )}
          {filters.portfolioHolding && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Holding:</span>
              <Badge variant="outline" className="h-7 gap-1.5 pr-1 border-primary/30 bg-primary/5 text-primary">
                <span className="font-medium">{filters.portfolioHolding}</span>
                <button
                  onClick={() => { setFilters({ ...filters, portfolioHolding: "" }); setPage(0); }}
                  className="p-0.5 rounded hover:bg-primary/10 transition-colors"
                  aria-label="Clear holding filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </div>
          )}
          {filters.tag && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Tag:</span>
              <Badge variant="outline" className="h-7 gap-1.5 pr-1 border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300">
                <span className="font-medium font-mono">{filters.tag}</span>
                <button
                  onClick={() => { setFilters({ ...filters, tag: "" }); setPage(0); }}
                  className="p-0.5 rounded hover:bg-sky-100 dark:hover:bg-sky-900 transition-colors"
                  aria-label="Clear tag filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </div>
          )}
          {/* FINLYNQ-177 — single-transaction id deep link chip. Clearing it
              drops the filter so the user can step back to the full list. */}
          {filters.id && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Transaction:</span>
              <Badge variant="outline" className="h-7 gap-1.5 pr-1 border-primary/30 bg-primary/5 text-primary">
                <span className="font-medium font-mono">#{filters.id}</span>
                <button
                  onClick={() => { setFilters({ ...filters, id: "" }); setPage(0); }}
                  className="p-0.5 rounded hover:bg-primary/10 transition-colors"
                  aria-label="Clear single-transaction filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bulk action bar */}
      {someSelected && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg text-sm">
          <span className="font-medium text-primary">{selected.size} selected</span>
          <div className="flex items-center gap-2 flex-1 flex-wrap">
            <Select value={bulkAction} onValueChange={(v) => { setBulkAction(v ?? ""); resetBulkFields(); }}>
              <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="Choose action…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="update_category">Change category</SelectItem>
                <SelectItem value="update_account">Change account</SelectItem>
                <SelectItem value="update_date">Change date</SelectItem>
                <SelectItem value="update_payee">Change payee</SelectItem>
                <SelectItem value="update_note">Change note</SelectItem>
                <SelectItem value="update_tags">Change tags</SelectItem>
                <SelectItem value="delete">Delete selected</SelectItem>
              </SelectContent>
            </Select>
            {bulkAction === "update_category" && (
              <Combobox
                value={bulkCategoryId}
                onValueChange={(v) => setBulkCategoryId(v)}
                items={sortCategory(
                  categories.map((c): ComboboxItemShape => ({ value: String(c.id), label: `${c.group} — ${c.name}` })),
                  (c) => Number(c.value),
                  (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                )}
                placeholder="Select category"
                searchPlaceholder="Search categories…"
                emptyMessage="No matches"
                size="sm"
                className="h-7 w-44 text-xs"
              />
            )}
            {bulkAction === "update_account" && (
              <Combobox
                value={bulkAccountId}
                onValueChange={(v) => setBulkAccountId(v)}
                items={sortAccount(
                  accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
                  (a) => Number(a.value),
                  (a, z) => (a.label ?? "").localeCompare(z.label ?? ""),
                )}
                placeholder="Select account"
                searchPlaceholder="Search accounts…"
                emptyMessage="No matches"
                size="sm"
                className="h-7 w-44 text-xs"
              />
            )}
            {bulkAction === "update_date" && (
              <Input type="date" className="h-7 text-xs w-36" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} />
            )}
            {bulkAction === "update_payee" && (
              <Input className="h-7 text-xs w-44" placeholder="New payee" value={bulkPayee} onChange={(e) => setBulkPayee(e.target.value)} />
            )}
            {bulkAction === "update_note" && (
              <Input className="h-7 text-xs w-44" placeholder="New note" value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} />
            )}
            {bulkAction === "update_tags" && (
              <Input className="h-7 text-xs w-44" placeholder="New tags" value={bulkTags} onChange={(e) => setBulkTags(e.target.value)} />
            )}
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={executeBulkAction}
              disabled={isBulkApplyDisabled}
              variant={bulkAction === "delete" ? "destructive" : "default"}
            >
              {bulkProcessing ? "Processing…" : "Apply"}
            </Button>
          </div>
          <button onClick={() => setSelected(new Set())} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Table — extracted to <TransactionTable> (FINLYNQ-111 Phase 2). */}
      <Card>
        <CardContent className="p-0">
          <TransactionTable
            loading={loading}
            txns={txns}
            columnPrefs={columnPrefs}
            accounts={accounts}
            categories={categories}
            selected={selected}
            allSelected={allSelected}
            draggingCol={draggingCol}
            sortPref={sortPref}
            filters={filters}
            setFilters={(f) => setFilters(f as typeof filters)}
            setPage={setPage}
            toggleAll={toggleAll}
            toggleOne={toggleOne}
            cycleSort={cycleSort}
            findColFilter={findColFilter}
            setColFilter={setColFilter}
            onColDragStart={onColDragStart}
            onColDragOver={onColDragOver}
            onColDragEnd={onColDragEnd}
            startEdit={startEdit}
            openSplitDialog={openSplitDialog}
            confirmDelete={confirmDelete}
          />
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {total === 0 ? 0 : page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
        </p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {getPageNumbers().map((p, idx) =>
            p === "ellipsis" ? (
              <span key={`ellipsis-${idx}`} className="px-2 text-sm text-muted-foreground">...</span>
            ) : (
              <Button key={p} variant={page === p ? "default" : "outline"} size="sm" className="h-8 w-8 p-0 text-sm" onClick={() => setPage(p)}>
                {p + 1}
              </Button>
            )
          )}
          <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Single delete confirmation dialog */}
      <Dialog open={deleteConfirmId !== null} onOpenChange={(open) => {
        if (!open && !deleting) {
          setDeleteConfirmId(null);
          setDeleteBlockedError(null);
          setReallocPreview(null);
        }
      }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete Transaction
            </DialogTitle>
          </DialogHeader>
          {deleteBlockedError ? (
            <div className="space-y-3">
              <p className="text-sm text-amber-900 dark:text-amber-200">
                This transaction opened a lot that has since been sold or
                transferred out. You can still delete it — the dependent
                transactions below will be re-matched to your other lots.
              </p>
              {/* FINLYNQ-176 — reallocation preview (affected years + shorts). */}
              <LotReallocationNotice preview={reallocPreview} loading={reallocLoading} />
              {deleteBlockedError.blockingIds.length > 0 && (
                <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
                  <p className="font-medium mb-1.5">Dependent rows:</p>
                  <ul className="space-y-1">
                    {deleteBlockedError.blockingIds.map((id) => (
                      <li key={id}>
                        <Link
                          href={buildTxDrillUrl({ id: String(id) })}
                          className="text-primary underline hover:no-underline"
                          onClick={() => {
                            setDeleteConfirmId(null);
                            setDeleteBlockedError(null);
                            setReallocPreview(null);
                          }}
                        >
                          Transaction #{id}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-2 mt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={deleting}
                  onClick={() => {
                    setDeleteConfirmId(null);
                    setDeleteBlockedError(null);
                    setReallocPreview(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={deleting || reallocLoading}
                  onClick={handleReallocateDelete}
                >
                  {deleting ? "Deleting…" : "Reallocate & delete"}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Are you sure you want to delete <strong>{deleteConfirmPayee}</strong>? This cannot be undone.
              </p>
              <div className="flex gap-2 mt-2">
                <Button variant="outline" className="flex-1" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
                <Button variant="destructive" className="flex-1" disabled={deleting} onClick={handleDelete}>
                  {deleting ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirmation dialog */}
      <Dialog open={bulkDeleteConfirm} onOpenChange={(open) => { if (!open) setBulkDeleteConfirm(false); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete {selected.size} Transactions
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete <strong>{selected.size} transaction{selected.size !== 1 ? "s" : ""}</strong>. This cannot be undone.
          </p>
          <div className="flex gap-2 mt-2">
            <Button variant="outline" className="flex-1" onClick={() => setBulkDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" className="flex-1" disabled={bulkProcessing} onClick={confirmBulkDelete}>
              {bulkProcessing ? "Deleting…" : `Delete ${selected.size}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Split dialog (for existing transactions) */}
      {splitTxn && (
        <SplitDialog
          open={splitDialogOpen}
          onOpenChange={(open) => { setSplitDialogOpen(open); if (!open) setSplitTxn(null); }}
          transactionId={splitTxn.id}
          totalAmount={splitTxn.amount}
          currency={splitTxn.currency}
          categories={categories}
          accounts={accounts}
          onSaved={afterMutate}
        />
      )}
    </div>
  );
}
