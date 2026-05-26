"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OnboardingTips } from "@/components/onboarding-tips";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { SUPPORTED_FIAT_CURRENCIES } from "@/lib/fx/supported-currencies";
import { Plus, ChevronLeft, ChevronRight, Trash2, Pencil, SlidersHorizontal, ChevronDown, Receipt, Search, X, Scissors, AlertTriangle, Link2, ArrowRightLeft, Columns3, ArrowUp, ArrowDown, Filter, TrendingUp } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { SplitDialog } from "./_components/split-dialog";
import { TransactionDialog, type TransactionDialogInitialState, type DialogLinkedSibling } from "@/components/transactions/transaction-dialog";
import { formatAccountLabel } from "@/lib/account-label";
import { type TransactionSource, labelForSource, SOURCES } from "@/lib/tx-source";
import {
  COLUMN_IDS as SHARED_COLUMN_IDS,
  COLUMN_LABELS as SHARED_COLUMN_LABELS,
  DEFAULT_COLUMNS as SHARED_DEFAULT_COLUMNS,
  TOGGLEABLE_COLUMN_IDS as SHARED_TOGGLEABLE_COLUMN_IDS,
  SORTABLE_COLUMN_IDS,
  FILTER_COLUMN_TYPES,
  isSortableColumnId,
  type ColumnId as SharedColumnId,
  type SortableColumnId,
  type FilterType,
} from "@/lib/transactions/columns";

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
  // Audit-trio (issue #28). Surfaced as a footer line in the edit dialog so
  // users can see when a row was created/last edited and which writer
  // surface authored it. Server-side fields are non-null (NOT NULL DEFAULTs)
  // but typed optional here for tolerance against any stale client state.
  createdAt?: string | null;
  updatedAt?: string | null;
  source?: TransactionSource | null;
  // Phase 2 portfolio-ops refactor (2026-05-25) — `kind` is the operation
  // discriminator (buy/sell/buy_cash_leg/etc). When set, Edit routes to
  // the dedicated /portfolio/new form instead of the generic edit dialog.
  // `tradeLinkId` is the buy/sell pair UUID — used to fetch the sibling
  // cash leg in the editor.
  kind?: string | null;
  tradeLinkId?: string | null;
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

type Account = {
  id: number;
  name: string;
  currency: string;
  alias?: string | null;
  type?: string | null;
  // Surfaced from /api/accounts so the Transfer dialog can hide the in-kind
  // / portfolio block when neither the source nor destination is an
  // investment account (Section E #10). Always present on the wire because
  // getAccounts uses select()-all on the row.
  isInvestment?: boolean;
};
type Category = { id: number; name: string; type: string; group: string };
type Holding = {
  id: number;
  // accountId is the source-of-truth account linkage on portfolio_holdings.
  // Used to filter the picker in Add Transaction so the user only sees
  // holdings that belong to the selected account. Future M2M migration
  // (Section F/G #15) will swap this for `accounts: number[]`; the dialog
  // filter is the only line that changes.
  accountId: number | null;
  name: string;
  symbol: string | null;
  accountName: string | null;
  // Sum of transactions.quantity for this holding — surfaces in the in-kind
  // Source / Destination dropdowns so the user can see current positions.
  currentShares?: number | null;
};

// SplitRow + emptySplitRow used to live here for the inline Add Transaction
// dialog. They now live inside TransactionDialog. The legacy SplitDialog
// (for editing splits on already-saved transactions) has its own copy at
// _components/split-dialog.tsx.

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

// Issue #59 — discriminated-union shape for per-column filters. Mirrors the
// server-side zod schema in /api/settings/tx-filters; the page state holds
// the same shape so persistence is byte-identical.
type ColFilterShape =
  | { type: "date"; columnId: SharedColumnId; from?: string; to?: string }
  | { type: "text"; columnId: SharedColumnId; value: string }
  | { type: "numeric"; columnId: SharedColumnId; op: "eq" | "gt" | "lt" | "between"; value: number; value2?: number }
  | { type: "enum"; columnId: SharedColumnId; values: string[] };

/**
 * Per-column filter popover. Renders a small dropdown with a type-
 * appropriate input(s) — date range / substring / numeric op / multi-
 * select enum. The icon turns primary-colored when a filter is active.
 *
 * Encrypted-column substring filters route through the post-decrypt path
 * server-side; date / numeric / id / source filters push down into SQL.
 */
function ColumnFilterPopover({
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
  const isActive = !!activeFilter;
  // Local draft state so the user can type without firing one network
  // request per keystroke. Committed on Apply.
  const [draft, setDraft] = useState<ColFilterShape | null>(activeFilter ?? null);
  useEffect(() => {
    setDraft(activeFilter ?? null);
  }, [activeFilter]);

  const initDraft = (): ColFilterShape => {
    if (filterType === "date") return { type: "date", columnId };
    if (filterType === "text") return { type: "text", columnId, value: "" };
    if (filterType === "numeric") return { type: "numeric", columnId, op: "eq", value: 0 };
    return { type: "enum", columnId, values: [] };
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={`p-0.5 rounded hover:bg-muted transition-colors ${isActive ? "text-primary" : "text-muted-foreground/60"}`}
            title={isActive ? "Filter active — click to edit" : "Filter column"}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <Filter className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 p-3 space-y-2">
        {filterType === "date" && (
          <>
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              className="h-8 text-xs"
              value={(draft as { from?: string } | null)?.from ?? ""}
              onChange={(e) => {
                const cur = (draft as ColFilterShape | null) ?? initDraft();
                if (cur.type !== "date") return;
                setDraft({ ...cur, from: e.target.value || undefined });
              }}
              // base-ui Menu.Root attaches keydown listeners on the menu surface
              // for type-ahead (printable chars) and back/close (Backspace).
              // Without this stopPropagation the input never sees its own
              // keystrokes — the menu eats them first. Allow Escape and Tab
              // to bubble so dropdown-close + focus traversal still work.
              onKeyDown={(e) => {
                if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
              }}
            />
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              className="h-8 text-xs"
              value={(draft as { to?: string } | null)?.to ?? ""}
              onChange={(e) => {
                const cur = (draft as ColFilterShape | null) ?? initDraft();
                if (cur.type !== "date") return;
                setDraft({ ...cur, to: e.target.value || undefined });
              }}
              onKeyDown={(e) => {
                if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
              }}
            />
          </>
        )}
        {filterType === "text" && (
          <>
            <Label className="text-xs">Contains</Label>
            <Input
              className="h-8 text-xs"
              placeholder="Substring…"
              value={(draft as { value?: string } | null)?.value ?? ""}
              onChange={(e) => setDraft({ type: "text", columnId, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
              }}
            />
          </>
        )}
        {filterType === "numeric" && (
          <>
            <Label className="text-xs">Operator</Label>
            <Select
              value={(draft as { op?: string } | null)?.op ?? "eq"}
              onValueChange={(v) => {
                const op = (v ?? "eq") as "eq" | "gt" | "lt" | "between";
                const cur = draft && draft.type === "numeric" ? draft : { type: "numeric" as const, columnId, value: 0, op };
                setDraft({ ...cur, op } as ColFilterShape);
              }}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="eq">=</SelectItem>
                <SelectItem value="gt">&gt;</SelectItem>
                <SelectItem value="lt">&lt;</SelectItem>
                <SelectItem value="between">Between</SelectItem>
              </SelectContent>
            </Select>
            <Label className="text-xs">Value</Label>
            <Input
              type="number"
              className="h-8 text-xs"
              value={(draft as { value?: number } | null)?.value ?? ""}
              onChange={(e) => {
                const n = e.target.value === "" ? 0 : Number(e.target.value);
                if (!Number.isFinite(n)) return;
                const cur = draft && draft.type === "numeric" ? draft : { type: "numeric" as const, columnId, op: "eq" as const, value: 0 };
                setDraft({ ...cur, value: n } as ColFilterShape);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
              }}
            />
            {draft?.type === "numeric" && draft.op === "between" && (
              <>
                <Label className="text-xs">Upper bound</Label>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={draft.value2 ?? ""}
                  onChange={(e) => {
                    const n = e.target.value === "" ? undefined : Number(e.target.value);
                    if (n != null && !Number.isFinite(n)) return;
                    setDraft({ ...draft, value2: n });
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
                  }}
                />
              </>
            )}
          </>
        )}
        {filterType === "enum" && (
          <>
            <Label className="text-xs">Match any of</Label>
            <div className="max-h-48 overflow-y-auto space-y-1 border rounded p-2">
              {columnId === "source" &&
                SOURCES.map((s) => {
                  const checked = draft?.type === "enum" && draft.values.includes(s);
                  return (
                    <label key={s} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const cur = draft && draft.type === "enum" ? draft : { type: "enum" as const, columnId, values: [] };
                          const values = e.target.checked
                            ? Array.from(new Set([...cur.values, s]))
                            : cur.values.filter((v) => v !== s);
                          setDraft({ ...cur, values });
                        }}
                      />
                      {labelForSource(s)}
                    </label>
                  );
                })}
              {columnId === "category" &&
                categories.map((cat) => {
                  const checked = draft?.type === "enum" && draft.values.includes(String(cat.id));
                  return (
                    <label key={cat.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const cur = draft && draft.type === "enum" ? draft : { type: "enum" as const, columnId, values: [] };
                          const values = e.target.checked
                            ? Array.from(new Set([...cur.values, String(cat.id)]))
                            : cur.values.filter((v) => v !== String(cat.id));
                          setDraft({ ...cur, values });
                        }}
                      />
                      {cat.name}
                    </label>
                  );
                })}
              {columnId === "account" &&
                accounts.map((a) => {
                  const checked = draft?.type === "enum" && draft.values.includes(String(a.id));
                  return (
                    <label key={a.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const cur = draft && draft.type === "enum" ? draft : { type: "enum" as const, columnId, values: [] };
                          const values = e.target.checked
                            ? Array.from(new Set([...cur.values, String(a.id)]))
                            : cur.values.filter((v) => v !== String(a.id));
                          setDraft({ ...cur, values });
                        }}
                      />
                      {a.name}
                    </label>
                  );
                })}
              {columnId === "accountType" &&
                Array.from(new Set(accounts.map((a) => a.type).filter(Boolean) as string[])).map((t) => {
                  const checked = draft?.type === "enum" && draft.values.includes(t);
                  return (
                    <label key={t} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const cur = draft && draft.type === "enum" ? draft : { type: "enum" as const, columnId, values: [] };
                          const values = e.target.checked
                            ? Array.from(new Set([...cur.values, t]))
                            : cur.values.filter((v) => v !== t);
                          setDraft({ ...cur, values });
                        }}
                      />
                      {t}
                    </label>
                  );
                })}
            </div>
          </>
        )}
        <DropdownMenuSeparator />
        <div className="flex gap-2 justify-end">
          {isActive && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onChange(null)}
            >
              Clear
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              if (!draft) {
                onChange(null);
                return;
              }
              // Drop empty-state filters (no values, no inputs)
              if (draft.type === "date" && !draft.from && !draft.to) onChange(null);
              else if (draft.type === "text" && !draft.value.trim()) onChange(null);
              else if (draft.type === "enum" && draft.values.length === 0) onChange(null);
              else onChange(draft);
            }}
          >
            Apply
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const router = useRouter();
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const sortAccount = useDropdownOrder("account");
  const sortCategory = useDropdownOrder("category");
  const sortHolding = useDropdownOrder("holding");
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
  //
  // Issue #59: column metadata sourced from `@/lib/transactions/columns`
  // so the API routes, the sort whitelist, and the page client share one
  // authority. Adding/removing a column happens there.
  type ColumnId = SharedColumnId;
  type ColumnPref = { id: ColumnId; visible: boolean };
  const ALL_COLUMNS = SHARED_COLUMN_IDS as readonly ColumnId[];
  const COLUMN_LABELS = SHARED_COLUMN_LABELS;
  const TOGGLEABLE_COLUMNS = new Set<ColumnId>(SHARED_TOGGLEABLE_COLUMN_IDS);
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

  // Per-user header sort (issue #59). `null` direction = unsorted (default
  // `date DESC` server-side). Persisted via /api/settings/tx-sort. Cycles
  // desc → asc → null on repeated clicks.
  type SortPref = { columnId: SortableColumnId | null; direction: "asc" | "desc" | null };
  const [sortPref, setSortPref] = useState<SortPref>({ columnId: null, direction: null });
  const sortPrefLoaded = useRef(false);
  const sortPrefSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/tx-sort")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: SortPref | null) => {
        if (cancelled) return;
        if (d && (d.columnId === null || isSortableColumnId(d.columnId)) && (d.direction === null || d.direction === "asc" || d.direction === "desc")) {
          setSortPref({ columnId: d.columnId, direction: d.direction });
        }
      })
      .catch(() => { /* default = unsorted */ })
      .finally(() => {
        if (!cancelled) sortPrefLoaded.current = true;
      });
    return () => { cancelled = true; };
  }, []);
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
    setPage(0);
  }

  // Per-column filters (issue #59). Discriminated union by column type;
  // persisted via /api/settings/tx-filters. Each column has at most one
  // filter active at a time. Shape mirrors the server-side zod schema.
  type ColFilter = ColFilterShape;
  const [colFilters, setColFilters] = useState<ColFilter[]>([]);
  const colFiltersLoaded = useRef(false);
  const colFiltersSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/tx-filters")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { filters?: ColFilter[] } | null) => {
        if (cancelled) return;
        if (d?.filters) setColFilters(d.filters);
      })
      .catch(() => { /* default = no filters */ })
      .finally(() => {
        if (!cancelled) colFiltersLoaded.current = true;
      });
    return () => { cancelled = true; };
  }, []);
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
  function findColFilter(columnId: ColumnId): ColFilter | undefined {
    return colFilters.find((f) => f.columnId === columnId);
  }
  function setColFilter(filter: ColFilter | null, columnId: ColumnId) {
    setColFilters((prev) => {
      const without = prev.filter((f) => f.columnId !== columnId);
      return filter ? [...without, filter] : without;
    });
    setPage(0);
  }
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

    // Issue #59 — sort + per-column filters. The top-bar quick filters
    // above are URL-driven (deep links from /portfolio etc. must keep
    // working); per-column filters are persisted server-side. Pushed as
    // a union — both sets narrow the result.
    if (sortPref.columnId && sortPref.direction) {
      params.set("sort", sortPref.columnId);
      params.set("sortDir", sortPref.direction);
    }
    for (const f of colFilters) {
      if (f.type === "date") {
        // Map column id → query param prefix that the route handler
        // recognizes. `date` reuses the existing startDate/endDate;
        // `createdAt`/`updatedAt` use their own pair.
        if (f.columnId === "date") {
          // Only set if the top-bar quick filter hasn't already.
          if (!params.has("startDate") && f.from) params.set("startDate", f.from);
          if (!params.has("endDate") && f.to) params.set("endDate", f.to);
        } else if (f.columnId === "createdAt") {
          if (f.from) params.set("createdAtFrom", f.from);
          if (f.to) params.set("createdAtTo", f.to);
        } else if (f.columnId === "updatedAt") {
          if (f.from) params.set("updatedAtFrom", f.from);
          if (f.to) params.set("updatedAtTo", f.to);
        }
      } else if (f.type === "text") {
        // Encrypted-column substring filter — uses the post-decrypt path.
        params.set(`filter_${f.columnId}`, f.value);
      } else if (f.type === "numeric") {
        const prefix = f.columnId === "amount" ? "amount" : f.columnId === "quantity" ? "quantity" : null;
        if (!prefix) continue;
        if (f.op === "eq") {
          params.set(`${prefix}Eq`, String(f.value));
        } else if (f.op === "gt") {
          params.set(`${prefix}Min`, String(f.value));
        } else if (f.op === "lt") {
          params.set(`${prefix}Max`, String(f.value));
        } else if (f.op === "between") {
          params.set(`${prefix}Min`, String(f.value));
          if (f.value2 != null) params.set(`${prefix}Max`, String(f.value2));
        }
      } else if (f.type === "enum") {
        if (f.columnId === "source") {
          params.set("sources", f.values.join(","));
        } else if (f.columnId === "category") {
          params.set("categoryIds", f.values.join(","));
        } else if (f.columnId === "account" || f.columnId === "accountType") {
          // accountType doesn't have a SQL pushdown — it's part of the
          // account JOIN. Push the ids of accounts of that type instead.
          if (f.columnId === "accountType") {
            const ids = accounts
              .filter((a) => a.type && f.values.includes(a.type))
              .map((a) => a.id);
            if (ids.length > 0) params.set("accountIds", ids.join(","));
          } else {
            params.set("accountIds", f.values.join(","));
          }
        }
      }
    }

    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    fetch(`/api/transactions?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setTxns(d.data ?? []);
        setTotal(d.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [filters, page, sortPref, colFilters, accounts]);

  useEffect(() => { loadTxns(); }, [loadTxns]);

  useEffect(() => {
    fetch("/api/accounts").then((r) => r.ok ? r.json() : []).then(setAccounts);
    fetch("/api/categories").then((r) => r.ok ? r.json() : []).then(setCategories);
    fetch("/api/portfolio").then((r) => r.ok ? r.json() : []).then(setHoldings);
  }, []);

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
    // Issue #59 — also wipe the per-column filters + sort. The chip row
    // below the top-bar shows both, so "Clear all" should drop both.
    setColFilters([]);
    setSortPref({ columnId: null, direction: null });
    setPage(0);
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
      // Portfolio edit-guard refusal (Phase 2 of the ops refactor). The server
      // returns 409 + the list of dependent closure tx ids when the row being
      // deleted opens a lot that's been sold or transferred out. Surface the
      // list so the user can jump to the blocking row and delete it first.
      const data = await res.json().catch(() => ({}));
      if (data?.code === "portfolio_edit_blocked") {
        setDeleteBlockedError({
          message: data.error ?? "Delete blocked by portfolio dependencies",
          blockingIds: Array.isArray(data.blockingClosureTxIds)
            ? (data.blockingClosureTxIds as number[])
            : [],
        });
        return;
      }
      alert(data?.error ?? `Delete failed (${res.status})`);
      return;
    }
    setDeleteConfirmId(null);
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
  return (
    /* FINLYNQ-52 (was issue #59 workaround): the (app)-shell width clamp
       was removed in src/app/(app)/layout.tsx, so this page no longer
       needs the negative-margin escape hatch. The card body still wraps
       the table in `overflow-x-auto` so long column lists scroll
       horizontally rather than truncate. */
    <div className="space-y-6">
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
        <TransactionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          accounts={accounts}
          categories={categories}
          holdings={holdings}
          initialState={dialogInitial}
          onSaved={async () => {
            loadTxns();
          }}
          onRequestDelete={(t) => confirmDelete(t as Transaction)}
          onLinkedSiblingClick={(s) => openLinkedSibling(s as LinkedSibling)}
        />
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
            {(filters.startDate || filters.endDate || filters.accountId || filters.categoryId || filters.search || filters.portfolioHolding || filters.tag || colFilters.length > 0 || sortPref.columnId) && (
              <button onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors ml-1">
                <X className="h-3 w-3" /> Clear all
              </button>
            )}
          </div>
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
            <div className="overflow-x-auto">
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
                    const sortable = isSortableColumnId(c.id);
                    const filterType = FILTER_COLUMN_TYPES[c.id];
                    const activeFilter = findColFilter(c.id);
                    const sortActive = sortPref.columnId === c.id ? sortPref.direction : null;
                    return (
                      <TableHead
                        key={c.id}
                        className={`${widthClass} ${isAmount ? "text-right" : ""} ${isDraggable ? "select-none" : ""} ${isDragging ? "opacity-50" : ""}`}
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
                          <div className={`flex items-center gap-1 ${isAmount ? "justify-end" : ""}`}>
                            {sortable ? (
                              <button
                                type="button"
                                onClick={() => cycleSort(c.id as SortableColumnId)}
                                className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
                                title="Click to sort"
                              >
                                <span>{COLUMN_LABELS[c.id]}</span>
                                {sortActive === "asc" && <ArrowUp className="h-3 w-3 text-primary" />}
                                {sortActive === "desc" && <ArrowDown className="h-3 w-3 text-primary" />}
                              </button>
                            ) : (
                              <span>{COLUMN_LABELS[c.id]}</span>
                            )}
                            {filterType && (
                              <ColumnFilterPopover
                                columnId={c.id}
                                filterType={filterType}
                                activeFilter={activeFilter}
                                onChange={(f) => setColFilter(f, c.id)}
                                accounts={accounts}
                                categories={categories}
                              />
                            )}
                          </div>
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
                        case "createdAt":
                          return (
                            <TableCell key={c.id} className="text-sm text-muted-foreground whitespace-nowrap">
                              {t.createdAt ? formatDate(t.createdAt.split("T")[0]) : "-"}
                            </TableCell>
                          );
                        case "updatedAt":
                          return (
                            <TableCell key={c.id} className="text-sm text-muted-foreground whitespace-nowrap">
                              {t.updatedAt ? formatDate(t.updatedAt.split("T")[0]) : "-"}
                            </TableCell>
                          );
                        case "source":
                          return (
                            <TableCell key={c.id} className="text-sm">
                              {t.source ? (
                                <Badge variant="outline" className="text-[10px]">
                                  {labelForSource(t.source)}
                                </Badge>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                          );
                        case "kind": {
                          // Phase 2 canonicalization tag — surfaces what the
                          // /settings/backfill coverage dashboard reads from.
                          // Empty = not yet canonicalized (legacy/pre-Phase-2
                          // or pre-backfill). A coloured pill means the row
                          // has a portfolio-op shape the lot engine recognizes.
                          // `opening_balance` (violet) is distinct from `buy`
                          // (amber) so users can tell carried-in positions
                          // from regular buys at a glance.
                          //
                          // Solid border = row is coverage-canonical
                          // (PAIRLESS kind OR trade_link_id OR link_id).
                          // Dashed border = kind is set but the row is still
                          // coverage-pending (needs a pair / is missing
                          // canonical shape). Mirror of
                          // PAIRLESS_CANONICAL_KINDS in
                          // src/lib/portfolio/backfill/types.ts — keep in
                          // sync with the coverage SQL predicate.
                          const PAIRLESS_KINDS = new Set([
                            "dividend",
                            "interest",
                            "portfolio_income",
                            "portfolio_expense",
                            "opening_balance",
                          ]);
                          const isCanonical =
                            !!t.kind &&
                            (PAIRLESS_KINDS.has(t.kind) ||
                              t.tradeLinkId != null ||
                              t.linkId != null);
                          // Badge already renders `border` (1px). Add
                          // `border-dashed` for pending rows; default solid
                          // for canonical rows.
                          const borderStyle = isCanonical ? "" : "border-dashed";
                          return (
                            <TableCell key={c.id} className="text-sm">
                              {t.kind ? (
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] ${borderStyle} ${
                                    /_cash_leg$/.test(t.kind)
                                      ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                      : t.kind === "dividend" || t.kind === "interest"
                                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                        : t.kind === "opening_balance"
                                          ? "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                                          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                  }`}
                                  title={
                                    isCanonical
                                      ? t.kind
                                      : `${t.kind} — pending canonicalization, visit /settings/backfill`
                                  }
                                >
                                  {t.kind}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground/50">—</span>
                              )}
                            </TableCell>
                          );
                        }
                        case "canonical": {
                          // 2026-06-09 — companion to the `kind` column.
                          // Mirrors the predicate the /settings/backfill
                          // coverage dashboard uses to count canonical vs
                          // pending vs not-yet-classified rows. Keep this
                          // PAIRLESS set in sync with PAIRLESS_CANONICAL_KINDS
                          // in src/lib/portfolio/backfill/types.ts and with
                          // the duplicate set above in the `kind` case —
                          // ideally hoist to module scope on next touch.
                          const PAIRLESS_KINDS = new Set([
                            "dividend",
                            "interest",
                            "portfolio_income",
                            "portfolio_expense",
                            "opening_balance",
                          ]);
                          const status: "canonical" | "pending" | "none" =
                            t.kind == null
                              ? "none"
                              : PAIRLESS_KINDS.has(t.kind) ||
                                  t.tradeLinkId != null ||
                                  t.linkId != null
                                ? "canonical"
                                : "pending";
                          return (
                            <TableCell key={c.id} className="text-sm">
                              {status === "canonical" ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  title="Row has a canonical Phase-2 shape — kind set AND (pair-less kind OR trade_link_id OR link_id)."
                                >
                                  canonical
                                </Badge>
                              ) : status === "pending" ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 border-dashed"
                                  title={`Kind is '${t.kind}' but row lacks the canonical pair shape — visit /settings/backfill to canonicalize.`}
                                >
                                  pending
                                </Badge>
                              ) : (
                                <span
                                  className="text-muted-foreground/50"
                                  title="No kind set — row predates Phase-2 portfolio ops or has no portfolio-op classification."
                                >
                                  —
                                </span>
                              )}
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
            </div>
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
      <Dialog open={deleteConfirmId !== null} onOpenChange={(open) => {
        if (!open) {
          setDeleteConfirmId(null);
          setDeleteBlockedError(null);
        }
      }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete Transaction
            </DialogTitle>
          </DialogHeader>
          {deleteBlockedError ? (
            <div className="space-y-3">
              <p className="text-sm text-amber-900 dark:text-amber-200">
                {deleteBlockedError.message}
              </p>
              {deleteBlockedError.blockingIds.length > 0 && (
                <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800/60 p-3 text-xs">
                  <p className="font-medium text-amber-900 dark:text-amber-200 mb-1.5">
                    Dependent rows:
                  </p>
                  <ul className="space-y-1">
                    {deleteBlockedError.blockingIds.map((id) => (
                      <li key={id}>
                        <Link
                          href={`/transactions?search=%23${id}`}
                          className="text-amber-700 dark:text-amber-300 underline hover:no-underline"
                          onClick={() => {
                            setDeleteConfirmId(null);
                            setDeleteBlockedError(null);
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
                  onClick={() => {
                    setDeleteConfirmId(null);
                    setDeleteBlockedError(null);
                  }}
                >
                  Close
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
