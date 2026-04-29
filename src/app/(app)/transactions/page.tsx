"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OnboardingTips } from "@/components/onboarding-tips";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { SUPPORTED_FIAT_CURRENCIES } from "@/lib/fx/supported-currencies";
import { Plus, ChevronLeft, ChevronRight, Trash2, Pencil, SlidersHorizontal, ChevronDown, Receipt, Search, X, Scissors, AlertTriangle, Link2, ArrowRightLeft, Columns3 } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";
import { SplitDialog } from "./_components/split-dialog";
import { formatAccountLabel } from "@/lib/account-label";

type Transaction = {
  id: number;
  date: string;
  accountId: number;
  accountName: string;
  accountAlias?: string | null;
  accountType?: string | null;
  categoryId: number;
  categoryName: string;
  categoryType: string;
  currency: string;
  amount: number;
  // Phase 2 currency rework — entered/account trilogy. Server may or may not
  // populate these (older rows + GET responses that pre-date the column
  // selection won't); use the soft-fallback chokepoint at every read site.
  enteredAmount?: number | null;
  enteredCurrency?: string | null;
  enteredFxRate?: number | null;
  quantity: number | null;
  portfolioHolding: string | null;
  // Ticker for the transaction's holding (e.g. "VGRO.TO"). Surfaced so the
  // optional Ticker column doesn't need a separate fetch per row.
  portfolioHoldingSymbol?: string | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number | null;
  linkId: string | null;
};

type LinkedSibling = {
  id: number;
  date: string;
  accountId: number | null;
  accountName: string | null;
  accountCurrency: string | null;
  categoryId: number | null;
  categoryName: string | null;
  // Returned by /api/transactions/linked so the client can run the four-check
  // rule for "is this a transfer pair I should open in unified Transfer mode?"
  categoryType: string | null;
  amount: number;
  currency: string;
  enteredAmount: number | null;
  enteredCurrency: string | null;
  enteredFxRate: number | null;
  quantity: number | null;
  portfolioHolding: string | null;
  payee: string | null;
  note: string | null;
  tags: string | null;
};

type Account = { id: number; name: string; currency: string; alias?: string | null; type?: string | null };
type Category = { id: number; name: string; type: string; group: string };
type Holding = {
  id: number;
  name: string;
  symbol: string | null;
  accountName: string | null;
  // Sum of transactions.quantity for this holding — surfaces in the in-kind
  // Source / Destination dropdowns so the user can see current positions.
  currentShares?: number | null;
};

type SplitRow = {
  categoryId: string;
  amount: string;
  note: string;
};

const categoryColorMap: Record<string, string> = {
  income: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  expense: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
  transfer: "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300",
  investment: "border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

function getCategoryBadgeClass(categoryType: string): string {
  const key = categoryType?.toLowerCase() ?? "";
  return categoryColorMap[key] ?? "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300";
}

function TableSkeleton() {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="h-4 w-20 rounded bg-muted animate-pulse" />
          <div className="h-4 w-24 rounded bg-muted animate-pulse" />
          <div className="h-5 w-16 rounded-full bg-muted animate-pulse" />
          <div className="h-4 w-28 rounded bg-muted animate-pulse" />
          <div className="h-4 w-32 rounded bg-muted animate-pulse flex-1" />
          <div className="h-4 w-20 rounded bg-muted animate-pulse ml-auto" />
          <div className="h-6 w-14 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// Split indicator — shows a small badge if the transaction has splits
function SplitBadge({ transactionId }: { transactionId: number }) {
  const [hasSplits, setHasSplits] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`/api/transactions/splits?transactionId=${transactionId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: unknown[]) => setHasSplits(d.length > 0))
      .catch(() => setHasSplits(false));
  }, [transactionId]);

  if (!hasSplits) return null;
  return (
    <Badge variant="outline" className="text-[10px] border-violet-300 bg-violet-50 text-violet-700 ml-1">
      split
    </Badge>
  );
}

const emptySplitRow = (): SplitRow => ({ categoryId: "", amount: "", note: "" });

// useSearchParams requires Suspense. The inner component owns the page
// state + side effects; the default export just wraps it.
export default function TransactionsPage() {
  return (
    <Suspense fallback={<TableSkeleton />}>
      <TransactionsPageInner />
    </Suspense>
  );
}

function TransactionsPageInner() {
  const urlParams = useSearchParams();
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  // Initialize from URL params so /portfolio can deep-link into a scoped view.
  // `portfolioHolding` is a server-side post-decrypt filter (ciphertext-at-
  // rest on this column), `accountId` is a standard SQL filter.
  const [filters, setFilters] = useState({
    startDate: urlParams.get("startDate") ?? "",
    endDate: urlParams.get("endDate") ?? "",
    accountId: urlParams.get("accountId") ?? "",
    categoryId: urlParams.get("categoryId") ?? "",
    search: urlParams.get("search") ?? "",
    portfolioHolding: urlParams.get("portfolioHolding") ?? "",
    tag: urlParams.get("tag") ?? "",
  });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-user table column layout (visibility + order) persisted via
  // /api/settings/tx-columns. Mirrors display-currency's pattern — last-
  // writer-wins is acceptable for column prefs. Migrates the legacy
  // localStorage["pf-tx-cols-v1"] blob on first load (then clears it) so
  // existing users keep their Portfolio toggle.
  type ColumnId =
    | "select"
    | "date"
    | "account"
    | "accountType"
    | "accountName"
    | "accountAlias"
    | "category"
    | "payee"
    | "portfolio"
    | "portfolioTicker"
    | "note"
    | "tags"
    | "quantity"
    | "amount"
    | "actions";
  type ColumnPref = { id: ColumnId; visible: boolean };
  const ALL_COLUMNS: ColumnId[] = [
    "select",
    "date",
    "account",
    "accountType",
    "accountName",
    "accountAlias",
    "category",
    "payee",
    "portfolio",
    "portfolioTicker",
    "note",
    "tags",
    "quantity",
    "amount",
    "actions",
  ];
  const COLUMN_LABELS: Record<ColumnId, string> = {
    select: "Select",
    date: "Date",
    account: "Account",
    accountType: "Account type",
    accountName: "Account name",
    accountAlias: "Account alias",
    category: "Category",
    payee: "Payee",
    portfolio: "Portfolio",
    portfolioTicker: "Ticker",
    note: "Note",
    tags: "Tags",
    quantity: "Qty",
    amount: "Amount",
    actions: "Actions",
  };
  // select + actions are render scaffolding (checkbox column + the per-row
  // edit/split/delete icon group). Hiding them would break bulk selection
  // and inline editing — keep them locked on.
  const TOGGLEABLE_COLUMNS: Set<ColumnId> = new Set([
    "date",
    "account",
    "accountType",
    "accountName",
    "accountAlias",
    "category",
    "payee",
    "portfolio",
    "portfolioTicker",
    "note",
    "tags",
    "quantity",
    "amount",
  ]);
  const DEFAULT_COL_PREFS: ColumnPref[] = [
    { id: "select", visible: true },
    { id: "date", visible: true },
    { id: "account", visible: true },
    { id: "accountType", visible: false },
    { id: "accountName", visible: false },
    { id: "accountAlias", visible: false },
    { id: "category", visible: true },
    { id: "payee", visible: true },
    { id: "portfolio", visible: false },
    { id: "portfolioTicker", visible: false },
    { id: "note", visible: true },
    { id: "tags", visible: false },
    { id: "quantity", visible: true },
    { id: "amount", visible: true },
    { id: "actions", visible: true },
  ];
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
  const [columnPrefs, setColumnPrefs] = useState<ColumnPref[]>(DEFAULT_COL_PREFS);
  const colPrefsLoaded = useRef(false);
  const colPrefsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Read the legacy localStorage blob only when the server endpoint has
      // never been written for this user — otherwise the server-side layout
      // wins (cross-device sync). The legacy blob is cleared after one
      // successful migration.
      let legacy: ColumnPref[] | null = null;
      try {
        const raw = localStorage.getItem("pf-tx-cols-v1");
        if (raw) {
          const parsed = JSON.parse(raw) as { portfolio?: boolean };
          if (parsed && typeof parsed === "object") {
            legacy = DEFAULT_COL_PREFS.map((c) =>
              c.id === "portfolio"
                ? { ...c, visible: !!parsed.portfolio }
                : c,
            );
          }
        }
      } catch { /* ignore */ }
      try {
        const r = await fetch("/api/settings/tx-columns");
        if (cancelled) return;
        if (r.ok) {
          const d = (await r.json()) as { columns?: ColumnPref[] };
          const serverPrefs = mergeColPrefs(d?.columns ?? null);
          // If the server has the canonical defaults AND we have a legacy
          // blob, push the legacy preferences up so the migration sticks.
          const isServerDefault =
            !d?.columns || d.columns.length === 0;
          if (legacy && isServerDefault) {
            setColumnPrefs(legacy);
            try {
              await fetch("/api/settings/tx-columns", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ columns: legacy }),
              });
              localStorage.removeItem("pf-tx-cols-v1");
            } catch { /* best-effort */ }
          } else {
            setColumnPrefs(serverPrefs);
            try { localStorage.removeItem("pf-tx-cols-v1"); } catch { /* ignore */ }
          }
        } else if (legacy) {
          setColumnPrefs(legacy);
        }
      } catch {
        if (legacy) setColumnPrefs(legacy);
      } finally {
        if (!cancelled) colPrefsLoaded.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);
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
  const isColVisible = (id: ColumnId): boolean => {
    const e = columnPrefs.find((c) => c.id === id);
    return e ? e.visible : true;
  };
  const toggleCol = (id: ColumnId, value: boolean) => {
    setColumnPrefs((prev) => prev.map((c) => (c.id === id ? { ...c, visible: value } : c)));
  };
  const resetColPrefs = () => setColumnPrefs(DEFAULT_COL_PREFS);
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

  // Add/edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form, setForm] = useState({
    date: new Date().toISOString().split("T")[0],
    accountId: "",
    categoryId: "",
    currency: "CAD",
    amount: "",
    payee: "",
    note: "",
    tags: "",
    isBusiness: false,
    quantity: "",
    portfolioHoldingId: "",
  });

  // Dialog mode — when set to 'transfer', the form swaps to a unified
  // From/To/Amount layout that creates BOTH legs atomically with a shared
  // link_id. On edit, we auto-route to 'transfer' mode if the row being
  // edited satisfies the four-check rule (link_id non-null, exactly one
  // sibling, both type='R', different accounts) — see startEdit below.
  type DialogMode = "transaction" | "transfer";
  const [dialogMode, setDialogMode] = useState<DialogMode>("transaction");

  // Transfer-pair edit: when editing a pair, both legs are loaded and the
  // server identifies the pair via this linkId on PUT/DELETE. Source/dest
  // ids are also kept so submit sends the correct shape.
  const [transferEdit, setTransferEdit] = useState<{
    linkId: string;
    fromTxId: number;
    toTxId: number;
  } | null>(null);

  // Transfer-mode form state. amount is in the source account's currency
  // (always positive — the helper applies signs internally). receivedAmount
  // is only used when source.currency !== dest.currency, and is editable
  // (auto-derived from FX preview by default; user can override to capture
  // the bank's actual landed amount). When inKind is true, holding +
  // quantity move shares between brokerage accounts; amount may be 0 for
  // pure in-kind moves.
  const [transferForm, setTransferForm] = useState({
    date: new Date().toISOString().split("T")[0],
    fromAccountId: "",
    toAccountId: "",
    amount: "",
    receivedAmount: "",
    inKind: false,
    holdingName: "",
    // Optional override — when blank, server defaults destination-side
    // resolution to holdingName. Set to a different label when the
    // destination brokerage uses a different name for the same instrument
    // (e.g. "Gold Ounce" → "Au Bullion") OR when the user wants to bind
    // to an existing dest holding with a different name.
    destHoldingName: "",
    quantity: "",
    // Optional destination quantity — defaults to quantity. Differs in
    // splits / mergers / share-class conversions: source 100 of A may
    // arrive as 60 of B.
    destQuantity: "",
    note: "",
    tags: "",
  });
  // Did the user explicitly pick a destination holding? When false, the
  // dropdown defaults to "same as source" and the helper resolves dest with
  // the source name (auto-create if missing).
  const [destHoldingTouched, setDestHoldingTouched] = useState(false);
  // Did the user explicitly type a destination quantity? When false, the
  // input mirrors `quantity` and the API call omits destQuantity (server
  // defaults dest = source).
  const [destQuantityTouched, setDestQuantityTouched] = useState(false);
  // Has the user manually edited receivedAmount? If so, FX preview no
  // longer auto-fills it.
  const [transferReceivedTouched, setTransferReceivedTouched] = useState(false);

  // Inline split rows in the add/edit form (Task 6)
  const [showSplits, setShowSplits] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRow[]>([emptySplitRow(), emptySplitRow()]);

  // Live FX preview for the entered/account-currency trilogy. When the
  // entered currency differs from the selected account's currency, show a
  // small read-only line under the amount input with the converted amount,
  // rate, source ("cache"/"override"/"yahoo"/...), and date. 300ms debounce.
  type FxPreview =
    | { state: "idle" }
    | { state: "loading" }
    | { state: "ok"; rate: number; source: string; converted: number; date: string; to: string }
    | { state: "needs-override" }
    | { state: "error"; message: string };
  const [fxPreview, setFxPreview] = useState<FxPreview>({ state: "idle" });
  const fxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Same shape, separate state for the transfer-mode preview (source ccy →
  // destination ccy). When 'ok', auto-fills `transferForm.receivedAmount`
  // unless the user has manually edited it (transferReceivedTouched).
  const [transferFxPreview, setTransferFxPreview] = useState<FxPreview>({ state: "idle" });
  const transferFxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline error surfaced when the server rejects a write because the FX rate
  // for the entered currency is unavailable (response code:
  // 'fx-currency-needs-override'). Cleared on next submit attempt + on dialog
  // close.
  const [submitError, setSubmitError] = useState<{ message: string; currency?: string } | null>(null);

  // Linked sibling transactions (other legs of a multi-leg import)
  const [linkedSiblings, setLinkedSiblings] = useState<LinkedSibling[]>([]);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteConfirmPayee, setDeleteConfirmPayee] = useState("");
  const [deleting, setDeleting] = useState(false);

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

  const limit = 50;

  const loadTxns = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.startDate) params.set("startDate", filters.startDate);
    if (filters.endDate) params.set("endDate", filters.endDate);
    if (filters.accountId) params.set("accountId", filters.accountId);
    if (filters.categoryId) params.set("categoryId", filters.categoryId);
    if (filters.search) params.set("search", filters.search);
    if (filters.portfolioHolding) params.set("portfolioHolding", filters.portfolioHolding);
    if (filters.tag) params.set("tag", filters.tag);
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    fetch(`/api/transactions?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setTxns(d.data ?? []);
        setTotal(d.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [filters, page]);

  useEffect(() => { loadTxns(); }, [loadTxns]);

  useEffect(() => {
    fetch("/api/accounts").then((r) => r.ok ? r.json() : []).then(setAccounts);
    fetch("/api/categories").then((r) => r.ok ? r.json() : []).then(setCategories);
    fetch("/api/portfolio").then((r) => r.ok ? r.json() : []).then(setHoldings);
  }, []);

  // Debounced live FX preview. Fires when (entered currency, account,
  // amount, date) are all set AND entered currency differs from the
  // account's currency. Same-currency case short-circuits to idle so we
  // don't flash a redundant "Account: X.XX = X.XX" row.
  useEffect(() => {
    if (fxTimer.current) clearTimeout(fxTimer.current);
    if (!dialogOpen) {
      setFxPreview({ state: "idle" });
      return;
    }
    const acct = accounts.find((a) => String(a.id) === form.accountId);
    const accountCurrency = acct?.currency;
    const amountNum = parseFloat(form.amount);
    if (
      !accountCurrency ||
      !form.currency ||
      !form.amount ||
      !Number.isFinite(amountNum) ||
      amountNum === 0 ||
      form.currency === accountCurrency
    ) {
      setFxPreview({ state: "idle" });
      return;
    }
    setFxPreview({ state: "loading" });
    fxTimer.current = setTimeout(() => {
      const params = new URLSearchParams({
        from: form.currency,
        to: accountCurrency,
        date: form.date,
        amount: String(Math.abs(amountNum)),
      });
      fetch(`/api/fx/preview?${params}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setFxPreview({ state: "error", message: d?.error ?? "Rate lookup failed" });
            return;
          }
          if (d?.needsOverride === true) {
            setFxPreview({ state: "needs-override" });
            return;
          }
          // Preserve the input sign on the converted preview.
          const sign = amountNum < 0 ? -1 : 1;
          setFxPreview({
            state: "ok",
            rate: Number(d.rate ?? 0),
            source: String(d.source ?? "—"),
            converted: sign * Number(d.converted ?? 0),
            date: String(d.date ?? form.date),
            to: accountCurrency,
          });
        })
        .catch((e) => setFxPreview({ state: "error", message: String(e?.message ?? "Network error") }));
    }, 300);
    return () => {
      if (fxTimer.current) clearTimeout(fxTimer.current);
    };
  }, [dialogOpen, form.accountId, form.amount, form.currency, form.date, accounts]);

  // Transfer-mode FX preview. Watches the source/destination accounts +
  // entered amount + date, and when the two accounts have different
  // currencies fetches a converted preview. On 'ok' it auto-populates
  // transferForm.receivedAmount unless the user has manually edited it.
  useEffect(() => {
    if (transferFxTimer.current) clearTimeout(transferFxTimer.current);
    if (!dialogOpen || dialogMode !== "transfer") {
      setTransferFxPreview({ state: "idle" });
      return;
    }
    const fromAcct = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
    const toAcct = accounts.find((a) => String(a.id) === transferForm.toAccountId);
    const amountNum = parseFloat(transferForm.amount);
    if (
      !fromAcct ||
      !toAcct ||
      !transferForm.amount ||
      !Number.isFinite(amountNum) ||
      amountNum <= 0 ||
      fromAcct.currency === toAcct.currency
    ) {
      setTransferFxPreview({ state: "idle" });
      return;
    }
    setTransferFxPreview({ state: "loading" });
    transferFxTimer.current = setTimeout(() => {
      const params = new URLSearchParams({
        from: fromAcct.currency,
        to: toAcct.currency,
        date: transferForm.date,
        amount: String(amountNum),
      });
      fetch(`/api/fx/preview?${params}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) {
            setTransferFxPreview({ state: "error", message: d?.error ?? "Rate lookup failed" });
            return;
          }
          if (d?.needsOverride === true) {
            setTransferFxPreview({ state: "needs-override" });
            return;
          }
          const converted = Number(d.converted ?? 0);
          setTransferFxPreview({
            state: "ok",
            rate: Number(d.rate ?? 0),
            source: String(d.source ?? "—"),
            converted,
            date: String(d.date ?? transferForm.date),
            to: toAcct.currency,
          });
          // Auto-fill receivedAmount only when the user hasn't typed in it.
          if (!transferReceivedTouched) {
            setTransferForm((tf) => ({ ...tf, receivedAmount: converted.toFixed(2) }));
          }
        })
        .catch((e) => setTransferFxPreview({ state: "error", message: String(e?.message ?? "Network error") }));
    }, 300);
    return () => {
      if (transferFxTimer.current) clearTimeout(transferFxTimer.current);
    };
    // intentionally NOT depending on transferReceivedTouched so toggling it
    // (false→true→false) doesn't cause a refetch; same for receivedAmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, dialogMode, transferForm.fromAccountId, transferForm.toAccountId, transferForm.amount, transferForm.date, accounts]);

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
    setFilters({ startDate: "", endDate: "", accountId: "", categoryId: "", search: "", portfolioHolding: "", tag: "" });
    setPage(0);
  }

  function resetForm() {
    setForm({ date: new Date().toISOString().split("T")[0], accountId: "", categoryId: "", currency: "CAD", amount: "", payee: "", note: "", tags: "", isBusiness: false, quantity: "", portfolioHoldingId: "" });
    setShowAdvanced(false);
    setShowSplits(false);
    setSplitRows([emptySplitRow(), emptySplitRow()]);
    setTransferForm({
      date: new Date().toISOString().split("T")[0],
      fromAccountId: "",
      toAccountId: "",
      amount: "",
      receivedAmount: "",
      inKind: false,
      holdingName: "",
      destHoldingName: "",
      quantity: "",
      destQuantity: "",
      note: "",
      tags: "",
    });
    setTransferReceivedTouched(false);
    setDestHoldingTouched(false);
    setDestQuantityTouched(false);
    setTransferEdit(null);
    setTransferFxPreview({ state: "idle" });
    // dialogMode is intentionally NOT reset here so the user's tab choice
    // persists across opens within a single session. It's reset on dialog
    // close instead (see the Dialog onOpenChange handler).
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    // Client-side validation — stop the round-trip on missing required
    // fields so the user sees a clear message at the field rather than a
    // generic server error. Server still validates (Zod + FK catch in
    // /api/transactions) as the source of truth.
    if (!form.accountId) {
      setSubmitError({ message: "Pick an account" });
      return;
    }
    if (!form.categoryId) {
      setSubmitError({ message: "Pick a category" });
      return;
    }
    if (!form.amount || Number.isNaN(parseFloat(form.amount))) {
      setSubmitError({ message: "Enter an amount" });
      return;
    }

    // Phase 2 currency rework — send the entered side. Server triangulates
    // to the account's currency via convertToAccountCurrency() and locks
    // enteredFxRate at write time.
    const body: Record<string, unknown> = {
      ...(editId ? { id: editId } : {}),
      date: form.date,
      accountId: Number(form.accountId),
      categoryId: Number(form.categoryId),
      enteredCurrency: form.currency,
      enteredAmount: parseFloat(form.amount),
      payee: form.payee,
      note: form.note,
      tags: form.tags,
      isBusiness: form.isBusiness ? 1 : 0,
    };
    if (form.quantity) body.quantity = parseFloat(form.quantity);
    if (form.portfolioHoldingId) body.portfolioHolding = form.portfolioHoldingId;

    const res = await fetch("/api/transactions", {
      method: editId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Surface the FX-override branch inline rather than bouncing a generic
      // 409 to the user. Other errors get the raw message.
      const data = await res.json().catch(() => ({}));
      if (data?.code === "fx-currency-needs-override") {
        setSubmitError({
          message: `No FX rate for ${data.currency ?? form.currency}.`,
          currency: data.currency ?? form.currency,
        });
      } else {
        setSubmitError({ message: data?.error ?? `Save failed (${res.status})` });
      }
      return;
    }

    // If splits are enabled and we have 2+ valid rows, save them
    if (showSplits && splitRows.filter((r) => r.amount).length >= 2) {
      let txnId = editId;
      if (!txnId && res.ok) {
        const created = await res.json();
        txnId = created.id;
      }
      if (txnId) {
        const sign = parseFloat(form.amount) < 0 ? -1 : 1;
        await fetch("/api/transactions/splits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactionId: txnId,
            splits: splitRows
              .filter((r) => r.amount)
              .map((r) => ({
                categoryId: r.categoryId ? parseInt(r.categoryId) : null,
                amount: sign * Math.abs(parseFloat(r.amount) || 0),
                note: r.note,
              })),
          }),
        });
      }
    }

    setDialogOpen(false);
    setEditId(null);
    resetForm();
    loadTxns();
  }

  // Submit handler for Transfer mode. Routes to POST /api/transactions/transfer
  // for create + PUT for edit-pair. Both paths produce/maintain a server-
  // generated link_id so the unified Transfer view picks the pair up on
  // re-edit. Surfaces 409 fx-currency-needs-override the same way the
  // single-row submit does. In-kind mode allows amount=0 and requires
  // holdingName + quantity.
  async function handleTransferSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const fromAccountId = Number(transferForm.fromAccountId);
    const toAccountId = Number(transferForm.toAccountId);
    if (!fromAccountId || !toAccountId) {
      setSubmitError({ message: "Pick both a source and destination account" });
      return;
    }
    if (fromAccountId === toAccountId) {
      setSubmitError({ message: "From and To accounts must differ" });
      return;
    }

    const enteredAmount = parseFloat(transferForm.amount || "0");
    const isInKind = transferForm.inKind;
    let quantityNum: number | undefined;
    let holdingName: string | undefined;
    if (isInKind) {
      holdingName = transferForm.holdingName.trim();
      if (!holdingName) {
        setSubmitError({ message: "Pick a holding for the in-kind transfer" });
        return;
      }
      const q = parseFloat(transferForm.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        setSubmitError({ message: "Quantity must be a positive number for an in-kind transfer" });
        return;
      }
      quantityNum = q;
      // Cash amount may be 0 for pure in-kind moves.
      if (!Number.isFinite(enteredAmount) || enteredAmount < 0) {
        setSubmitError({ message: "Cash amount must be 0 or a positive number" });
        return;
      }
    } else {
      if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
        setSubmitError({ message: "Amount must be a positive number" });
        return;
      }
    }

    const fromAcct = accounts.find((a) => a.id === fromAccountId);
    const toAcct = accounts.find((a) => a.id === toAccountId);
    const isCrossCcy = !!fromAcct && !!toAcct && fromAcct.currency !== toAcct.currency;

    let receivedAmount: number | undefined;
    if (isCrossCcy && transferForm.receivedAmount) {
      const parsed = parseFloat(transferForm.receivedAmount);
      if (Number.isFinite(parsed) && parsed >= 0) receivedAmount = parsed;
    }

    const body: Record<string, unknown> = {
      fromAccountId,
      toAccountId,
      enteredAmount,
      date: transferForm.date,
      ...(receivedAmount != null ? { receivedAmount } : {}),
      ...(transferForm.note ? { note: transferForm.note } : {}),
      ...(transferForm.tags ? { tags: transferForm.tags } : {}),
      ...(transferEdit ? { linkId: transferEdit.linkId } : {}),
    };

    // Holding wiring. On EDIT, we need to express "clear the in-kind side"
    // explicitly when the user toggled it off — the server's tri-state PUT
    // contract reads explicit nulls as a clear vs omitted as untouched.
    // destHoldingName / destQuantity are sent only when the user explicitly
    // picked a different value — otherwise the server defaults dest = source.
    const isEdit = !!transferEdit;
    if (isInKind) {
      body.holdingName = holdingName;
      body.quantity = quantityNum;
      const destOverride = transferForm.destHoldingName.trim();
      if (destOverride && destOverride !== holdingName) {
        body.destHoldingName = destOverride;
      } else if (isEdit) {
        // Explicitly null on edit so the server clears any prior override.
        body.destHoldingName = null;
      }
      const destQtyRaw = transferForm.destQuantity.trim();
      if (destQuantityTouched && destQtyRaw) {
        const parsed = parseFloat(destQtyRaw);
        if (Number.isFinite(parsed) && parsed > 0 && parsed !== quantityNum) {
          body.destQuantity = parsed;
        } else if (isEdit) {
          body.destQuantity = null;
        }
      } else if (isEdit) {
        body.destQuantity = null;
      }
    } else if (isEdit) {
      body.holdingName = null;
      body.destHoldingName = null;
      body.quantity = null;
      body.destQuantity = null;
    }

    const res = await fetch("/api/transactions/transfer", {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data?.code === "fx-currency-needs-override") {
        setSubmitError({
          message: `No FX rate for ${data.currency ?? toAcct?.currency ?? "destination currency"}.`,
          currency: data.currency,
        });
      } else {
        setSubmitError({ message: data?.error ?? `Save failed (${res.status})` });
      }
      return;
    }

    setDialogOpen(false);
    setEditId(null);
    setDialogMode("transaction");
    resetForm();
    loadTxns();
  }

  // Delete BOTH legs of an open transfer pair atomically. Confirms inline
  // (Trash button → "Delete transfer (both legs)" button) — no separate
  // confirm modal because the destructive label is in the button itself.
  const [transferDeleting, setTransferDeleting] = useState(false);
  async function handleTransferDelete() {
    if (!transferEdit) return;
    setTransferDeleting(true);
    try {
      await fetch(`/api/transactions/transfer?linkId=${encodeURIComponent(transferEdit.linkId)}`, {
        method: "DELETE",
      });
    } finally {
      setTransferDeleting(false);
    }
    setDialogOpen(false);
    setEditId(null);
    setDialogMode("transaction");
    resetForm();
    loadTxns();
  }

  function startEdit(t: Transaction) {
    setEditId(t.id);
    setSubmitError(null);
    setLinkedSiblings([]);
    setTransferEdit(null);
    setTransferReceivedTouched(false);

    // Three-check rule for "open this in unified Transfer mode":
    //   1. row has link_id
    //   2. exactly one sibling shares the link_id (so N≤2 legs)
    //   3. the two rows reference DIFFERENT accounts
    //
    // The legacy `category_type === 'R'` check was intentionally relaxed
    // (#8): transfer-shaped pairs whose category was renamed by the user
    // (e.g. `Non-Cash - Transfers`) still open here. Anything that fails
    // the rule (WP liquidations with N>2 legs, same-account conversions)
    // falls back to the standard transaction-mode edit + linked-siblings
    // panel.
    if (t.linkId) {
      fetch(`/api/transactions/linked?linkId=${encodeURIComponent(t.linkId)}&excludeId=${t.id}`)
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .then((d: { data?: LinkedSibling[] }) => {
          const siblings = Array.isArray(d.data) ? d.data : [];
          const isCleanPair =
            siblings.length === 1 &&
            siblings[0].accountId != null &&
            siblings[0].accountId !== t.accountId;
          if (isCleanPair) {
            // Pre-fill Transfer mode with both legs.
            const sibling = siblings[0];
            // Direction: the negative-amount leg is the source; positive is
            // destination. Mirror what loadTransferPair does server-side.
            const sourceTxId = t.amount < 0 ? t.id : sibling.id;
            const destTxId = t.amount < 0 ? sibling.id : t.id;
            const sourceAccountId = t.amount < 0 ? t.accountId : sibling.accountId!;
            const destAccountId = t.amount < 0 ? sibling.accountId! : t.accountId;
            const sourceAcct = accounts.find((a) => a.id === sourceAccountId);
            const destAcct = accounts.find((a) => a.id === destAccountId);
            // Prefer enteredAmount (what the user typed) over the converted
            // account-side amount.
            const sourceLegAmount = t.amount < 0 ? Math.abs(t.amount) : Math.abs(sibling.amount);
            const destLegAmount = t.amount < 0 ? Math.abs(sibling.amount) : Math.abs(t.amount);
            const isCrossCcy = !!sourceAcct && !!destAcct && sourceAcct.currency !== destAcct.currency;
            // In-kind detection: any leg with a portfolio_holding (and a non-
            // zero quantity) makes this an in-kind transfer. The sibling's
            // portfolioHolding comes back already decrypted from /api/transactions/linked.
            // Source vs dest holding names may differ (the transfer pair
            // already supports source/dest split), so resolve each from the
            // matching leg and compare. Same applies to quantity — splits
            // and mergers can have asymmetric counts.
            const sourceLegHolding = t.amount < 0 ? t.portfolioHolding : sibling.portfolioHolding;
            const destLegHolding = t.amount < 0 ? sibling.portfolioHolding : t.portfolioHolding;
            const sourceLegQty =
              t.amount < 0 && t.quantity != null
                ? Math.abs(t.quantity)
                : sibling.quantity != null
                  ? Math.abs(sibling.quantity)
                  : 0;
            const destLegQty =
              t.amount < 0 && sibling.quantity != null
                ? Math.abs(sibling.quantity)
                : t.quantity != null
                  ? Math.abs(t.quantity)
                  : 0;
            const inKindHolding = sourceLegHolding ?? destLegHolding ?? "";
            const inKindQty = sourceLegQty || destLegQty;
            const isInKind = !!inKindHolding && inKindQty > 0;
            // Treat dest quantity as "explicitly different" only when both
            // legs returned quantities and they differ by more than rounding.
            const destQtyDiffers =
              isInKind &&
              sourceLegQty > 0 &&
              destLegQty > 0 &&
              Math.abs(sourceLegQty - destLegQty) > 1e-9;
            // Treat dest as "explicitly different from source" only when both
            // legs returned a name and they differ. Otherwise leave the
            // override blank so the destination dropdown defaults to "same
            // as source" on render.
            const destHoldingDiffers =
              isInKind &&
              !!sourceLegHolding &&
              !!destLegHolding &&
              destLegHolding !== sourceLegHolding;
            setDialogMode("transfer");
            setTransferEdit({
              linkId: t.linkId!,
              fromTxId: sourceTxId,
              toTxId: destTxId,
            });
            setTransferForm({
              date: t.date,
              fromAccountId: String(sourceAccountId),
              toAccountId: String(destAccountId),
              amount: String(sourceLegAmount),
              receivedAmount: isCrossCcy ? String(destLegAmount) : "",
              inKind: isInKind,
              holdingName: isInKind ? inKindHolding : "",
              destHoldingName: destHoldingDiffers ? (destLegHolding ?? "") : "",
              quantity: isInKind ? String(sourceLegQty || inKindQty) : "",
              destQuantity: destQtyDiffers ? String(destLegQty) : "",
              note: t.note || sibling.note || "",
              tags: t.tags || sibling.tags || "",
            });
            setDestHoldingTouched(destHoldingDiffers);
            setDestQuantityTouched(destQtyDiffers);
            // The pre-filled receivedAmount IS the canonical booked rate;
            // mark it as touched so the FX preview doesn't auto-overwrite
            // with a fresh market rate.
            setTransferReceivedTouched(true);
            setDialogOpen(true);
            return;
          }
          // Not a clean pair → fall through to transaction mode + show the
          // linked-siblings panel for navigation.
          setLinkedSiblings(siblings);
          openTransactionEdit(t);
        })
        .catch(() => openTransactionEdit(t));
      return;
    }

    openTransactionEdit(t);
  }

  function openTransactionEdit(t: Transaction) {
    setDialogMode("transaction");
    // Show the user the side they originally typed (entered amount /
    // currency), not the converted account-currency value. Soft-fallback so
    // legacy rows without entered fields still populate sensibly.
    setForm({
      date: t.date,
      accountId: String(t.accountId),
      categoryId: String(t.categoryId),
      currency: t.enteredCurrency ?? t.currency,
      amount: String(t.enteredAmount ?? t.amount),
      payee: t.payee || "",
      note: t.note || "",
      tags: t.tags || "",
      isBusiness: t.isBusiness === 1,
      quantity: t.quantity != null ? String(t.quantity) : "",
      portfolioHoldingId: t.portfolioHolding || "",
    });
    if (t.isBusiness === 1 || t.quantity != null || t.portfolioHolding) {
      setShowAdvanced(true);
    }
    setShowSplits(false);
    setSplitRows([emptySplitRow(), emptySplitRow()]);
    // Load existing splits so the edit dialog surfaces them instead of
    // hiding them behind the "Split this transaction" call-to-action.
    fetch(`/api/transactions/splits?transactionId=${t.id}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ categoryId: number | null; amount: number; note: string | null }>) => {
        if (Array.isArray(rows) && rows.length > 0) {
          setSplitRows(
            rows.map((r) => ({
              categoryId: r.categoryId ? String(r.categoryId) : "",
              amount: String(r.amount),
              note: r.note ?? "",
            })),
          );
          setShowSplits(true);
        }
      })
      .catch(() => {});
    setDialogOpen(true);
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
    await fetch(`/api/transactions?id=${deleteConfirmId}`, { method: "DELETE" });
    setDeleteConfirmId(null);
    setDeleting(false);
    loadTxns();
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
    loadTxns();
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
    loadTxns();
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
  const splitAllocated = splitRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const splitRemaining = Math.abs(parseFloat(form.amount) || 0) - splitAllocated;
  const splitBalanced = Math.abs(splitRemaining) < 0.01;

  return (
    <div className="space-y-6">
      <OnboardingTips page="transactions" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Transactions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage and track all your financial transactions</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) { setEditId(null); setDialogMode("transaction"); resetForm(); setSubmitError(null); } }}>
          <DialogTrigger render={<Button className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-sm" />}>
            <Plus className="h-4 w-4 mr-2" /> Add Transaction
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {dialogMode === "transfer"
                  ? (editId ? "Edit Transfer" : "New Transfer")
                  : (editId ? "Edit Transaction" : "New Transaction")}
              </DialogTitle>
            </DialogHeader>

            {/* Mode switcher — only shown on create. On edit, the mode is
                fixed by the row being edited (see startEdit's four-check
                detection). */}
            {!editId && (
              <div className="inline-flex rounded-md border bg-muted/40 p-0.5 self-start">
                <button
                  type="button"
                  onClick={() => { setDialogMode("transaction"); setSubmitError(null); }}
                  className={`px-3 py-1 text-sm rounded transition-colors ${dialogMode === "transaction" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Transaction
                </button>
                <button
                  type="button"
                  onClick={() => { setDialogMode("transfer"); setSubmitError(null); }}
                  className={`px-3 py-1 text-sm rounded transition-colors flex items-center gap-1.5 ${dialogMode === "transfer" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" /> Transfer
                </button>
              </div>
            )}

            {dialogMode === "transaction" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
                </div>
                <div className="space-y-1.5">
                  <Label>Amount</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="-50.00" required />
                </div>
              </div>
              {/* Live FX conversion preview — only when entered currency
                  differs from the account's currency. Shows the converted
                  amount, the rate, the rate's source, and the date. */}
              {fxPreview.state !== "idle" && (
                <div className="text-xs text-muted-foreground -mt-2">
                  {fxPreview.state === "loading" && <span>Loading…</span>}
                  {fxPreview.state === "ok" && (
                    <span>
                      Account: <span className="font-mono font-medium text-foreground">{formatCurrency(fxPreview.converted, fxPreview.to)}</span>
                      <span className="ml-1.5 opacity-70">(rate {fxPreview.rate} · {fxPreview.source} · {fxPreview.date})</span>
                    </span>
                  )}
                  {fxPreview.state === "needs-override" && (
                    <span className="text-amber-600 dark:text-amber-400">
                      Rate not available — <Link href="/settings" className="underline hover:no-underline">add an override</Link>.
                    </span>
                  )}
                  {fxPreview.state === "error" && (
                    <span className="text-rose-600 dark:text-rose-400">{fxPreview.message}</span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Account</Label>
                  <Select value={form.accountId} onValueChange={(v) => {
                    const val = v ?? "";
                    const acct = accounts.find((a) => String(a.id) === val);
                    setForm({ ...form, accountId: val, currency: acct?.currency ?? "CAD" });
                  }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select account">
                        {(v) => {
                          const val = v == null ? "" : String(v);
                          if (!val) return "Select account";
                          return accounts.find((a) => String(a.id) === val)?.name ?? val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Select value={form.categoryId} onValueChange={(v) => setForm({ ...form, categoryId: v ?? "" })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category">
                        {(v) => {
                          const val = v == null ? "" : String(v);
                          if (!val) return "Select category";
                          const c = categories.find((c) => String(c.id) === val);
                          return c ? `${c.group} - ${c.name}` : val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>{c.group} - {c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Payee</Label>
                  <Input value={form.payee} onChange={(e) => setForm({ ...form, payee: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Currency</Label>
                  <Select value={form.currency} onValueChange={(v) => setForm({ ...form, currency: v ?? "CAD" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_FIAT_CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Note</Label>
                <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Tags (comma-separated)</Label>
                <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              </div>

              {/* Linked transactions — other legs of a multi-leg import
                  (transfer, same-account currency conversion, liquidation).
                  Only shown when editing an existing tx with a linkId.
                  Reaching this panel means the unified Edit Transfer dialog
                  declined the row (N≠2 siblings, or same account) — so the
                  user is editing one leg at a time. */}
              {editId && linkedSiblings.length > 0 && (
                <div className="space-y-2 rounded-lg border border-sky-200 dark:border-sky-900 bg-sky-50/50 dark:bg-sky-950/30 p-3">
                  <div className="text-[11px] text-sky-700/80 dark:text-sky-300/80">
                    This transaction is part of a multi-leg group; legs are edited individually.
                  </div>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300">
                    <Link2 className="h-3.5 w-3.5" />
                    Linked transaction{linkedSiblings.length > 1 ? "s" : ""}
                  </div>
                  <div className="space-y-1">
                    {linkedSiblings.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => openLinkedSibling(s)}
                        className="flex w-full items-center justify-between gap-2 rounded-md bg-background/50 px-2 py-1.5 text-xs hover:bg-background transition-colors border border-transparent hover:border-sky-200 dark:hover:border-sky-800"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-muted-foreground font-mono shrink-0">{formatDate(s.date)}</span>
                          <span className="truncate font-medium">{s.accountName ?? "—"}</span>
                          {s.portfolioHolding && (
                            <span className="text-muted-foreground truncate">· {s.portfolioHolding}</span>
                          )}
                        </div>
                        <span className={`font-mono font-semibold shrink-0 ${s.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {formatCurrency(s.amount, s.currency)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Inline split editor (Task 6) */}
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
                onClick={() => setShowSplits(!showSplits)}
              >
                <Scissors className={`h-4 w-4 transition-transform ${showSplits ? "text-violet-500" : ""}`} />
                {showSplits ? "Hide splits" : "Split this transaction"}
              </button>

              {showSplits && (
                <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
                  <div className="text-xs text-muted-foreground font-medium">Split rows (must sum to total amount)</div>
                  {splitRows.map((row, i) => (
                    <div key={i} className="flex gap-1.5 items-center">
                      <Select value={row.categoryId} onValueChange={(v) => {
                        const next = [...splitRows];
                        next[i] = { ...next[i], categoryId: v ?? "" };
                        setSplitRows(next);
                      }}>
                        <SelectTrigger className="h-7 text-xs flex-1"><SelectValue placeholder="Category" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">No category</SelectItem>
                          {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="h-7 text-xs w-24 font-mono"
                        placeholder="0.00"
                        value={row.amount}
                        onChange={(e) => {
                          const next = [...splitRows];
                          next[i] = { ...next[i], amount: e.target.value };
                          setSplitRows(next);
                        }}
                      />
                      <Input
                        className="h-7 text-xs w-24"
                        placeholder="Note"
                        value={row.note}
                        onChange={(e) => {
                          const next = [...splitRows];
                          next[i] = { ...next[i], note: e.target.value };
                          setSplitRows(next);
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground"
                        onClick={() => setSplitRows(splitRows.filter((_, j) => j !== i))}
                        disabled={splitRows.length <= 2}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-xs"
                    onClick={() => setSplitRows([...splitRows, emptySplitRow()])}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add row
                  </Button>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Allocated: <span className="font-mono">{formatCurrency(splitAllocated, form.currency)}</span></span>
                    {splitBalanced ? (
                      <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-600 bg-emerald-50">Balanced</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] border-rose-300 text-rose-600 bg-rose-50">
                        {splitRemaining > 0 ? `${formatCurrency(splitRemaining, form.currency)} left` : `${formatCurrency(Math.abs(splitRemaining), form.currency)} over`}
                      </Badge>
                    )}
                  </div>
                </div>
              )}

              <button
                type="button"
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-full"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
                Advanced Options
              </button>

              {showAdvanced && (
                <div className="space-y-4 border rounded-lg p-4 bg-muted/20">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Quantity</Label>
                      <Input type="number" step="0.0001" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="e.g. 10" />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Portfolio Holding</Label>
                      <Select
                        value={form.portfolioHoldingId || "__none__"}
                        onValueChange={(v) => setForm({ ...form, portfolioHoldingId: v === "__none__" ? "" : (v ?? "") })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select holding">
                            {(v) => {
                              const val = v == null ? "" : String(v);
                              if (!val || val === "__none__") return "None";
                              const h = holdings.find((h) => h.name === val);
                              if (!h) return val;
                              return h.symbol ? `${h.name} (${h.symbol})` : h.name;
                            }}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {holdings.map((h) => (
                            <SelectItem key={h.id} value={h.name}>
                              {h.symbol ? `${h.name} (${h.symbol})` : h.name}
                              {h.accountName ? ` — ${h.accountName}` : ""}
                            </SelectItem>
                          ))}
                          {form.portfolioHoldingId &&
                            !holdings.some((h) => h.name === form.portfolioHoldingId) && (
                              <SelectItem value={form.portfolioHoldingId}>{form.portfolioHoldingId}</SelectItem>
                            )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="isBusiness" checked={form.isBusiness} onChange={(e) => setForm({ ...form, isBusiness: e.target.checked })} className="h-4 w-4 rounded border-input" />
                    <Label htmlFor="isBusiness" className="cursor-pointer">Business expense</Label>
                  </div>
                </div>
              )}

              {submitError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  {submitError.message}{" "}
                  {submitError.currency && (
                    <Link href="/settings" className="underline hover:no-underline">
                      Add a custom rate
                    </Link>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                {editId && (
                  <Button type="button" variant="outline" className="text-destructive border-destructive/30" onClick={() => {
                    const t = txns.find((t) => t.id === editId);
                    if (t) { confirmDelete(t); setDialogOpen(false); }
                  }}>
                    <Trash2 className="h-4 w-4 mr-1.5" /> Delete
                  </Button>
                )}
                <Button type="submit" className="flex-1">{editId ? "Update" : "Create"} Transaction</Button>
              </div>
            </form>
            )}

            {/* ─── Transfer mode ──────────────────────────────────────────
                Single dialog form that creates/updates BOTH legs of a
                transfer pair atomically via /api/transactions/transfer.
                On edit, both legs are loaded from /api/transactions/linked
                and the linked-siblings panel is hidden (the form IS the
                pair). For non-symmetric multi-leg imports (WP liquidations,
                etc.), the dialog falls through to transaction mode and the
                old linked-siblings panel renders for navigation. */}
            {dialogMode === "transfer" && (
            <form onSubmit={handleTransferSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input
                    type="date"
                    value={transferForm.date}
                    onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Amount sent</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={transferForm.amount}
                    onChange={(e) => {
                      // When the user types a new amount and we're in cross-
                      // currency mode, the FX preview will refetch and (if
                      // the user hasn't manually edited receivedAmount) the
                      // effect re-fills it. Reset the touched flag here so
                      // the user can change the amount and get a fresh
                      // auto-derived destination value.
                      setTransferReceivedTouched(false);
                      setTransferForm({ ...transferForm, amount: e.target.value });
                    }}
                    placeholder="100.00"
                    required
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>From account</Label>
                  <Select
                    value={transferForm.fromAccountId}
                    onValueChange={(v) => setTransferForm({ ...transferForm, fromAccountId: v ?? "" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Source account">
                        {(v) => {
                          const val = v == null ? "" : String(v);
                          if (!val) return "Source account";
                          const a = accounts.find((a) => String(a.id) === val);
                          return a ? `${a.name} · ${a.currency}` : val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {accounts
                        // Allow same-account when in-kind is on (rebalance
                        // between two holdings inside one brokerage); only
                        // exclude the picked destination for cash transfers.
                        .filter((a) => transferForm.inKind || String(a.id) !== transferForm.toAccountId)
                        .map((a) => (
                          <SelectItem key={a.id} value={String(a.id)}>{a.name} · {a.currency}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>To account</Label>
                  <Select
                    value={transferForm.toAccountId}
                    onValueChange={(v) => setTransferForm({ ...transferForm, toAccountId: v ?? "" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Destination account">
                        {(v) => {
                          const val = v == null ? "" : String(v);
                          if (!val) return "Destination account";
                          const a = accounts.find((a) => String(a.id) === val);
                          return a ? `${a.name} · ${a.currency}` : val;
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {accounts
                        // Mirror of the From dropdown: same-account allowed
                        // when in-kind is on, blocked otherwise.
                        .filter((a) => transferForm.inKind || String(a.id) !== transferForm.fromAccountId)
                        .map((a) => (
                          <SelectItem key={a.id} value={String(a.id)}>{a.name} · {a.currency}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* In-kind / holding transfer toggle. Off → cash transfer
                  (existing behavior). On → adds Holding + Quantity fields
                  and allows the cash amount to be 0. The destination holding
                  row is auto-created in the destination account if missing;
                  the source holding MUST already exist (the resolver rejects
                  otherwise — you can't send shares you don't have). */}
              {(() => {
                const fromAcct = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
                // Filter holdings to those owned by the source account so
                // users only see options that won't fail server-side. The
                // /api/portfolio response only carries account NAME (not id),
                // so match on that. If multiple accounts share a name (rare)
                // this could over-filter — acceptable for v1.
                const sourceHoldings = fromAcct
                  ? holdings.filter((h) => h.accountName === fromAcct.name)
                  : [];
                const toAcctLocal = accounts.find((a) => String(a.id) === transferForm.toAccountId);
                const destHoldings = toAcctLocal
                  ? holdings.filter((h) => h.accountName === toAcctLocal.name)
                  : [];
                // Detect whether the destination already has an exact name
                // match for the source — if so, the "Same as source" default
                // implicitly binds to it (server's resolver finds it before
                // auto-creating). Surface this in the dropdown labels so the
                // user knows up-front whether a new row will be created.
                const sourceName = transferForm.holdingName.trim();
                const destExactMatch =
                  sourceName !== ""
                    ? destHoldings.find((h) => h.name === sourceName) ?? null
                    : null;
                // The "destination value" the dropdown displays. Falls back
                // to the special sentinel when the user hasn't picked an
                // override (server uses source name in that case).
                const destSentinel = "__same_as_source__";
                const destSelectValue =
                  transferForm.destHoldingName.trim() !== "" &&
                  transferForm.destHoldingName.trim() !== sourceName
                    ? transferForm.destHoldingName.trim()
                    : destSentinel;
                return (
                  <div className="space-y-2 rounded-md border border-violet-200 dark:border-violet-900 bg-violet-50/40 dark:bg-violet-950/20 p-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={transferForm.inKind}
                        onChange={(e) => {
                          const inKind = e.target.checked;
                          setTransferForm({
                            ...transferForm,
                            inKind,
                            // Clear holding/quantity when toggling off so a
                            // stale name doesn't roundtrip on submit.
                            ...(inKind ? {} : { holdingName: "", destHoldingName: "", quantity: "" }),
                          });
                          if (!inKind) setDestHoldingTouched(false);
                        }}
                        className="h-4 w-4 rounded border-input"
                      />
                      <span className="text-sm font-medium">In-kind (transfer shares of a holding)</span>
                    </label>
                    {transferForm.inKind && (
                      <>
                        <p className="text-[11px] text-muted-foreground">
                          Source holding must already exist. Destination defaults to the same holding name (auto-created in the destination account if missing). Cash amount may be 0 for a pure in-kind move, or non-zero to also record a cost-basis snapshot.
                        </p>
                        {fromAcct && toAcctLocal && fromAcct.id === toAcctLocal.id && (
                          <p className="text-[11px] text-amber-700 dark:text-amber-300">
                            Same-account move — pick a different destination holding to rebalance between two positions in this brokerage. The cash amount typically stays 0 for an internal swap.
                          </p>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Source holding (in {fromAcct?.name ?? "—"})</Label>
                            {sourceHoldings.length > 0 ? (
                              <Select
                                value={transferForm.holdingName || "__custom__"}
                                onValueChange={(v) => {
                                  const val = v ?? "";
                                  setTransferForm({
                                    ...transferForm,
                                    holdingName: val === "__custom__" ? transferForm.holdingName : val,
                                  });
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Pick holding">
                                    {(v) => {
                                      const val = v == null ? "" : String(v);
                                      if (!val || val === "__custom__") return transferForm.holdingName || "Pick holding";
                                      const h = sourceHoldings.find((x) => x.name === val);
                                      // Always show share count, including 0,
                                      // so the user sees current position even
                                      // when the holding is empty.
                                      const shares = Number(h?.currentShares ?? 0);
                                      const qty = ` · ${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`;
                                      return `${val}${qty}`;
                                    }}
                                  </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                  {sourceHoldings.map((h) => {
                                    const shares = Number(h.currentShares ?? 0);
                                    const qty = ` · ${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`;
                                    return (
                                      <SelectItem key={h.id} value={h.name}>
                                        {h.symbol ? `${h.name} (${h.symbol})${qty}` : `${h.name}${qty}`}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Input
                                value={transferForm.holdingName}
                                onChange={(e) => setTransferForm({ ...transferForm, holdingName: e.target.value })}
                                placeholder={fromAcct ? `Type holding name in ${fromAcct.name}` : "Pick a source account first"}
                                disabled={!fromAcct}
                              />
                            )}
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Quantity (shares)</Label>
                            <Input
                              type="number"
                              step="0.0001"
                              min="0"
                              value={transferForm.quantity}
                              onChange={(e) => setTransferForm({ ...transferForm, quantity: e.target.value })}
                              placeholder="0.0000"
                            />
                          </div>
                        </div>
                        {/* Destination holding picker + quantity. Defaults
                            to "same as source" — the server's resolver binds
                            to an existing dest row if one exists with that
                            name, else auto-creates. The user can override
                            either side independently:
                              - Holding: pick an existing dest holding with a
                                different label, or type a new name.
                              - Quantity: defaults to source quantity but
                                accepts a different value for stock splits,
                                mergers, share-class conversions (10 of A →
                                30 of A after a 3-for-1; 100 of X → 60 of Y
                                after a merger). */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">
                              Destination holding (in {toAcctLocal?.name ?? "—"})
                            </Label>
                            {toAcctLocal ? (
                              <Select
                                value={destSelectValue}
                                onValueChange={(v) => {
                                  const val = v ?? destSentinel;
                                  if (val === destSentinel) {
                                    setDestHoldingTouched(false);
                                    setTransferForm({ ...transferForm, destHoldingName: "" });
                                  } else if (val === "__custom__") {
                                    setDestHoldingTouched(true);
                                  } else {
                                    setDestHoldingTouched(true);
                                    setTransferForm({ ...transferForm, destHoldingName: val });
                                  }
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Same as source">
                                    {(v) => {
                                      const val = v == null ? "" : String(v);
                                      if (!val || val === destSentinel) {
                                        if (!sourceName) return "Same as source";
                                        const matchShares = Number(destExactMatch?.currentShares ?? 0);
                                        return destExactMatch
                                          ? `${sourceName} (existing in ${toAcctLocal.name}) · ${matchShares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`
                                          : `${sourceName} (will create in ${toAcctLocal.name})`;
                                      }
                                      if (val === "__custom__") return transferForm.destHoldingName || "Custom name";
                                      const h = destHoldings.find((x) => x.name === val);
                                      const shares = Number(h?.currentShares ?? 0);
                                      const qty = ` · ${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`;
                                      return `${val}${qty}`;
                                    }}
                                  </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={destSentinel}>
                                    {sourceName
                                      ? destExactMatch
                                        ? `Same as source — binds to existing "${sourceName}" (${Number(
                                            destExactMatch.currentShares ?? 0,
                                          ).toLocaleString(undefined, { maximumFractionDigits: 4 })} shares)`
                                        : `Same as source — auto-create "${sourceName}" in ${toAcctLocal.name}`
                                      : `Same as source`}
                                  </SelectItem>
                                  {destHoldings
                                    .filter((h) => h.name !== sourceName)
                                    .map((h) => {
                                      const shares = Number(h.currentShares ?? 0);
                                      const qty = ` · ${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`;
                                      return (
                                        <SelectItem key={h.id} value={h.name}>
                                          {h.symbol ? `${h.name} (${h.symbol})${qty}` : `${h.name}${qty}`}
                                        </SelectItem>
                                      );
                                    })}
                                  <SelectItem value="__custom__">+ Type a different name…</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <Input value="" placeholder="Pick a destination account first" disabled />
                            )}
                            {destHoldingTouched &&
                              destSelectValue === "__custom__" && (
                                <Input
                                  value={transferForm.destHoldingName}
                                  onChange={(e) => setTransferForm({ ...transferForm, destHoldingName: e.target.value })}
                                  placeholder={`New holding name in ${toAcctLocal?.name ?? "destination"}`}
                                />
                              )}
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Destination quantity</Label>
                            {/* Mirrors source quantity unless the user types
                                in this box — that's the marker for "this is
                                a split / merger / share-class conversion".
                                We display the placeholder = source quantity
                                so the default is obvious; an empty value on
                                submit means "same as source". */}
                            <Input
                              type="number"
                              step="0.0001"
                              min="0"
                              value={
                                destQuantityTouched
                                  ? transferForm.destQuantity
                                  : transferForm.quantity
                              }
                              onChange={(e) => {
                                setDestQuantityTouched(true);
                                setTransferForm({ ...transferForm, destQuantity: e.target.value });
                              }}
                              placeholder={transferForm.quantity || "0.0000"}
                            />
                            {destQuantityTouched &&
                              transferForm.destQuantity &&
                              parseFloat(transferForm.destQuantity) !== parseFloat(transferForm.quantity || "0") && (
                                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                                  Asymmetric — the destination will receive a different share count than the source loses (split / merger / conversion).
                                </p>
                              )}
                            {destQuantityTouched && (
                              <button
                                type="button"
                                className="text-[11px] text-muted-foreground hover:text-foreground underline"
                                onClick={() => {
                                  setDestQuantityTouched(false);
                                  setTransferForm({ ...transferForm, destQuantity: "" });
                                }}
                              >
                                Reset to source quantity
                              </button>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Cross-currency preview + editable destination amount.
                  Only renders when source and destination accounts have
                  different currencies. The destination amount is auto-
                  filled from the live FX rate but stays editable so the
                  user can pin the bank's actual landed amount. */}
              {(() => {
                const fromAcct = accounts.find((a) => String(a.id) === transferForm.fromAccountId);
                const toAcct = accounts.find((a) => String(a.id) === transferForm.toAccountId);
                const isCrossCcy = !!fromAcct && !!toAcct && fromAcct.currency !== toAcct.currency;
                if (!isCrossCcy) return null;
                return (
                  <div className="space-y-2 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Amount received ({toAcct!.currency})</Label>
                      {transferFxPreview.state === "loading" && (
                        <span className="text-[11px] text-muted-foreground">Calculating…</span>
                      )}
                      {transferFxPreview.state === "ok" && (
                        <span className="text-[11px] text-muted-foreground">
                          rate {transferFxPreview.rate.toFixed(6)} · {transferFxPreview.source}
                        </span>
                      )}
                    </div>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={transferForm.receivedAmount}
                      onChange={(e) => {
                        setTransferReceivedTouched(true);
                        setTransferForm({ ...transferForm, receivedAmount: e.target.value });
                      }}
                      placeholder={transferFxPreview.state === "ok" ? transferFxPreview.converted.toFixed(2) : "0.00"}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Pre-filled from market FX. Override with the actual amount your bank credited.
                    </p>
                    {transferFxPreview.state === "needs-override" && (
                      <p className="text-[11px] text-amber-700 dark:text-amber-300">
                        No FX rate cached for this pair — <Link href="/settings" className="underline">add a custom rate</Link> or type the amount manually.
                      </p>
                    )}
                    {transferFxPreview.state === "error" && (
                      <p className="text-[11px] text-rose-600 dark:text-rose-400">{transferFxPreview.message}</p>
                    )}
                  </div>
                );
              })()}

              <div className="space-y-1.5">
                <Label>Note (applied to both legs)</Label>
                <Input
                  value={transferForm.note}
                  onChange={(e) => setTransferForm({ ...transferForm, note: e.target.value })}
                  placeholder="e.g. rent buffer"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Tags (comma-separated, applied to both legs)</Label>
                <Input
                  value={transferForm.tags}
                  onChange={(e) => setTransferForm({ ...transferForm, tags: e.target.value })}
                />
              </div>

              {/* On edit, surface a small metadata footer so power users
                  can still see the underlying row IDs. */}
              {transferEdit && (
                <div className="text-[11px] text-muted-foreground border-t pt-2">
                  Editing transfer — IDs #{transferEdit.fromTxId} (debit) ↔ #{transferEdit.toTxId} (credit) · linkId <span className="font-mono">{transferEdit.linkId.slice(0, 8)}…</span>
                </div>
              )}

              {submitError && (
                <div className="rounded-md border border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  {submitError.message}{" "}
                  {submitError.currency && (
                    <Link href="/settings" className="underline hover:no-underline">
                      Add a custom rate
                    </Link>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                {transferEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive border-destructive/30"
                    disabled={transferDeleting}
                    onClick={handleTransferDelete}
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    {transferDeleting ? "Deleting…" : "Delete transfer (both legs)"}
                  </Button>
                )}
                <Button type="submit" className="flex-1">
                  {transferEdit ? "Update Transfer" : "Create Transfer"}
                </Button>
              </div>
            </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

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
            <Select value={filters.accountId} onValueChange={(v) => { setFilters({ ...filters, accountId: !v || v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger className="w-40 h-8 text-xs">
                {/* Render-prop on SelectValue — base-ui's default trigger
                    renders the raw `value` (the account id, e.g. "609") rather
                    than the SelectItem's children. Look the id back up so the
                    trigger shows the same `formatAccountLabel` string the
                    dropdown items + table cells use. */}
                <SelectValue placeholder="All accounts">
                  {(v) => {
                    const val = v == null ? "" : String(v);
                    if (!val || val === "all") return "All accounts";
                    const a = accounts.find((x) => String(x.id) === val);
                    return a ? formatAccountLabel(a) : val;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{formatAccountLabel(a)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filters.categoryId} onValueChange={(v) => { setFilters({ ...filters, categoryId: !v || v === "all" ? "" : v }); setPage(0); }}>
              <SelectTrigger className="w-44 h-8 text-xs">
                {/* Same render-prop pattern as Account filter — without it
                    the trigger shows the raw category id when one's selected. */}
                <SelectValue placeholder="All categories">
                  {(v) => {
                    const val = v == null ? "" : String(v);
                    if (!val || val === "all") return "All categories";
                    const c = categories.find((x) => String(x.id) === val);
                    return c?.name ?? val;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
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
            {(filters.startDate || filters.endDate || filters.accountId || filters.categoryId || filters.search || filters.portfolioHolding || filters.tag) && (
              <button onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors ml-1">
                <X className="h-3 w-3" /> Clear all
              </button>
            )}
          </div>
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
              <Select value={bulkCategoryId} onValueChange={(v) => setBulkCategoryId(v ?? "")}>
                <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.group} — {c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {bulkAction === "update_account" && (
              <Select value={bulkAccountId} onValueChange={(v) => setBulkAccountId(v ?? "")}>
                <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
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

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <TableSkeleton />
          ) : txns.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No transactions yet"
              description="Add your first transaction or import bank statements to get started."
              action={{ label: "Import data", href: "/import" }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {columnPrefs.filter((c) => c.visible).map((c) => {
                    const isDraggable = TOGGLEABLE_COLUMNS.has(c.id);
                    const isAmount = c.id === "amount" || c.id === "quantity";
                    const widthClass =
                      c.id === "select" ? "w-10" :
                      c.id === "actions" ? "w-24" :
                      "";
                    const isDragging = draggingCol === c.id;
                    return (
                      <TableHead
                        key={c.id}
                        className={`${widthClass} ${isAmount ? "text-right" : ""} ${isDraggable ? "cursor-grab select-none" : ""} ${isDragging ? "opacity-50" : ""}`}
                        draggable={isDraggable}
                        onDragStart={isDraggable ? onColDragStart(c.id) : undefined}
                        onDragOver={isDraggable ? onColDragOver(c.id) : undefined}
                        onDragEnd={isDraggable ? onColDragEnd : undefined}
                      >
                        {c.id === "select" ? (
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                            className="h-4 w-4 rounded border-input cursor-pointer"
                            title="Select all"
                          />
                        ) : c.id === "actions" ? (
                          ""
                        ) : (
                          COLUMN_LABELS[c.id]
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {txns.map((t) => (
                  <TableRow key={t.id} className={`hover:bg-muted/30 ${selected.has(t.id) ? "bg-primary/5" : ""}`}>
                    {columnPrefs.filter((c) => c.visible).map((c) => {
                      switch (c.id) {
                        case "select":
                          return (
                            <TableCell key={c.id}>
                              <input
                                type="checkbox"
                                checked={selected.has(t.id)}
                                onChange={() => toggleOne(t.id)}
                                className="h-4 w-4 rounded border-input cursor-pointer"
                              />
                            </TableCell>
                          );
                        case "date":
                          return (
                            <TableCell key={c.id} className="text-sm">{formatDate(t.date)}</TableCell>
                          );
                        case "account":
                          return (
                            <TableCell key={c.id} className="text-sm">
                              {formatAccountLabel({ name: t.accountName, alias: t.accountAlias, type: t.accountType })}
                            </TableCell>
                          );
                        case "accountType":
                          return (
                            <TableCell key={c.id} className="text-sm text-muted-foreground">
                              {t.accountType || "-"}
                            </TableCell>
                          );
                        case "accountName":
                          return (
                            <TableCell key={c.id} className="text-sm">{t.accountName || "-"}</TableCell>
                          );
                        case "accountAlias":
                          return (
                            <TableCell key={c.id} className="text-sm text-muted-foreground">
                              {t.accountAlias || "-"}
                            </TableCell>
                          );
                        case "category":
                          return (
                            <TableCell key={c.id} className="text-sm">
                              <span className="flex items-center gap-1">
                                {t.categoryName && (
                                  <Badge variant="outline" className={`text-xs ${getCategoryBadgeClass(t.categoryType)}`}>{t.categoryName}</Badge>
                                )}
                                <SplitBadge transactionId={t.id} />
                                {t.linkId && (
                                  <Link2 className="h-3 w-3 text-sky-500 shrink-0" aria-label="Linked transaction" />
                                )}
                              </span>
                            </TableCell>
                          );
                        case "payee":
                          return (
                            <TableCell key={c.id} className="text-sm">{t.payee || "-"}</TableCell>
                          );
                        case "portfolio":
                          return (
                            <TableCell key={c.id} className="text-sm text-muted-foreground">
                              {t.portfolioHolding || "-"}
                            </TableCell>
                          );
                        case "portfolioTicker":
                          return (
                            <TableCell key={c.id} className="text-sm font-mono text-muted-foreground">
                              {t.portfolioHoldingSymbol || "-"}
                            </TableCell>
                          );
                        case "note":
                          return (
                            <TableCell key={c.id} className="text-sm text-muted-foreground max-w-60">
                              {t.note ? <span className="truncate block">{t.note}</span> : <span>-</span>}
                            </TableCell>
                          );
                        case "tags":
                          return (
                            <TableCell key={c.id} className="text-sm text-muted-foreground">
                              {t.tags ? (
                                <div className="flex flex-wrap gap-1">
                                  {t.tags.split(",").map((rawTag) => rawTag.trim()).filter(Boolean).map((tagValue) => (
                                    <button
                                      key={tagValue}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setFilters({ ...filters, tag: tagValue });
                                        setPage(0);
                                      }}
                                      className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300 px-1.5 py-0 text-[10px] font-mono hover:border-sky-400 hover:bg-sky-100 dark:hover:bg-sky-900 transition-colors"
                                      title={`Filter by tag: ${tagValue}`}
                                    >
                                      {tagValue}
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <span>-</span>
                              )}
                            </TableCell>
                          );
                        case "quantity":
                          return (
                            <TableCell key={c.id} className="text-right font-mono text-xs text-muted-foreground">
                              {t.quantity != null && t.quantity !== 0
                                ? t.quantity.toLocaleString("en-CA", {
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: t.quantity % 1 === 0 ? 0 : 4,
                                  })
                                : "-"}
                            </TableCell>
                          );
                        case "amount": {
                          // Show the entered side (what the user typed); fall
                          // back to amount/currency on legacy rows. When the
                          // settlement currency differs, append a muted
                          // converted label so both the trade and settlement
                          // are visible.
                          const enteredAmt = t.enteredAmount ?? t.amount;
                          const enteredCcy = t.enteredCurrency ?? t.currency;
                          const showSecondary = enteredCcy !== t.currency;
                          return (
                            <TableCell key={c.id} className={`text-right font-mono text-sm font-semibold ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                              <div className="flex flex-col items-end">
                                <span>{formatCurrency(enteredAmt, enteredCcy)}</span>
                                {showSecondary && (
                                  <span className="text-[10px] font-normal text-muted-foreground">
                                    → {formatCurrency(t.amount, t.currency)}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                          );
                        }
                        case "actions":
                          return (
                            <TableCell key={c.id}>
                              <div className="flex gap-0.5">
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(t)} title="Edit">
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-violet-500" onClick={() => openSplitDialog(t)} title="Split">
                                  <Scissors className="h-3 w-3" />
                                </Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => confirmDelete(t)} title="Delete">
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </TableCell>
                          );
                      }
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
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
      <Dialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete Transaction
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{deleteConfirmPayee}</strong>? This cannot be undone.
          </p>
          <div className="flex gap-2 mt-2">
            <Button variant="outline" className="flex-1" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
            <Button variant="destructive" className="flex-1" disabled={deleting} onClick={handleDelete}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirmation dialog */}
      <Dialog open={bulkDeleteConfirm} onOpenChange={(open) => { if (!open) setBulkDeleteConfirm(false); }}>
        <DialogContent className="max-w-sm">
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
          onSaved={loadTxns}
        />
      )}
    </div>
  );
}
