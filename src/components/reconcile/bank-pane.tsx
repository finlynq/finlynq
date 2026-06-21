"use client";

/**
 * BankPane — left pane of the standalone /reconcile UI.
 *
 * Fork of `pf-app/src/components/import/reconcile/db-pane.tsx` (2026-05-23).
 * The two surfaces are diverging — the reconcile page needs:
 *   - per-row "Create transaction" action for bank-only rows,
 *   - per-row "Unlink" action for linked rows,
 *   - reconcile-specific status pills (linked_primary / suggested_* / bank_only)
 *     that don't make sense on /import/pending.
 *
 * Keeping a fork (~150 LOC) is cleaner than piling reconcile props onto the
 * import variant. The `DbTransactionRow` shape from db-pane is re-exported
 * here as `BankRow` with the reconcile-relevant additions (linkType,
 * suggestedStrategy) so downstream consumers stay typed.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Plus, Unlink, Trash2 } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { MatchPill, type ReconcileBadgeVariant } from "./match-pill";

export interface BankRow {
  /** `bank_transactions.id` — UUID. Stable React key. */
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  /** Match status — drives the visible pill. */
  status: ReconcileBadgeVariant;
  /** When linked, the system-side transaction id. */
  linkedTransactionId: number | null;
  /** When suggested, the candidate transaction id. */
  suggestedTransactionId: number | null;
  /** How many statements have included this row. */
  seenCount: number;
  /** Pre-resolved category id from the rule engine; piped through to
   *  the materialize TransactionDialog as the default category pick.
   *  null when no rule matched the bank row's payee. */
  suggestedCategoryId: number | null;
  /** Bank row's account id — used by the dialog as the default account. */
  accountId: number;
  /** Investment-import capture (FINLYNQ-195 store / FINLYNQ-207 surface).
   *  Plaintext ticker/symbol; null when undecryptable or not captured.
   *  Only rendered when the pane is in investment mode. */
  ticker?: string | null;
  /** Plaintext security name; same rule as `ticker`. */
  securityName?: string | null;
  /** Share/unit count; rendered as a plain number (no currency symbol). */
  quantity?: number | null;
  /** FINLYNQ-208 — the op a matching investment rule would record
   *  (buy/sell/dividend/…). Shown as a per-row suggestion chip; the row's
   *  Create action applies it. null when no investment rule matches. */
  suggestedInvestmentOp?: string | null;
}

/**
 * Format an investment quantity as a share/unit COUNT — never currency
 * (FINLYNQ-207 tc-4). Trims trailing zeros so `10` shows as "10" and `10.5`
 * as "10.5"; caps at 6 dp for fractional-share brokers. `null`/undefined →
 * the em-dash placeholder.
 */
function formatQuantity(q: number | null | undefined): string {
  if (q == null || !Number.isFinite(q)) return "—";
  return String(Number(q.toFixed(6)));
}

export function BankPane({
  rows,
  loading,
  onMaterialize,
  onUnlink,
  onDelete,
  onRowClick,
  highlightedBankIds,
  busyBankId,
  selectedBankIds,
  onToggleSelect,
  onToggleSelectAll,
  isInvestment = false,
}: {
  rows: BankRow[];
  loading: boolean;
  onMaterialize: (bankId: string) => void;
  onUnlink: (bankId: string, transactionId: number) => void;
  /** Delete the bank-ledger row. Page-level handler decides whether to
   *  show the confirmation modal first (linked rows) or fire immediately
   *  (bank-only rows). 2026-05-27. */
  onDelete: (bankId: string) => void;
  /** Click anywhere on a row body (not the action buttons / checkbox) —
   *  drives the cross-pane highlight UX (plan #5). */
  onRowClick?: (bankId: string) => void;
  /** Bank ids currently highlighted by a click-through. */
  highlightedBankIds?: ReadonlySet<string>;
  /** Disable buttons on this row while a mutation is in flight. */
  busyBankId: string | null;
  /** Set of bank ids currently checked for bulk reconcile (2026-05-27). */
  selectedBankIds?: ReadonlySet<string>;
  /** Toggle a single row's checked state. */
  onToggleSelect?: (bankId: string) => void;
  /** Toggle every visible row's checked state at once (header checkbox). */
  onToggleSelectAll?: (checked: boolean) => void;
  /** When true, the account is an investment account — render the captured
   *  Ticker / Security / Quantity columns (FINLYNQ-207). Default false keeps
   *  cash reconcile views byte-identical. */
  isInvestment?: boolean;
}) {
  const selectionEnabled = !!onToggleSelect;
  const allChecked =
    selectionEnabled &&
    rows.length > 0 &&
    rows.every((r) => selectedBankIds?.has(r.id));
  const someChecked =
    selectionEnabled &&
    !allChecked &&
    rows.some((r) => selectedBankIds?.has(r.id));
  if (loading) {
    return (
      <p className="p-6 text-sm text-muted-foreground text-center">
        Loading…
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground text-center">
        No bank-ledger entries for this account yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {selectionEnabled && (
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all bank rows"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked;
                    }}
                    onChange={(e) => onToggleSelectAll?.(e.target.checked)}
                    className="h-4 w-4 cursor-pointer"
                  />
                </TableHead>
              )}
              <TableHead>Date</TableHead>
              <TableHead>Payee</TableHead>
              {isInvestment && <TableHead>Ticker</TableHead>}
              {isInvestment && <TableHead>Security</TableHead>}
              <TableHead>Status</TableHead>
              {isInvestment && (
                <TableHead className="text-right">Qty</TableHead>
              )}
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-48 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const dimmed =
                r.status === "linked_primary" || r.status === "linked_extra"
                  ? "opacity-70"
                  : "";
              const busy = busyBankId === r.id;
              const highlighted = highlightedBankIds?.has(r.id) ?? false;
              const highlightClass = highlighted
                ? "bg-sky-500/10 outline outline-2 outline-sky-500/40"
                : "";
              const checked = selectedBankIds?.has(r.id) ?? false;
              return (
                <TableRow
                  key={r.id}
                  className={`${dimmed} ${highlightClass} cursor-pointer`}
                  onClick={(e) => {
                    // Don't fire the row click when the user is clicking
                    // the action buttons (Create / Unlink / Delete) or the
                    // selection checkbox. Buttons stopPropagation themselves,
                    // but defensive double-check here keeps the highlight UX
                    // predictable.
                    const t = e.target as HTMLElement;
                    if (t.closest("button")) return;
                    if (t.closest("input")) return;
                    onRowClick?.(r.id);
                  }}
                >
                  {selectionEnabled && (
                    <TableCell className="w-10">
                      <input
                        type="checkbox"
                        aria-label={`Select bank row ${r.date} ${r.payee ?? ""}`}
                        checked={checked}
                        onChange={() => onToggleSelect?.(r.id)}
                        className="h-4 w-4 cursor-pointer"
                      />
                    </TableCell>
                  )}
                  <TableCell className="font-mono text-xs">{r.date}</TableCell>
                  <TableCell className="text-xs truncate max-w-[220px]">
                    {r.payee || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  {isInvestment && (
                    <TableCell className="font-mono text-xs uppercase">
                      {r.ticker || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  {isInvestment && (
                    <TableCell className="text-xs truncate max-w-[200px]">
                      {r.securityName || (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-xs">
                    <div className="flex items-center gap-1 flex-wrap">
                      <MatchPill
                        variant={r.status}
                        title={
                          r.linkedTransactionId != null
                            ? `Linked to tx #${r.linkedTransactionId}`
                            : r.suggestedTransactionId != null
                              ? `Suggested match: tx #${r.suggestedTransactionId}`
                              : r.status === "bank_only" && r.seenCount > 1
                                ? `Seen in ${r.seenCount} statements`
                                : undefined
                        }
                      />
                      {r.suggestedInvestmentOp && (
                        <span
                          className="rounded bg-violet-500/10 text-violet-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                          title={`A rule will record this as a ${r.suggestedInvestmentOp} when you create it`}
                        >
                          → {r.suggestedInvestmentOp}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  {isInvestment && (
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {r.quantity != null ? (
                        formatQuantity(r.quantity)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-mono text-xs">
                    {formatCurrency(r.amount, r.currency || "CAD")}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {r.status === "bank_only" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => onMaterialize(r.id)}
                          className="h-7 text-xs"
                        >
                          <Plus className="h-3 w-3 mr-1" />
                          Create
                        </Button>
                      ) : (r.status === "linked_primary" ||
                          r.status === "linked_extra") &&
                        r.linkedTransactionId != null ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            onUnlink(r.id, r.linkedTransactionId!)
                          }
                          className="h-7 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Unlink className="h-3 w-3 mr-1" />
                          Unlink
                        </Button>
                      ) : null}
                      {/* Per-row delete (2026-05-27). Always available so
                          mis-imported rows can be removed without touching
                          the whole batch. The page handler decides whether
                          to surface a confirmation modal (linked rows) or
                          fire DELETE immediately (bank-only rows). */}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onDelete(r.id)}
                        title="Delete this bank-ledger row"
                        aria-label="Delete bank row"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
