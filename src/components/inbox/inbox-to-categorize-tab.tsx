"use client";

/**
 * InboxToCategorizeTab — Auto-pilot lens body for /inbox (Phase 4, 2026-05-27).
 *
 * Lists every `bank_transactions` row for the selected account that does
 * NOT yet have a `transaction_bank_links` row. These are the bank rows
 * that the upload-time rule firing did NOT match — the Auto-pilot
 * pipeline already materialized the matched rows to `transactions` with
 * `source='auto_rule'` (see `applyRulesToBankRows` in
 * `src/lib/reconcile/match-engine.ts`).
 *
 * The primary action on each card is "Categorize" (not "Approve" like the
 * Approve-each lens) — the user picks a category and the row materializes
 * with `source='manual'` so the audit trail distinguishes the auto-rule
 * fire from the user's hand-categorize.
 *
 * Reuses the RowCard from Approve-each. The only behavioral difference is
 * the API endpoint: POST /api/bank-transactions/[bankId]/categorize
 * instead of /approve.
 *
 * NOTE: when no rule matches we have no suggestion to surface (the bank
 * row's `suggestedCategoryId` is non-null only when at least one rule
 * matches; rule-matched rows are auto-materialized at upload and don't
 * reach this tab). So the "Approve with suggestion" path collapses; every
 * row here opens the categorize dialog.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Inbox } from "lucide-react";
import {
  RowCard,
  type RowCardSuggestionAny,
  type RowCardDuplicate,
} from "./row-card";
import { ConfirmDeleteBankRow } from "@/components/reconcile/confirm-delete-bank-row";
import {
  InvestmentOpPreviewDialog,
  type InvestmentOpPreview,
} from "@/components/reconcile/investment-op-preview-dialog";
import {
  TransactionDialog,
  type TransactionDialogInitialState,
  type DialogCategory,
  type DialogHolding,
} from "@/components/transactions/transaction-dialog";
import { safeAccountName } from "@/lib/safe-name";

interface Account {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  archived?: boolean;
  isInvestment?: boolean;
}

interface ReconcileLink {
  transactionId: number;
  bankTransactionId: string;
  linkType: "primary" | "extra";
  source: string;
  createdAt: string;
}

interface TxSnapshot {
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
}

interface BankSnapshot {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  accountId: number;
  suggestedCategoryId: number | null;
  /** Strict possible-duplicate: id of an existing unlinked ledger tx this
   *  bank row matches (exact hash / exact amount + close date). null = none. */
  duplicateOfTransactionId: number | null;
  // FINLYNQ-208 — investment-import capture + matched investment-op suggestion.
  ticker?: string | null;
  securityName?: string | null;
  quantity?: number | null;
  suggestedInvestmentOp?: string | null;
}

interface SnapshotShape {
  linked: ReconcileLink[];
  transactions: Record<number, TxSnapshot>;
  bankTransactions: Record<string, BankSnapshot>;
}

export function InboxToCategorizeTab({
  accountId,
  accounts,
}: {
  accountId: number;
  accounts: Account[];
}) {
  const [snapshot, setSnapshot] = useState<SnapshotShape | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyBankId, setBusyBankId] = useState<string | null>(null);
  const [categories, setCategories] = useState<DialogCategory[]>([]);
  const [holdings, setHoldings] = useState<DialogHolding[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] =
    useState<TransactionDialogInitialState | null>(null);
  const [materializeBankId, setMaterializeBankId] = useState<string | null>(
    null,
  );
  // FINLYNQ-208 — investment-op preview-before-record (Auto-pilot lens).
  const [opPreview, setOpPreview] = useState<
    { bankId: string; preview: InvestmentOpPreview } | null
  >(null);
  const [recordingOp, setRecordingOp] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    bankId: string;
    date: string;
    amount: number;
    currency: string;
    payee: string | null;
    linkedTransactionCount: number;
  } | null>(null);

  // Load categories + holdings once for the Categorize dialog.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled) return;
        if (Array.isArray(rows)) {
          setCategories(
            rows.map(
              (r: {
                id: number;
                name: string | null;
                type: string;
                group?: string | null;
              }) => ({
                id: r.id,
                name: r.name?.trim() ? r.name : `Category #${r.id}`,
                type: r.type,
                group: r.group ?? "",
              }),
            ),
          );
        }
      })
      .catch(() => {
        /* non-fatal */
      });
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
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/reconcile/suggestions?accountId=${accountId}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (!body.success) throw new Error(body.error ?? "Unknown error");
      setSnapshot(body.data as SnapshotShape);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Possible ledger duplicates — bank rows the match engine paired with an
   *  existing unlinked ledger tx. In Auto-pilot these are the rows that were
   *  NOT auto-materialized (skipReason='possible_ledger_duplicate') so they
   *  don't become silent duplicates; the card offers link-vs-keep-separate. */
  const duplicateByBank = useMemo(() => {
    const map = new Map<string, RowCardDuplicate>();
    if (!snapshot) return map;
    for (const b of Object.values(snapshot.bankTransactions)) {
      if (b.duplicateOfTransactionId == null) continue;
      const tx = snapshot.transactions[b.duplicateOfTransactionId];
      if (!tx) continue;
      map.set(b.id, {
        transactionId: tx.id,
        txPayee: tx.payee,
        txDate: tx.date,
        txAmount: tx.amount,
        txCurrency: tx.currency,
      });
    }
    return map;
  }, [snapshot]);

  /** Link a possible duplicate to its matched existing transaction. */
  const linkExisting = useCallback(
    async (bankId: string, transactionId: number) => {
      setBusyBankId(bankId);
      setError(null);
      try {
        const res = await fetch("/api/reconcile/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactionId, bankTransactionId: bankId }),
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

  const unlinkedRows = useMemo(() => {
    if (!snapshot) return [] as BankSnapshot[];
    const linkedBankIds = new Set(
      snapshot.linked.map((l) => l.bankTransactionId),
    );
    return Object.values(snapshot.bankTransactions)
      .filter((b) => !linkedBankIds.has(b.id))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [snapshot]);

  // Per-bank-row suggestion. In the Auto-pilot lens, a non-null
  // suggestedCategoryId on an unlinked row means a rule matched but the
  // helper couldn't materialize (sign-vs-category mismatch, missing
  // category, etc.). Surface as a 'create' suggestion so the user can
  // see what rule WOULD have categorized this row as.
  const suggestionByBank = useMemo(() => {
    const map = new Map<string, RowCardSuggestionAny>();
    if (!snapshot) return map;
    const catName = (id: number) => {
      const c = categories.find((x) => x.id === id);
      return c?.name ?? `Category #${id}`;
    };
    for (const b of Object.values(snapshot.bankTransactions)) {
      if (b.suggestedCategoryId != null) {
        map.set(b.id, {
          kind: "create",
          categoryId: b.suggestedCategoryId,
          categoryName: catName(b.suggestedCategoryId),
        });
      }
    }
    return map;
  }, [snapshot, categories]);

  const categorizeOne = useCallback(
    async (bankId: string, categoryId: number) => {
      const res = await fetch(
        `/api/bank-transactions/${encodeURIComponent(bankId)}/categorize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ categoryId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    [],
  );

  // Declared before onPrimary so it can reference onEdit without a temporal
  // dead-zone access (react-hooks/immutability, FINLYNQ-119).
  const onEdit = useCallback(
    (bankId: string) => {
      if (!snapshot) return;
      const snap = snapshot.bankTransactions[bankId];
      if (!snap) return;
      const acct = accounts.find((a) => a.id === snap.accountId);
      if (acct?.isInvestment === true) {
        // FINLYNQ-208 — a matched record_investment_op rule records a lot-aware
        // op. Open a preview-before-record (mirrors normal reconciliation); on
        // confirm the executor runs via /api/reconcile/apply-rules. No matching
        // rule → there's nothing to auto-create, so point at the manual flow.
        if (snap.suggestedInvestmentOp) {
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
        setError(
          "Investment accounts: record buys/sells from the Manual lens (Reconcile) or the portfolio operations flow.",
        );
        return;
      }
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
      });
      setMaterializeBankId(snap.id);
      setDialogOpen(true);
    },
    [snapshot, accounts],
  );

  // FINLYNQ-208 — confirm + record the previewed investment op via the
  // single-row apply-rules route, then refresh.
  const confirmRecordOp = useCallback(async () => {
    if (!opPreview) return;
    setRecordingOp(true);
    setError(null);
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

  const onPrimary = useCallback(
    async (bankId: string) => {
      const sug = suggestionByBank.get(bankId);
      // If we have a suggested category (a rule matched but did not
      // materialize), accept it in one click.
      if (sug?.kind === "create") {
        setBusyBankId(bankId);
        setError(null);
        try {
          await categorizeOne(bankId, sug.categoryId);
          await refresh();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusyBankId(null);
        }
        return;
      }
      // No suggestion → open the dialog so user picks a category.
      onEdit(bankId);
    },
    [categorizeOne, refresh, suggestionByBank, onEdit],
  );

  const deleteBankRow = useCallback(
    async (bankId: string, deleteLinkedTransactions: boolean | null) => {
      setBusyBankId(bankId);
      setError(null);
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
          const snap = snapshot?.bankTransactions[bankId];
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
        setDeleteConfirm(null);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyBankId(null);
      }
    },
    [snapshot, refresh],
  );

  const onDelete = useCallback(
    (bankId: string) => {
      void deleteBankRow(bankId, null);
    },
    [deleteBankRow],
  );

  if (loading && snapshot == null) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          Loading…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 whitespace-pre-line">
          {error}
        </div>
      )}

      {unlinkedRows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {unlinkedRows.length} row
          {unlinkedRows.length === 1 ? "" : "s"} need
          {unlinkedRows.length === 1 ? "s" : ""} categorizing — no rule matched
          these at upload.
        </p>
      )}

      {unlinkedRows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm font-medium">
                Auto-pilot is handling everything
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Nothing manual to do — either every row was auto-categorized
                by a rule, or nothing new has come in. Upload a statement to
                this account to see rows here when no rule matches.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {unlinkedRows.map((b) => (
            <RowCard
              key={b.id}
              bank={{
                id: b.id,
                date: b.date,
                amount: b.amount,
                currency: b.currency,
                payee: b.payee,
              }}
              suggestion={suggestionByBank.get(b.id) ?? null}
              busy={busyBankId === b.id}
              onApprove={() => void onPrimary(b.id)}
              onEdit={() => onEdit(b.id)}
              onDelete={() => onDelete(b.id)}
              duplicate={duplicateByBank.get(b.id) ?? null}
              onLinkExisting={() => {
                const dup = duplicateByBank.get(b.id);
                if (dup) void linkExisting(b.id, dup.transactionId);
              }}
            />
          ))}
        </div>
      )}

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
          // After a save through the dialog, primary-link the new tx to
          // the bank row so it leaves "To categorize" and shows up under
          // "Reconciled".
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
