"use client";

/**
 * InboxReconcileTab — Manual-lens Reconcile tab body for /inbox.
 *
 * Embeds the same BankPane / TransactionsPane / SuggestionCard /
 * BulkLinkActionBar / ConfirmDeleteBankRow / RecentUploadsPanel /
 * TransactionDialog components shipped under /reconcile (Phase 2 of the
 * import-modes refactor + 2026-05-27 per-row delete + N×M bulk-link
 * cohort). The orchestration mirrors `src/app/(app)/reconcile/page.tsx`
 * but is account-pre-scoped via the `accountId` prop (no internal account
 * picker; the parent page owns it). Date window still configurable here
 * via the chip group — reconciling a year-old upload is a real use case.
 *
 * /reconcile and this tab share every API route + every pane component:
 *   GET /api/reconcile/suggestions
 *   GET /api/reconcile/balance-summary
 *   POST /api/reconcile/links        (accept)
 *   DELETE /api/reconcile/links      (unlink)
 *   POST /api/reconcile/links/bulk   (N×M bulk-link)
 *   DELETE /api/bank-transactions/[bankId]  (per-row delete + 409 modal)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { TwoPaneLayout } from "@/components/import/reconcile/two-pane-layout";
import { BankPane, type BankRow } from "@/components/reconcile/bank-pane";
import {
  InvestmentOpPreviewDialog,
  type InvestmentOpPreview,
} from "@/components/reconcile/investment-op-preview-dialog";
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
  name: string | null;
  alias?: string | null;
  currency: string;
  archived?: boolean;
  isInvestment?: boolean;
}

const LOOKBACK_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "30d", value: 30 },
  { label: "60d", value: 60 },
  { label: "90d", value: 90 },
  { label: "6mo", value: 180 },
  { label: "All", value: null },
];
const DEFAULT_LOOKBACK_DAYS = 60;

function shiftDaysFromToday(deltaDays: number): string {
  const ms = Date.now() + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
  suggestedCategoryId: number | null;
  suggestedTransferAccountId: number | null;
  // FINLYNQ-207 — investment-import capture, present only on investment-account
  // rows (absent on cash snapshots).
  ticker?: string | null;
  securityName?: string | null;
  quantity?: number | null;
  // FINLYNQ-208 — the op a matching `record_investment_op` rule would record
  // (buy/sell/dividend/…). Drives the investment-row "Create" → apply-rule path.
  suggestedInvestmentOp?: string | null;
}

export interface ReconcileData {
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
  lookbackDays: number | null;
  dateMin: string | null;
  dateMax: string | null;
}

export function InboxReconcileTab({
  accountId,
  accounts,
  onReconcileDataChange,
}: {
  accountId: number;
  accounts: Account[];
  /** Lifted-up snapshot for the sibling Reconciled tab so we don't
   *  refetch the same endpoint twice. The parent caches the data and
   *  the Reconciled tab filters it client-side. */
  onReconcileDataChange?: (data: ReconcileData | null) => void;
}) {
  const [data, setData] = useState<ReconcileData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // FINLYNQ-208 — transient success/info notice for the per-row record action.
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);
  // FINLYNQ-208 — investment-op preview-before-record (mirrors normal
  // reconciliation: Create shows a preview; recording waits for confirm).
  const [opPreview, setOpPreview] = useState<
    { bankId: string; preview: InvestmentOpPreview } | null
  >(null);
  const [recordingOp, setRecordingOp] = useState(false);
  const [busySuggestionKey, setBusySuggestionKey] = useState<string | null>(
    null,
  );
  const [busyBankId, setBusyBankId] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [dateFrom, setDateFrom] = useState<string | null>(
    shiftDaysFromToday(-DEFAULT_LOOKBACK_DAYS),
  );
  const [dateTo, setDateTo] = useState<string | null>(null);
  const [categories, setCategories] = useState<DialogCategory[]>([]);
  const [holdings, setHoldings] = useState<DialogHolding[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] =
    useState<TransactionDialogInitialState | null>(null);
  const [materializeBankId, setMaterializeBankId] = useState<string | null>(
    null,
  );
  const router = useRouter();

  // FINLYNQ-207 — whether the currently-reconciled account is an investment
  // account. Drives the gated Ticker / Security / Qty columns in the BankPane.
  const isInvestmentAccount = useMemo(
    () => accounts.find((a) => a.id === accountId)?.isInvestment === true,
    [accounts, accountId],
  );

  const [highlightedTxIds, setHighlightedTxIds] = useState<
    ReadonlySet<number>
  >(() => new Set());
  const [highlightedBankIds, setHighlightedBankIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [highlightAnchor, setHighlightAnchor] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    bankId: string;
    date: string;
    amount: number;
    currency: string;
    payee: string | null;
    linkedTransactionCount: number;
  } | null>(null);

  const [selectedTxIds, setSelectedTxIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [selectedBankIds, setSelectedBankIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [bulkLinking, setBulkLinking] = useState(false);

  const [balanceSummary, setBalanceSummary] = useState<BalanceSummary | null>(
    null,
  );
  const [balanceSummaryLoading, setBalanceSummaryLoading] = useState(false);

  // Reset all session state when the parent flips accounts under us.
  useEffect(() => {
    setRejected(new Set());
    setSelectedTxIds(new Set());
    setSelectedBankIds(new Set());
    setHighlightAnchor(null);
    setHighlightedTxIds(new Set());
    setHighlightedBankIds(new Set());
  }, [accountId]);

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

  const computeNeighborhoodFromBank = useCallback(
    (bankId: string) => {
      const txIds = new Set<number>();
      const bankIds = new Set<string>([bankId]);
      if (!data) return { txIds, bankIds };
      for (const link of data.linked) {
        if (link.bankTransactionId === bankId) txIds.add(link.transactionId);
      }
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/categories");
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{
          id: number;
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
        /* non-fatal */
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
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setDataLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ accountId: String(accountId) });
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
      const next = body.data as ReconcileData;
      setData(next);
      onReconcileDataChange?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
      onReconcileDataChange?.(null);
    } finally {
      setDataLoading(false);
    }
  }, [accountId, dateFrom, dateTo, onReconcileDataChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setBalanceSummaryLoading(true);
    fetch(`/api/reconcile/balance-summary?accountId=${accountId}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body?.success) setBalanceSummary(body.data as BalanceSummary);
        else setBalanceSummary(null);
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
  }, [accountId, data]);

  const { bankRows, txRows, counts } = useMemo(() => {
    if (!data)
      return {
        bankRows: [] as BankRow[],
        txRows: [] as TxRow[],
        counts: { linked: 0, suggested: 0, bankOnly: 0, txOnly: 0 },
      };

    const linkByTx = new Map<number, ReconcileLink>();
    const linkByBank = new Map<string, ReconcileLink>();
    for (const l of data.linked) {
      linkByTx.set(l.transactionId, l);
      linkByBank.set(l.bankTransactionId, l);
    }
    const liveSuggestions = data.suggestions.filter(
      (s) => !rejected.has(`${s.transactionId}:${s.bankTransactionId}`),
    );
    const suggestionByTx = new Map<number, ReconcileSuggestion>();
    const suggestionByBank = new Map<string, ReconcileSuggestion>();
    for (const s of liveSuggestions) {
      if (!suggestionByTx.has(s.transactionId)) {
        suggestionByTx.set(s.transactionId, s);
      }
      if (!suggestionByBank.has(s.bankTransactionId)) {
        suggestionByBank.set(s.bankTransactionId, s);
      }
    }

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
        // FINLYNQ-207 — undefined on cash rows (the BankPane only renders
        // these when isInvestment is true).
        ticker: b.ticker ?? null,
        securityName: b.securityName ?? null,
        quantity: b.quantity ?? null,
        // FINLYNQ-208 — the op a matching investment rule would record; shown
        // as a per-row suggestion chip, applied via the row's Create action.
        suggestedInvestmentOp: b.suggestedInvestmentOp ?? null,
      };
    });

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
      void deleteBankRow(bankId, null);
    },
    [deleteBankRow],
  );

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
      setSelectedBankIds(new Set(Object.keys(data?.bankTransactions ?? {})));
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
    const acct = accounts.find((a) => a.id === accountId);
    if (acct?.currency) currency = acct.currency;
    return { txSum, bankSum, currency };
  }, [data, selectedTxIds, selectedBankIds, accounts, accountId]);

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

  const onMaterialize = useCallback(
    async (bankId: string) => {
      if (!data) return;
      const snap = data.bankTransactions[bankId];
      if (!snap) return;
      const acct = accounts.find((a) => a.id === snap.accountId);
      if (acct?.isInvestment === true) {
        // FINLYNQ-208 — if a user rule matches this row with a
        // `record_investment_op` action, open a PREVIEW of the op before
        // recording (mirrors normal bank reconciliation — never auto-records on
        // Create). Confirm runs the executor via /api/reconcile/apply-rules.
        // No matching rule → fall back to the manual portfolio flow.
        if (snap.suggestedInvestmentOp) {
          setRuleNotice(null);
          setError(null);
          setOpPreview({
            bankId: snap.id,
            preview: {
              op: snap.suggestedInvestmentOp,
              ticker: snap.ticker ?? null,
              securityName: snap.securityName ?? null,
              quantity: snap.quantity ?? null,
              amount: snap.amount,
              currency: snap.currency,
              accountName: safeAccountName(acct),
            },
          });
          return;
        }
        router.push(
          `/portfolio/new?fromBankTransactionId=${encodeURIComponent(snap.id)}`,
        );
        return;
      }
      // Issue A + B (2026-06-04): always seed the Transfer tab too (so
      // switching tabs keeps the bank row's date/amount/source account), and
      // — when a rule's `create_transfer` action names a destination — open
      // the dialog directly in Transfer mode with the destination pre-filled.
      // Investment destinations need a holding/qty a rule can't supply, so we
      // fall back to Transaction mode (the Transfer tab is still seeded).
      const transferDestId = snap.suggestedTransferAccountId;
      const destAcct =
        transferDestId != null
          ? accounts.find((a) => a.id === transferDestId)
          : undefined;
      // Only auto-route to Transfer mode for an OUTFLOW row (amount < 0): the
      // transfer's "From" leg lands on this bank account and `onSaved` links
      // the bank row to that debit leg — correct only when money is leaving
      // here (the "e-Tfr to …" case). Inflow rows would need the credit leg,
      // which onSaved doesn't expose, so we leave them in Transaction mode
      // (the Transfer tab is still seeded for manual use). Investment dests
      // need a holding/qty a rule can't supply, so they fall back too.
      const autoTransfer =
        !!destAcct &&
        destAcct.isInvestment !== true &&
        destAcct.id !== snap.accountId &&
        snap.amount < 0;
      setDialogInitial({
        kind: "transaction-prefill",
        values: {
          accountId: String(snap.accountId),
          categoryId:
            snap.suggestedCategoryId != null
              ? String(snap.suggestedCategoryId)
              : "",
          date: snap.date,
          currency: snap.currency,
          amount: String(snap.amount),
          payee: snap.payee ?? "",
        },
        transferSeed: {
          fromAccountId: String(snap.accountId),
          toAccountId: autoTransfer ? String(destAcct.id) : undefined,
          date: snap.date,
          amount: String(Math.abs(snap.amount)),
          note: snap.payee ?? "",
        },
      });
      setMaterializeBankId(snap.id);
      setDialogOpen(true);
    },
    [data, accounts, router, refresh],
  );

  // FINLYNQ-208 — confirm + record the previewed investment op. Runs the
  // executor via the single-row apply-rules route, then refreshes.
  const confirmRecordOp = useCallback(async () => {
    if (!opPreview) return;
    setRecordingOp(true);
    setError(null);
    setRuleNotice(null);
    try {
      const res = await fetch("/api/reconcile/apply-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankRowIds: [opPreview.bankId] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) {
        setError(body.error ?? `Failed to record op (HTTP ${res.status})`);
        return;
      }
      const per = body.data?.perRow?.[0];
      if (per?.matched && per.transactionId) {
        setRuleNotice(`Recorded ${opPreview.preview.op} from rule.`);
        setOpPreview(null);
        await refresh();
      } else {
        setError(
          `Rule matched but did not record a transaction${
            per?.skipReason ? ` (${per.skipReason})` : ""
          }.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecordingOp(false);
    }
  }, [opPreview, refresh]);


  return (
    <div className="space-y-4">
      <div
        className="flex items-center gap-2 text-xs flex-wrap"
        role="group"
        aria-label="Date window"
      >
        <label className="text-muted-foreground" htmlFor="inbox-date-from">
          From
        </label>
        <input
          id="inbox-date-from"
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
        <label className="text-muted-foreground" htmlFor="inbox-date-to">
          To
        </label>
        <input
          id="inbox-date-to"
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

      {ruleNotice && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {ruleNotice}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <BalanceSummaryCard
        summary={balanceSummary}
        loading={balanceSummaryLoading && !balanceSummary}
      />

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
            isInvestment={isInvestmentAccount}
          />
        }
      />

      <RecentUploadsPanel
        accountId={accountId}
        onChange={() => {
          void refresh();
        }}
      />

      <div className="flex items-center gap-4 text-xs text-muted-foreground border-t pt-3">
        <span>{counts.linked} linked</span>
        <span>·</span>
        <span>{counts.suggested} suggested</span>
        <span>·</span>
        <span>{counts.bankOnly} bank-only</span>
        <span>·</span>
        <span>{counts.txOnly} tx-only</span>
      </div>

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

      <InvestmentOpPreviewDialog
        open={!!opPreview}
        onOpenChange={(o) => {
          if (!o) setOpPreview(null);
        }}
        preview={opPreview?.preview ?? null}
        onConfirm={() => void confirmRecordOp()}
        busy={recordingOp}
      />

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
        offerRuleSuggestion
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
