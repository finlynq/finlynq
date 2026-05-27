"use client";

/**
 * /reconcile — standalone bank-ledger ↔ transactions reconciliation page.
 *
 * Built 2026-05-23 as the follow-up to the 2026-05-22 two-ledger import
 * refactor (FINLYNQ-96). Three-layer match: existing links (join table),
 * exact-hash suggestions (same import_hash, no link yet), fuzzy suggestions
 * (score-based, user-configurable threshold).
 *
 * Per-account view in v1; cross-account roadmap. Account selector is the
 * page's single piece of session state; persisted in the URL so a tab
 * close + reopen restores it.
 *
 * Data flow:
 *   GET /api/accounts                               → account list
 *   GET /api/reconcile/suggestions?accountId=X     → full reconcile snapshot
 *   POST /api/reconcile/links                       → accept a suggestion
 *   DELETE /api/reconcile/links                     → unlink
 *   POST /api/reconcile/materialize                 → create-from-bank-only
 *
 * Refresh after every mutation by re-fetching the suggestions endpoint.
 * The endpoint runs the whole match engine cold per request, which is
 * fine for the per-account scope. If multi-account latency becomes a
 * concern we can swap in optimistic local updates.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowRight, Settings as SettingsIcon } from "lucide-react";
import { TwoPaneLayout } from "@/components/import/reconcile/two-pane-layout";
import { BankPane, type BankRow } from "@/components/reconcile/bank-pane";
import {
  TransactionsPane,
  type TxRow,
} from "@/components/reconcile/transactions-pane";
import type { SuggestionDisplay } from "@/components/reconcile/suggestion-card";
import type { ReconcileBadgeVariant } from "@/components/reconcile/match-pill";
import {
  TransactionDialog,
  type TransactionDialogInitialState,
  type DialogCategory,
  type DialogHolding,
} from "@/components/transactions/transaction-dialog";
import {
  BalanceSummaryCard,
  type BalanceSummary,
} from "@/components/reconcile/balance-summary-card";
import { RecentUploadsPanel } from "@/components/reconcile/recent-uploads-panel";
import { ConfirmDeleteBankRow } from "@/components/reconcile/confirm-delete-bank-row";
import { BulkLinkActionBar } from "@/components/reconcile/bulk-link-action-bar";
import { safeAccountName } from "@/lib/safe-name";

interface Account {
  id: number;
  /** Decrypted formal name (post `decryptNamedRows`). Nullable because
   *  `decryptNamedRows` returns null when the DEK isn't in cache (post-
   *  deploy idle timeout) or when the ciphertext won't decrypt under the
   *  user's current DEK (pathfinder mismatch). The display layer falls
   *  back to `Account #<id>` in that case. */
  name: string | null;
  /** Decrypted alias — friendly display name. Preferred over `name`
   *  when set, matching the convention on other pages. */
  alias?: string | null;
  currency: string;
  archived?: boolean;
  /** Surfaced from /api/accounts so the reconcile materialize button can
   *  route investment-account bank rows to /portfolio/new instead of the
   *  generic TransactionDialog (per the investment-account constraint). */
  isInvestment?: boolean;
}

/** Date-window preset for the quick-fill chip group. `null` = all time. */
const LOOKBACK_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "30d", value: 30 },
  { label: "60d", value: 60 },
  { label: "90d", value: 90 },
  { label: "6mo", value: 180 },
  { label: "All", value: null },
];
const DEFAULT_LOOKBACK_DAYS = 60;

/** Return the YYYY-MM-DD that is `deltaDays` from today (UTC). */
function shiftDaysFromToday(deltaDays: number): string {
  const ms = Date.now() + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse explicit `?from=YYYY-MM-DD` with legacy `?range=N` back-compat.
 *  Legacy `?range=` is read once and converted on next persist. */
function parseDateFromUrl(): string | null {
  if (typeof window === "undefined") {
    return shiftDaysFromToday(-DEFAULT_LOOKBACK_DAYS);
  }
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("from");
  if (explicit && ISO_DATE_RE.test(explicit)) return explicit;
  const range = params.get("range");
  if (range === "all") return null;
  const n = range ? parseInt(range, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return shiftDaysFromToday(-n);
  return shiftDaysFromToday(-DEFAULT_LOOKBACK_DAYS);
}

/** Parse explicit `?to=YYYY-MM-DD`. No legacy equivalent. */
function parseDateToUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("to");
  if (explicit && ISO_DATE_RE.test(explicit)) return explicit;
  return null;
}

function describeRange(from: string | null, to: string | null): string {
  if (from && to) return `${from} → ${to}`;
  if (from) return `from ${from}`;
  if (to) return `until ${to}`;
  return "all time";
}

interface ReconcileLink {
  transactionId: number;
  bankTransactionId: string;
  linkType: "primary" | "extra";
  source: string;
  createdAt: string;
}

interface ReconcileSuggestion {
  transactionId: number;
  bankTransactionId: string;
  strategy: "join_existing" | "exact_hash" | "fuzzy";
  score: number;
  reason: string;
  daysOff: number;
  amountDeltaAbs: number;
}

interface TxSnapshot {
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  categoryName: string | null;
  categoryType: string | null;
  importHash: string | null;
  accountId: number;
  /** Transfer-pair / portfolio-pair lineage for the click-to-highlight UX.
   *  Plan #5 (2026-05-25). Null when the tx is not part of any pair. */
  linkId: string | null;
  tradeLinkId: string | null;
  swapLinkId: string | null;
}

interface BankSnapshot {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  importHash: string;
  accountId: number;
  seenCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Rule-engine suggestion for the materialize dialog. */
  suggestedCategoryId: number | null;
}

interface ReconcileData {
  linked: ReconcileLink[];
  suggestions: ReconcileSuggestion[];
  bankOnly: string[];
  txOnly: number[];
  transactions: Record<number, TxSnapshot>;
  bankTransactions: Record<string, BankSnapshot>;
  thresholds: {
    dateToleranceDays: number;
    amountTolerancePct: number;
    amountToleranceFloor: number;
    scoreThreshold: number;
  };
  /** Echoed back by the server so the UI can confirm what window it used.
   *  `lookbackDays` is retained for legacy URL back-compat; new URLs use
   *  explicit `dateMin` + `dateMax`. */
  lookbackDays: number | null;
  dateMin: string | null;
  dateMax: string | null;
}

export default function ReconcilePage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(
    null,
  );
  const [data, setData] = useState<ReconcileData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Composite "txId:bankId" key for the accept/reject in flight. */
  const [busySuggestionKey, setBusySuggestionKey] = useState<string | null>(
    null,
  );
  const [busyBankId, setBusyBankId] = useState<string | null>(null);
  /** Reject is local-only — page-scoped Set. Matches /import/pending pattern. */
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  /** Explicit date window. Both null = all time. Both can be edited
   *  independently in the UI (date inputs) or co-set via the chip presets
   *  ("30d" → from = today-30d, to = today). Defaults to last 60d. */
  const [dateFrom, setDateFrom] = useState<string | null>(parseDateFromUrl());
  const [dateTo, setDateTo] = useState<string | null>(parseDateToUrl());
  /** Loaded once on mount. TransactionDialog renders these in its
   *  category picker; the bank-pool rule engine already used the same
   *  ids server-side to compute `suggestedCategoryId` per bank row. */
  const [categories, setCategories] = useState<DialogCategory[]>([]);
  const [holdings, setHoldings] = useState<DialogHolding[]>([]);
  /** Materialize dialog state. `materializeBankId` is set ONLY when the
   *  dialog was opened from a bank-only row (i.e. should auto-write a
   *  reconcile link on save); null for other create paths. */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] = useState<TransactionDialogInitialState | null>(null);
  const [materializeBankId, setMaterializeBankId] = useState<string | null>(null);
  const router = useRouter();

  /** Click-to-highlight set (plan #5). Computed client-side from `data`'s
   *  transaction snapshots + link records when the user clicks a row.
   *  Clicking the same row clears the set; clicking a different row
   *  swaps in the new neighborhood. Transient — refresh clears. */
  const [highlightedTxIds, setHighlightedTxIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [highlightedBankIds, setHighlightedBankIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Anchor row — the one the user clicked — so a second click on the
   *  same row toggles the highlight off. Encoded as `tx:<id>` or
   *  `bank:<uuid>`. Null = no active highlight. */
  const [highlightAnchor, setHighlightAnchor] = useState<string | null>(null);

  /** Per-row bank-transaction delete (2026-05-27). When a linked bank row
   *  is clicked, the page shows the ConfirmDeleteBankRow modal first and
   *  stashes the snapshot here; bank-only rows skip the modal and call
   *  the delete fetch directly. */
  const [deleteConfirm, setDeleteConfirm] = useState<{
    bankId: string;
    date: string;
    amount: number;
    currency: string;
    payee: string | null;
    linkedTransactionCount: number;
  } | null>(null);

  /** Bulk-link selection state (2026-05-27). Independent on each pane. */
  const [selectedTxIds, setSelectedTxIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [selectedBankIds, setSelectedBankIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [bulkLinking, setBulkLinking] = useState(false);

  /** Build the neighborhood for a clicked tx. Pair siblings are computed
   *  from the tx snapshots in `data` — linkId for transfers, tradeLinkId
   *  for portfolio pairs, swapLinkId for swap quads. Bank-side fan-out
   *  pulls every bank row joined to any tx in the set. */
  const computeNeighborhoodFromTx = useCallback(
    (txId: number) => {
      const txIds = new Set<number>([txId]);
      const bankIds = new Set<string>();
      if (!data) return { txIds, bankIds };
      const anchor = data.transactions[txId];
      if (anchor) {
        const matchKeys: Array<[keyof TxSnapshot, string]> = [
          ["linkId", anchor.linkId ?? ""],
          ["tradeLinkId", anchor.tradeLinkId ?? ""],
          ["swapLinkId", anchor.swapLinkId ?? ""],
        ];
        for (const [key, val] of matchKeys) {
          if (!val) continue;
          for (const other of Object.values(data.transactions)) {
            if (other[key] === val) txIds.add(other.id);
          }
        }
      }
      for (const link of data.linked) {
        if (txIds.has(link.transactionId)) bankIds.add(link.bankTransactionId);
      }
      return { txIds, bankIds };
    },
    [data],
  );

  /** Build the neighborhood for a clicked bank row. Walks tx links then
   *  fans out through tx pair lineage so a click on a bank row that's
   *  linked to one leg of a transfer pair highlights both legs. */
  const computeNeighborhoodFromBank = useCallback(
    (bankId: string) => {
      const txIds = new Set<number>();
      const bankIds = new Set<string>([bankId]);
      if (!data) return { txIds, bankIds };
      for (const link of data.linked) {
        if (link.bankTransactionId === bankId) txIds.add(link.transactionId);
      }
      // Expand each linked tx through its pair lineage, then re-fan back
      // to bank ids for the full neighborhood.
      const seedTxIds = [...txIds];
      for (const seedId of seedTxIds) {
        const seed = data.transactions[seedId];
        if (!seed) continue;
        const matchKeys: Array<[keyof TxSnapshot, string]> = [
          ["linkId", seed.linkId ?? ""],
          ["tradeLinkId", seed.tradeLinkId ?? ""],
          ["swapLinkId", seed.swapLinkId ?? ""],
        ];
        for (const [key, val] of matchKeys) {
          if (!val) continue;
          for (const other of Object.values(data.transactions)) {
            if (other[key] === val) txIds.add(other.id);
          }
        }
      }
      for (const link of data.linked) {
        if (txIds.has(link.transactionId)) bankIds.add(link.bankTransactionId);
      }
      return { txIds, bankIds };
    },
    [data],
  );

  const onTxRowClick = useCallback(
    (txId: number) => {
      const anchorKey = `tx:${txId}`;
      if (highlightAnchor === anchorKey) {
        setHighlightAnchor(null);
        setHighlightedTxIds(new Set());
        setHighlightedBankIds(new Set());
        return;
      }
      const { txIds, bankIds } = computeNeighborhoodFromTx(txId);
      setHighlightAnchor(anchorKey);
      setHighlightedTxIds(txIds);
      setHighlightedBankIds(bankIds);
    },
    [highlightAnchor, computeNeighborhoodFromTx],
  );

  const onBankRowClick = useCallback(
    (bankId: string) => {
      const anchorKey = `bank:${bankId}`;
      if (highlightAnchor === anchorKey) {
        setHighlightAnchor(null);
        setHighlightedTxIds(new Set());
        setHighlightedBankIds(new Set());
        return;
      }
      const { txIds, bankIds } = computeNeighborhoodFromBank(bankId);
      setHighlightAnchor(anchorKey);
      setHighlightedTxIds(txIds);
      setHighlightedBankIds(bankIds);
    },
    [highlightAnchor, computeNeighborhoodFromBank],
  );
  /** Bank-vs-system balance summary for the selected account (Bank says /
   *  Finlynq has / Delta). Surfaced above the two-pane layout. */
  const [balanceSummary, setBalanceSummary] = useState<BalanceSummary | null>(
    null,
  );
  const [balanceSummaryLoading, setBalanceSummaryLoading] = useState(false);

  // ─── Load accounts ──────────────────────────────────────────────────
  // We fetch with `includeArchived=1` so the materialize dialog can render
  // a friendly name for a bank row whose account was archived after the
  // statement landed. The per-page dropdown still filters out archived
  // (reconcile is rarely useful there) but the full list is available for
  // dialog lookups.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/accounts?includeArchived=1");
        if (!res.ok) throw new Error(`accounts: ${res.status}`);
        const rows: Account[] = await res.json();
        if (cancelled) return;
        setAccounts(rows);
        const visible = rows.filter((a) => !a.archived);

        // Restore from URL or default to the first account.
        const params = new URLSearchParams(window.location.search);
        const urlAccount = params.get("account");
        const urlId = urlAccount ? parseInt(urlAccount, 10) : NaN;
        if (
          Number.isFinite(urlId) &&
          visible.some((a) => a.id === urlId)
        ) {
          setSelectedAccountId(urlId);
        } else if (visible[0]) {
          setSelectedAccountId(visible[0].id);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Persist account selection + date window in URL ────────────────
  // Legacy `?range=` is removed on the first persist after a navigation
  // that included it (parseDateFromUrl already absorbed the value).
  useEffect(() => {
    if (selectedAccountId == null) return;
    const url = new URL(window.location.href);
    url.searchParams.set("account", String(selectedAccountId));
    if (dateFrom) url.searchParams.set("from", dateFrom);
    else url.searchParams.delete("from");
    if (dateTo) url.searchParams.set("to", dateTo);
    else url.searchParams.delete("to");
    url.searchParams.delete("range");
    window.history.replaceState({}, "", url.toString());
  }, [selectedAccountId, dateFrom, dateTo]);

  // ─── Load categories + holdings (once) ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/categories");
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{
          id: number;
          // Nullable for the same DEK-missing reason as Account.name.
          name: string | null;
          type: string;
          group?: string | null;
        }>;
        if (cancelled) return;
        setCategories(
          rows.map((r) => ({
            id: r.id,
            name: r.name?.trim() ? r.name : `Category #${r.id}`,
            type: r.type,
            group: r.group ?? "",
          })),
        );
      } catch {
        // Non-fatal — the dialog will just show an empty category list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/portfolio")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled) return;
        setHoldings(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        /* dialog handles empty list — non-investment accounts don't need it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Load reconcile snapshot ───────────────────────────────────────
  const refresh = useCallback(async () => {
    if (selectedAccountId == null) return;
    setDataLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ accountId: String(selectedAccountId) });
      if (dateFrom) qs.set("dateMin", dateFrom);
      if (dateTo) qs.set("dateMax", dateTo);
      const res = await fetch(`/api/reconcile/suggestions?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (!body.success) {
        throw new Error(body.error ?? "Unknown error");
      }
      setData(body.data as ReconcileData);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setDataLoading(false);
    }
  }, [selectedAccountId, dateFrom, dateTo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ─── Load bank-vs-system balance summary ───────────────────────────
  // Re-runs whenever the account changes OR the reconcile snapshot
  // mutates (a fresh link/unlink/materialize can shift the system side).
  useEffect(() => {
    if (selectedAccountId == null) {
      setBalanceSummary(null);
      return;
    }
    let cancelled = false;
    setBalanceSummaryLoading(true);
    fetch(`/api/reconcile/balance-summary?accountId=${selectedAccountId}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body?.success) {
          setBalanceSummary(body.data as BalanceSummary);
        } else {
          setBalanceSummary(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setBalanceSummary(null);
      })
      .finally(() => {
        if (cancelled) return;
        setBalanceSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId, data]);

  // Visible accounts for the per-page dropdown — archived excluded.
  // The full `accounts` list (incl. archived) is passed to the materialize
  // dialog so bank rows on archived accounts still render friendly names.
  const visibleAccounts = useMemo(
    () => accounts.filter((a) => !a.archived),
    [accounts],
  );

  // ─── Derive BankRow[] + TxRow[] for the panes ──────────────────────
  const { bankRows, txRows, counts } = useMemo(() => {
    if (!data)
      return {
        bankRows: [] as BankRow[],
        txRows: [] as TxRow[],
        counts: { linked: 0, suggested: 0, bankOnly: 0, txOnly: 0 },
      };

    // Index links + suggestions for O(1) lookup.
    const linkByTx = new Map<number, ReconcileLink>();
    const linkByBank = new Map<string, ReconcileLink>();
    for (const l of data.linked) {
      linkByTx.set(l.transactionId, l);
      linkByBank.set(l.bankTransactionId, l);
    }
    // Filter out client-side rejected suggestions.
    const liveSuggestions = data.suggestions.filter(
      (s) =>
        !rejected.has(`${s.transactionId}:${s.bankTransactionId}`),
    );
    const suggestionByTx = new Map<number, ReconcileSuggestion>();
    const suggestionByBank = new Map<string, ReconcileSuggestion>();
    for (const s of liveSuggestions) {
      // Only surface one suggestion per row (the engine is greedy, but
      // re-running after a partial accept may produce duplicates while
      // refresh is in flight — guard defensively).
      if (!suggestionByTx.has(s.transactionId)) {
        suggestionByTx.set(s.transactionId, s);
      }
      if (!suggestionByBank.has(s.bankTransactionId)) {
        suggestionByBank.set(s.bankTransactionId, s);
      }
    }

    // Bank rows: sorted by date desc, status pill driven by linked /
    // suggested / bank_only classification.
    const bankIds = Object.keys(data.bankTransactions);
    bankIds.sort((a, b) => {
      const da = data.bankTransactions[a].date;
      const db = data.bankTransactions[b].date;
      return db.localeCompare(da);
    });
    const bankRows: BankRow[] = bankIds.map((id) => {
      const b = data.bankTransactions[id];
      const link = linkByBank.get(id);
      const sug = suggestionByBank.get(id);
      let status: ReconcileBadgeVariant;
      if (link) {
        status =
          link.linkType === "primary" ? "linked_primary" : "linked_extra";
      } else if (sug) {
        status =
          sug.strategy === "exact_hash" ? "suggested_exact" : "suggested_fuzzy";
      } else {
        status = "bank_only";
      }
      return {
        id: b.id,
        date: b.date,
        amount: b.amount,
        currency: b.currency,
        payee: b.payee,
        status,
        linkedTransactionId: link?.transactionId ?? null,
        suggestedTransactionId: sug?.transactionId ?? null,
        seenCount: b.seenCount,
        suggestedCategoryId: b.suggestedCategoryId,
        accountId: b.accountId,
      };
    });

    // Tx rows: sorted by date desc, status + inline suggestion.
    const txIds = Object.keys(data.transactions).map((s) => parseInt(s, 10));
    txIds.sort((a, b) => {
      const da = data.transactions[a].date;
      const db = data.transactions[b].date;
      return db.localeCompare(da);
    });
    const txRows: TxRow[] = txIds.map((id) => {
      const t = data.transactions[id];
      const link = linkByTx.get(id);
      const sug = suggestionByTx.get(id);
      let status: ReconcileBadgeVariant;
      if (link) {
        status =
          link.linkType === "primary" ? "linked_primary" : "linked_extra";
      } else if (sug) {
        status =
          sug.strategy === "exact_hash" ? "suggested_exact" : "suggested_fuzzy";
      } else {
        status = "tx_only";
      }
      let suggestion: SuggestionDisplay | null = null;
      if (sug) {
        const bank = data.bankTransactions[sug.bankTransactionId];
        if (bank) {
          suggestion = {
            transactionId: sug.transactionId,
            bankTransactionId: sug.bankTransactionId,
            strategy: sug.strategy === "exact_hash" ? "exact_hash" : "fuzzy",
            score: sug.score,
            reason: sug.reason,
            daysOff: sug.daysOff,
            amountDeltaAbs: sug.amountDeltaAbs,
            txDate: t.date,
            txAmount: t.amount,
            txCurrency: t.currency,
            txPayee: t.payee,
            bankDate: bank.date,
            bankAmount: bank.amount,
            bankCurrency: bank.currency,
            bankPayee: bank.payee,
          };
        }
      }
      return {
        id: t.id,
        date: t.date,
        amount: t.amount,
        currency: t.currency,
        payee: t.payee,
        category: t.categoryName,
        status,
        linkedBankTransactionId: link?.bankTransactionId ?? null,
        suggestion,
      };
    });

    const counts = {
      linked: data.linked.length,
      suggested: liveSuggestions.length,
      bankOnly: bankRows.filter((r) => r.status === "bank_only").length,
      txOnly: txRows.filter((r) => r.status === "tx_only").length,
    };

    return { bankRows, txRows, counts };
  }, [data, rejected]);

  // ─── Mutations ─────────────────────────────────────────────────────
  const onAccept = useCallback(
    async (s: SuggestionDisplay) => {
      const key = `${s.transactionId}:${s.bankTransactionId}`;
      setBusySuggestionKey(key);
      try {
        const res = await fetch("/api/reconcile/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactionId: s.transactionId,
            bankTransactionId: s.bankTransactionId,
            linkType: "primary",
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusySuggestionKey(null);
      }
    },
    [refresh],
  );

  const onReject = useCallback((s: SuggestionDisplay) => {
    setRejected((prev) => {
      const next = new Set(prev);
      next.add(`${s.transactionId}:${s.bankTransactionId}`);
      return next;
    });
  }, []);

  const onUnlink = useCallback(
    async (bankId: string, transactionId: number) => {
      setBusyBankId(bankId);
      try {
        const res = await fetch("/api/reconcile/links", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactionId,
            bankTransactionId: bankId,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyBankId(null);
      }
    },
    [refresh],
  );

  // Per-row bank-transaction delete (2026-05-27).
  // Two-phase:
  //   1. POST with empty body → server may return 409 + requiresConfirmation
  //      if the row has linked transactions. Surface the modal.
  //   2. Modal "Delete all" → POST { deleteLinkedTransactions: true }
  //      Modal "Keep tx"   → POST { deleteLinkedTransactions: false }
  // Bank-only rows skip the modal entirely (server doesn't 409).
  const deleteBankRow = useCallback(
    async (bankId: string, deleteLinkedTransactions: boolean | null) => {
      setBusyBankId(bankId);
      try {
        const body: Record<string, unknown> = {};
        if (deleteLinkedTransactions != null) {
          body.deleteLinkedTransactions = deleteLinkedTransactions;
        }
        const res = await fetch(
          `/api/bank-transactions/${encodeURIComponent(bankId)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (res.status === 409) {
          const payload = await res.json();
          const snap = data?.bankTransactions[bankId];
          setDeleteConfirm({
            bankId,
            date: payload.bankDate ?? snap?.date ?? "",
            amount: payload.bankAmount ?? snap?.amount ?? 0,
            currency: payload.bankCurrency ?? snap?.currency ?? "CAD",
            payee: snap?.payee ?? null,
            linkedTransactionCount: payload.linkedTransactionCount ?? 0,
          });
          return;
        }
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        // Drop the row from selection state if it was checked.
        setSelectedBankIds((prev) => {
          if (!prev.has(bankId)) return prev;
          const next = new Set(prev);
          next.delete(bankId);
          return next;
        });
        setDeleteConfirm(null);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyBankId(null);
      }
    },
    [data, refresh],
  );

  const onBankDelete = useCallback(
    (bankId: string) => {
      // First call sends no body — server will 409 if linked, otherwise
      // deletes immediately.
      void deleteBankRow(bankId, null);
    },
    [deleteBankRow],
  );

  // Bulk-link selection handlers (2026-05-27).
  const onToggleBankSelect = useCallback((bankId: string) => {
    setSelectedBankIds((prev) => {
      const next = new Set(prev);
      if (next.has(bankId)) next.delete(bankId);
      else next.add(bankId);
      return next;
    });
  }, []);

  const onToggleTxSelect = useCallback((txId: number) => {
    setSelectedTxIds((prev) => {
      const next = new Set(prev);
      if (next.has(txId)) next.delete(txId);
      else next.add(txId);
      return next;
    });
  }, []);

  const onToggleAllBank = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setSelectedBankIds(new Set());
        return;
      }
      // Select every visible bank row id from the current data snapshot.
      setSelectedBankIds(
        new Set(Object.keys(data?.bankTransactions ?? {})),
      );
    },
    [data],
  );

  const onToggleAllTx = useCallback(
    (checked: boolean) => {
      if (!checked) {
        setSelectedTxIds(new Set());
        return;
      }
      setSelectedTxIds(
        new Set(
          Object.keys(data?.transactions ?? {}).map((s) => parseInt(s, 10)),
        ),
      );
    },
    [data],
  );

  const clearSelection = useCallback(() => {
    setSelectedTxIds(new Set());
    setSelectedBankIds(new Set());
  }, []);

  // Sum of selected amounts on each pane + delta — surfaced by the bulk
  // action bar so the user can sanity-check that the selection actually
  // reconciles before firing the cartesian product.
  const bulkSelectionSums = useMemo(() => {
    let txSum = 0;
    let bankSum = 0;
    let currency = "CAD";
    if (data) {
      for (const id of selectedTxIds) {
        const t = data.transactions[id];
        if (t) {
          txSum += t.amount;
          currency = t.currency || currency;
        }
      }
      for (const id of selectedBankIds) {
        const b = data.bankTransactions[id];
        if (b) {
          bankSum += b.amount;
          currency = b.currency || currency;
        }
      }
    }
    // Fall back to the selected account's currency when no rows are
    // selected yet (covers the half-selected state — one side empty).
    if (selectedAccountId != null) {
      const acct = accounts.find((a) => a.id === selectedAccountId);
      if (acct?.currency) currency = acct.currency;
    }
    return { txSum, bankSum, currency };
  }, [data, selectedTxIds, selectedBankIds, selectedAccountId, accounts]);

  const onBulkReconcile = useCallback(async () => {
    if (selectedTxIds.size === 0 || selectedBankIds.size === 0) return;
    setBulkLinking(true);
    try {
      const res = await fetch("/api/reconcile/links/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionIds: [...selectedTxIds],
          bankTransactionIds: [...selectedBankIds],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      clearSelection();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkLinking(false);
    }
  }, [selectedTxIds, selectedBankIds, clearSelection, refresh]);

  // Open the canonical TransactionDialog prefilled from the bank row.
  // Replaces the old MaterializeDialog (2026-05-25, plan/reuse-add-
  // transaction-dialog.md) so users get the full Add Transaction surface
  // (payee, splits, advanced) at materialize time, not just a category
  // picker. The dialog's onSaved POSTs /api/reconcile/links to wire the
  // transaction_bank_links join row + bump the FK; investment-account
  // bank rows route to /portfolio/new instead (the generic dialog can't
  // satisfy the investment-account constraint).
  const onMaterialize = useCallback(
    (bankId: string) => {
      if (!data) return;
      const snap = data.bankTransactions[bankId];
      if (!snap) return;
      const acct = accounts.find((a) => a.id === snap.accountId);
      if (acct?.isInvestment === true) {
        router.push(`/portfolio/new?fromBankTransactionId=${encodeURIComponent(snap.id)}`);
        return;
      }
      setDialogInitial({
        kind: "transaction-prefill",
        values: {
          accountId: String(snap.accountId),
          categoryId: snap.suggestedCategoryId != null ? String(snap.suggestedCategoryId) : "",
          date: snap.date,
          currency: snap.currency,
          amount: String(snap.amount),
          payee: snap.payee ?? "",
        },
      });
      setMaterializeBankId(snap.id);
      setDialogOpen(true);
    },
    [data, accounts, router],
  );

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="container mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reconcile</h1>
          <p className="text-sm text-muted-foreground">
            Pair bank-ledger rows with system-side transactions.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/import/pending"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Open pending imports
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/settings/reconciliation"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <SettingsIcon className="h-4 w-4" />
            Thresholds
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <label
            htmlFor="reconcile-account-selector"
            className="text-muted-foreground"
          >
            Account:
          </label>
          {accountsLoading ? (
            <span className="text-xs text-muted-foreground italic">
              Loading…
            </span>
          ) : visibleAccounts.length === 0 ? (
            <span className="text-xs text-muted-foreground italic">
              No accounts found. Create an account first.
            </span>
          ) : (
            <Select
              value={
                selectedAccountId != null ? String(selectedAccountId) : ""
              }
              onValueChange={(v) => {
                const n = parseInt(v ?? "", 10);
                if (Number.isFinite(n)) {
                  setSelectedAccountId(n);
                  setRejected(new Set());
                }
              }}
            >
              <SelectTrigger
                id="reconcile-account-selector"
                className="w-[280px]"
              >
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {visibleAccounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {safeAccountName(a)} · {a.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Date window: explicit from/to inputs + quick-fill chips. The
         *  chips set both inputs at once (e.g. "30d" → from=today-30d,
         *  to=today). Inputs may be edited independently for arbitrary
         *  ranges. Both empty = "all time". */}
        <div
          className="flex items-center gap-2 text-xs flex-wrap"
          role="group"
          aria-label="Date window"
        >
          <label className="text-muted-foreground" htmlFor="reconcile-date-from">
            From
          </label>
          <input
            id="reconcile-date-from"
            type="date"
            value={dateFrom ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setDateFrom(v ? v : null);
              setRejected(new Set());
            }}
            className="h-7 px-2 text-xs border border-input rounded-md bg-background"
          />
          <span className="text-muted-foreground">→</span>
          <label className="text-muted-foreground" htmlFor="reconcile-date-to">
            To
          </label>
          <input
            id="reconcile-date-to"
            type="date"
            value={dateTo ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setDateTo(v ? v : null);
              setRejected(new Set());
            }}
            className="h-7 px-2 text-xs border border-input rounded-md bg-background"
          />
          <div
            className="flex items-center gap-1 ml-2"
            role="group"
            aria-label="Quick presets"
          >
            {LOOKBACK_OPTIONS.map((opt) => {
              // A chip is "active" when the current inputs exactly match
              // the preset window. "All" matches when both inputs are null.
              let active = false;
              if (opt.value === null) {
                active = dateFrom === null && dateTo === null;
              } else if (dateTo === todayIso()) {
                active = dateFrom === shiftDaysFromToday(-opt.value);
              }
              return (
                <Button
                  key={opt.label}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => {
                    if (opt.value === null) {
                      setDateFrom(null);
                      setDateTo(null);
                    } else {
                      setDateFrom(shiftDaysFromToday(-opt.value));
                      setDateTo(todayIso());
                    }
                    setRejected(new Set());
                  }}
                  className="h-7 px-2 text-xs"
                >
                  {opt.label}
                </Button>
              );
            })}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {selectedAccountId != null && (
        <BalanceSummaryCard
          summary={balanceSummary}
          loading={balanceSummaryLoading && !balanceSummary}
        />
      )}

      {selectedAccountId != null && (
        // Pane order on /reconcile is transactions-left, bank-ledger-right
        // (intentionally inverted from /import/pending). /reconcile is
        // system-first — the user's books are the source of truth and the
        // bank-ledger pane is the audit trail to reconcile against. The
        // inner SuggestionCard already renders tx-left / bank-right, so
        // this outer order matches the card's column order.
        <TwoPaneLayout
          leftLabel="Transactions"
          left={
            <TransactionsPane
              rows={txRows}
              loading={dataLoading}
              onAccept={onAccept}
              onReject={onReject}
              onRowClick={onTxRowClick}
              highlightedTxIds={highlightedTxIds}
              busySuggestionKey={busySuggestionKey}
              selectedTxIds={selectedTxIds}
              onToggleSelect={onToggleTxSelect}
              onToggleSelectAll={onToggleAllTx}
            />
          }
          rightLabel="Bank ledger"
          right={
            <BankPane
              rows={bankRows}
              loading={dataLoading}
              onMaterialize={onMaterialize}
              onUnlink={onUnlink}
              onDelete={onBankDelete}
              onRowClick={onBankRowClick}
              highlightedBankIds={highlightedBankIds}
              busyBankId={busyBankId}
              selectedBankIds={selectedBankIds}
              onToggleSelect={onToggleBankSelect}
              onToggleSelectAll={onToggleAllBank}
            />
          }
        />
      )}

      {/* Phase 4 of import-modes refactor (2026-05-25) — Recent Uploads
          panel lists the last 20 bank_upload_batches for this account and
          provides a one-click batch-undo affordance for mistaken imports. */}
      {selectedAccountId != null && (
        <RecentUploadsPanel
          accountId={selectedAccountId}
          onChange={() => {
            void refresh();
          }}
        />
      )}

      <div className="flex items-center gap-4 text-xs text-muted-foreground border-t pt-3">
        <span>{counts.linked} linked</span>
        <span>·</span>
        <span>{counts.suggested} suggested</span>
        <span>·</span>
        <span>{counts.bankOnly} bank-only</span>
        <span>·</span>
        <span>{counts.txOnly} tx-only</span>
        {data && (
          <span className="ml-auto">
            threshold {data.thresholds.scoreThreshold.toFixed(2)} · ±
            {data.thresholds.dateToleranceDays}d ·{" "}
            {describeRange(data.dateMin, data.dateMax)}
          </span>
        )}
      </div>

      {/* Confirmation modal for per-row bank-transaction delete (2026-05-27). */}
      {deleteConfirm && (
        <ConfirmDeleteBankRow
          open
          linkedTransactionCount={deleteConfirm.linkedTransactionCount}
          bankDate={deleteConfirm.date}
          bankAmount={deleteConfirm.amount}
          bankCurrency={deleteConfirm.currency}
          bankPayee={deleteConfirm.payee}
          busy={busyBankId === deleteConfirm.bankId}
          onConfirm={(deleteLinked) => {
            void deleteBankRow(deleteConfirm.bankId, deleteLinked);
          }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* Sticky action bar for bulk M:N reconcile (2026-05-27). */}
      <BulkLinkActionBar
        txCount={selectedTxIds.size}
        bankCount={selectedBankIds.size}
        txSum={bulkSelectionSums.txSum}
        bankSum={bulkSelectionSums.bankSum}
        currency={bulkSelectionSums.currency}
        busy={bulkLinking}
        onReconcile={() => void onBulkReconcile()}
        onClear={clearSelection}
      />

      <TransactionDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) {
            setDialogInitial(null);
            setMaterializeBankId(null);
          }
        }}
        accounts={accounts.map((a) => ({
          id: a.id,
          name: safeAccountName(a),
          currency: a.currency,
          isInvestment: a.isInvestment,
        }))}
        categories={categories}
        holdings={holdings}
        initialState={dialogInitial}
        onSaved={async (txId) => {
          // If the dialog was opened from a bank-only Create button, wire
          // the join row + FK so the new transaction shows as linked on
          // the next refresh. linkType='primary' bumps the FK; the helper
          // also sets transactions.bank_transaction_id when it was NULL.
          if (materializeBankId) {
            try {
              await fetch("/api/reconcile/links", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  transactionId: txId,
                  bankTransactionId: materializeBankId,
                  linkType: "primary",
                }),
              });
            } catch (e) {
              // Surface to the page-level banner but don't block — the
              // transaction landed; the user can manually accept the
              // suggestion on the next refresh.
              setError(e instanceof Error ? e.message : String(e));
            }
            setMaterializeBankId(null);
          }
          await refresh();
        }}
      />
    </div>
  );
}
