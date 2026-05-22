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
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings as SettingsIcon } from "lucide-react";
import { TwoPaneLayout } from "@/components/import/reconcile/two-pane-layout";
import { BankPane, type BankRow } from "@/components/reconcile/bank-pane";
import {
  TransactionsPane,
  type TxRow,
} from "@/components/reconcile/transactions-pane";
import type { SuggestionDisplay } from "@/components/reconcile/suggestion-card";
import type { ReconcileBadgeVariant } from "@/components/reconcile/match-pill";
import {
  MaterializeDialog,
  type MaterializeBankPreview,
  type CategoryOption,
} from "@/components/reconcile/materialize-dialog";

interface Account {
  id: number;
  /** Decrypted formal name (post `decryptNamedRows`). */
  name: string;
  /** Decrypted alias — friendly display name. Preferred over `name`
   *  when set, matching the convention on other pages. */
  alias?: string | null;
  currency: string;
  archived?: boolean;
}

/** Date-window preset for the lookback chip group. `null` = all time. */
const LOOKBACK_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "30d", value: 30 },
  { label: "60d", value: 60 },
  { label: "90d", value: 90 },
  { label: "6mo", value: 180 },
  { label: "All", value: null },
];
const DEFAULT_LOOKBACK_DAYS = 60;

function parseLookbackFromUrl(): number | null {
  if (typeof window === "undefined") return DEFAULT_LOOKBACK_DAYS;
  const raw = new URLSearchParams(window.location.search).get("range");
  if (raw === "all") return null;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && LOOKBACK_OPTIONS.some((o) => o.value === n)) {
    return n;
  }
  return DEFAULT_LOOKBACK_DAYS;
}

/** Friendly display name for an account — alias when set, formal name otherwise. */
function accountDisplayName(a: Account): string {
  const alias = a.alias?.trim();
  if (alias) return alias;
  return a.name;
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
  /** Echoed back by the server so the UI can confirm what window it used. */
  lookbackDays: number | null;
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
  /** Date-window lookback. null = all time. Defaults to 60d on first visit. */
  const [lookbackDays, setLookbackDays] = useState<number | null>(
    parseLookbackFromUrl(),
  );
  /** Loaded once on mount. The materialize dialog renders these in its
   *  category picker; the bank-pool rule engine already used the same
   *  ids server-side to compute `suggestedCategoryId` per bank row. */
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  /** Active materialize target — bank-only row whose Create button was
   *  clicked. null when the dialog is closed. */
  const [materializeBank, setMaterializeBank] =
    useState<MaterializeBankPreview | null>(null);

  // ─── Load accounts ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/accounts");
        if (!res.ok) throw new Error(`accounts: ${res.status}`);
        const rows: Account[] = await res.json();
        if (cancelled) return;
        // Filter out archived accounts — they don't get new statements so
        // reconcile is rarely useful. Power users can revisit later.
        const visible = rows.filter((a) => !a.archived);
        setAccounts(visible);

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

  // ─── Persist account selection + lookback in URL ───────────────────
  useEffect(() => {
    if (selectedAccountId == null) return;
    const url = new URL(window.location.href);
    url.searchParams.set("account", String(selectedAccountId));
    url.searchParams.set(
      "range",
      lookbackDays == null ? "all" : String(lookbackDays),
    );
    window.history.replaceState({}, "", url.toString());
  }, [selectedAccountId, lookbackDays]);

  // ─── Load categories (once) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/categories");
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{
          id: number;
          name: string;
          type: string;
        }>;
        if (cancelled) return;
        setCategories(
          rows.map((r) => ({ id: r.id, name: r.name, type: r.type })),
        );
      } catch {
        // Non-fatal — the dialog will just show an empty category list.
      }
    })();
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
      if (lookbackDays != null) qs.set("lookbackDays", String(lookbackDays));
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
  }, [selectedAccountId, lookbackDays]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  // Open the MaterializeDialog with a per-row preview. The dialog owns
  // the POST so the user picks category/account before the transaction
  // is minted — fixes the V1 issue where Create produced uncategorized
  // transactions silently.
  const onMaterialize = useCallback(
    (bankId: string) => {
      if (!data) return;
      const snap = data.bankTransactions[bankId];
      if (!snap) return;
      setMaterializeBank({
        bankTransactionId: snap.id,
        date: snap.date,
        amount: snap.amount,
        currency: snap.currency,
        payee: snap.payee,
        accountId: snap.accountId,
        suggestedCategoryId: snap.suggestedCategoryId,
      });
    },
    [data],
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
        <Link
          href="/settings/reconciliation"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <SettingsIcon className="h-4 w-4" />
          Thresholds
        </Link>
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
          ) : accounts.length === 0 ? (
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
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {accountDisplayName(a)} · {a.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Date-window preset chips. Default 60d; "All" passes null. */}
        <div
          className="flex items-center gap-1 text-xs"
          role="group"
          aria-label="Date window"
        >
          <span className="text-muted-foreground mr-1">Last</span>
          {LOOKBACK_OPTIONS.map((opt) => {
            const active = lookbackDays === opt.value;
            return (
              <Button
                key={opt.label}
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => {
                  setLookbackDays(opt.value);
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

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {selectedAccountId != null && (
        <TwoPaneLayout
          leftLabel="Bank ledger"
          left={
            <BankPane
              rows={bankRows}
              loading={dataLoading}
              onMaterialize={onMaterialize}
              onUnlink={onUnlink}
              busyBankId={busyBankId}
            />
          }
          rightLabel="Transactions"
          right={
            <TransactionsPane
              rows={txRows}
              loading={dataLoading}
              onAccept={onAccept}
              onReject={onReject}
              busySuggestionKey={busySuggestionKey}
            />
          }
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
            {data.lookbackDays != null
              ? `last ${data.lookbackDays}d`
              : "all time"}
          </span>
        )}
      </div>

      <MaterializeDialog
        open={materializeBank != null}
        onOpenChange={(o) => {
          if (!o) setMaterializeBank(null);
        }}
        bank={materializeBank}
        categories={categories}
        accounts={accounts.map((a) => ({
          id: a.id,
          name: accountDisplayName(a),
          currency: a.currency,
        }))}
        onCreated={() => {
          void refresh();
        }}
      />
    </div>
  );
}
