"use client";

/**
 * Bank-ledger staging calculation for the /import Staging tab (FINLYNQ-124,
 * was issue #154).
 *
 * The detailed/manual "Send to bank ledger" flow writes the file's rows ONLY
 * to `bank_transactions` — never `transactions`. So this banner shows the
 * BANK-ledger staging math, not a system-ledger projection (which duplicated
 * the Reconcile tab's "Bank says / Finlynq has / Delta" card and went dead
 * after send):
 *
 *   Statement says X · Bank ledger has Y · After sending N rows Z
 *
 *   - Bank ledger has (Y) = the left pane's running total — what staged rows
 *     actually land into.
 *   - After sending N rows (Z) = Y + the sendable delta over the right-pane
 *     checkboxes. Rendered as a THIRD column only when N ≥ 1, so it stops
 *     being a dead duplicate of "Bank ledger has" once everything is sent.
 *   - Match (✓ / Δ) compares the RESULTING bank-ledger balance to the
 *     statement.
 *
 * Display-only — never blocks send. Statements lag, pending transactions clear
 * later, and the user is the judge of when it's "right".
 *
 * Renders nothing when statementBalance is null (CSV without a manual
 * override). When boundAccountId is null but statementBalance is present, it
 * renders a one-line "no account linked" hint instead — this keeps the user
 * from wondering why their typed-in balance went unused.
 *
 * Currency: OFX/QFX is always same-currency and the common CSV case too —
 * display in `statementCurrency ?? boundAccountCurrency` and compare
 * numerically. Cross-currency FX of the bank-ledger figure is out of scope.
 */

import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";

export interface ReconciliationCalloutProps {
  statementBalance: number | null;
  statementBalanceDate: string | null;
  statementCurrency: string | null;
  boundAccountId: number | null;
  /** The left pane's running total — the latest-dated bank-ledger
   *  runningBalance. What staged rows land into. Null when the account has
   *  no anchor yet. */
  bankLedgerBalance: number | null;
  /** How many rows the Send button will write to the bank ledger right now
   *  (tracks the right-pane checkboxes live). The "After sending N rows"
   *  column renders only when this is ≥ 1. */
  sendCount: number;
  /** Summed amount of those sendable rows. `bankLedgerBalance + sendDelta` is
   *  the projected post-send bank-ledger balance. */
  sendDelta: number;
  /** Account currency — used when statementCurrency is missing. */
  boundAccountCurrency: string | null;
}

const MATCH_TOLERANCE = 0.01;

export function ReconciliationCallout(props: ReconciliationCalloutProps) {
  const {
    statementBalance,
    statementBalanceDate,
    statementCurrency,
    boundAccountId,
    bankLedgerBalance,
    sendCount,
    sendDelta,
    boundAccountCurrency,
  } = props;

  // No statement balance → nothing to reconcile against. Stay silent;
  // the rest of the page does the job.
  if (statementBalance == null) return null;

  // Multi-account upload (no bound account) — render the helper note so
  // the user sees their typed-in balance was acknowledged but explain why
  // the bank-ledger calculation can't run.
  if (boundAccountId == null) {
    return (
      <Card className="border-muted bg-muted/30">
        <CardContent className="py-3 px-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4 shrink-0" />
          <span>
            No account linked — statement balance not reconcilable.
          </span>
        </CardContent>
      </Card>
    );
  }

  const ccy = statementCurrency ?? boundAccountCurrency ?? "USD";

  // The bank ledger has no anchor yet (brand-new account) — there's nothing
  // to project a send against. Show the statement we captured plus a muted
  // note rather than an empty/zero figure that looks wrong.
  if (bankLedgerBalance == null) {
    return (
      <Card className="border-muted bg-muted/30" data-testid="reconciliation-callout">
        <CardContent className="py-3 px-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4 shrink-0" />
          <span>
            Statement says{" "}
            <span className="font-mono">
              {formatCurrency(statementBalance, ccy)}
            </span>
            {statementBalanceDate ? ` as of ${statementBalanceDate}` : ""} — the
            bank ledger has no balance yet to compare against.
          </span>
        </CardContent>
      </Card>
    );
  }

  // The figure we compare to the statement: post-send when there's anything
  // to send, otherwise the current bank-ledger total.
  const hasPending = sendCount >= 1;
  const result = hasPending ? bankLedgerBalance + sendDelta : bankLedgerBalance;
  const isMatch = Math.abs(result - statementBalance) <= MATCH_TOLERANCE;

  const cardCls = isMatch
    ? "border-emerald-200 bg-emerald-50/30 dark:bg-emerald-950/10"
    : "border-amber-200 bg-amber-50/30 dark:bg-amber-950/10";
  const resultCls = isMatch
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-amber-700 dark:text-amber-400";

  return (
    <Card className={cardCls} data-testid="reconciliation-callout">
      <CardContent className="py-4 px-5">
        <div className="flex items-start justify-between gap-4">
          <div
            className={`grid grid-cols-1 ${hasPending ? "sm:grid-cols-3" : "sm:grid-cols-2"} gap-4 flex-1`}
          >
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Statement says
              </p>
              <p className="text-lg font-mono font-semibold mt-1">
                {formatCurrency(statementBalance, ccy)}
              </p>
              {statementBalanceDate && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  as of {statementBalanceDate}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Bank ledger has
              </p>
              <p
                className={`text-lg font-mono font-semibold mt-1 ${hasPending ? "" : resultCls}`}
              >
                {formatCurrency(bankLedgerBalance, ccy)}
              </p>
            </div>
            {hasPending && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  After sending {sendCount} {sendCount === 1 ? "row" : "rows"}
                </p>
                <p
                  className={`text-lg font-mono font-semibold mt-1 ${resultCls}`}
                >
                  {formatCurrency(result, ccy)}
                </p>
              </div>
            )}
          </div>
          <div className="shrink-0 pt-1">
            {isMatch ? (
              <CheckCircle2
                className="h-6 w-6 text-emerald-600 dark:text-emerald-400"
                aria-label="Reconciled — bank ledger matches statement"
              />
            ) : (
              <AlertTriangle
                className="h-6 w-6 text-amber-600 dark:text-amber-400"
                aria-label="Mismatch — bank ledger does not match statement"
              />
            )}
          </div>
        </div>
        {!isMatch && (
          <p className="text-xs text-muted-foreground mt-3">
            Difference of{" "}
            <span className="font-mono">
              {formatCurrency(Math.abs(result - statementBalance), ccy)}
            </span>
            . Statements often lag — pending transactions may not have cleared.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
