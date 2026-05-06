"use client";

/**
 * Statement-balance reconciliation callout for /import/pending (issue #154).
 *
 * Three numbers side by side: what the bank statement says, what Finlynq
 * has now, and what Finlynq will have after approval. Match indicator is
 * green within a 0.01 tolerance, amber outside it.
 *
 * Display-only — never blocks approve. Statements lag, pending transactions
 * clear later, and the user is the judge of when it's "right".
 *
 * The component renders nothing when statementBalance is null (CSV without
 * a manual override). When boundAccountId is null but statementBalance is
 * present, it renders a one-line "no account linked" hint instead — this
 * keeps the user from wondering why their typed-in balance went unused.
 */

import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";

export interface ReconciliationCalloutProps {
  statementBalance: number | null;
  statementBalanceDate: string | null;
  statementCurrency: string | null;
  boundAccountId: number | null;
  /** Current account balance, FX-converted to the statement currency. */
  currentBalance: number | null;
  /** currentBalance + sum(eligible staged amounts), in statement currency. */
  projectedBalance: number | null;
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
    currentBalance,
    projectedBalance,
    boundAccountCurrency,
  } = props;

  // No statement balance → nothing to reconcile against. Stay silent;
  // the rest of the page does the job.
  if (statementBalance == null) return null;

  // Multi-account upload (no bound account) — render the helper note so
  // the user sees their typed-in balance was acknowledged but explain why
  // the three-column reconciliation can't run.
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

  // Defensive: server should populate currentBalance + projectedBalance
  // when boundAccountId is set. If it didn't (e.g. account was deleted
  // between upload and review), fall back to the helper note.
  if (currentBalance == null || projectedBalance == null) {
    return (
      <Card className="border-muted bg-muted/30">
        <CardContent className="py-3 px-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4 shrink-0" />
          <span>
            Linked account is unavailable — statement balance not reconcilable.
          </span>
        </CardContent>
      </Card>
    );
  }

  const ccy = statementCurrency ?? boundAccountCurrency ?? "CAD";
  const isMatch =
    Math.abs(projectedBalance - statementBalance) <= MATCH_TOLERANCE;

  const cardCls = isMatch
    ? "border-emerald-200 bg-emerald-50/30 dark:bg-emerald-950/10"
    : "border-amber-200 bg-amber-50/30 dark:bg-amber-950/10";
  const projectedCls = isMatch
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-amber-700 dark:text-amber-400";

  return (
    <Card className={cardCls} data-testid="reconciliation-callout">
      <CardContent className="py-4 px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
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
                Finlynq has now
              </p>
              <p className="text-lg font-mono font-semibold mt-1">
                {formatCurrency(currentBalance, ccy)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                After approval
              </p>
              <p
                className={`text-lg font-mono font-semibold mt-1 ${projectedCls}`}
              >
                {formatCurrency(projectedBalance, ccy)}
              </p>
            </div>
          </div>
          <div className="shrink-0 pt-1">
            {isMatch ? (
              <CheckCircle2
                className="h-6 w-6 text-emerald-600 dark:text-emerald-400"
                aria-label="Reconciled — projected matches statement"
              />
            ) : (
              <AlertTriangle
                className="h-6 w-6 text-amber-600 dark:text-amber-400"
                aria-label="Mismatch — projected does not match statement"
              />
            )}
          </div>
        </div>
        {!isMatch && (
          <p className="text-xs text-muted-foreground mt-3">
            Difference of{" "}
            <span className="font-mono">
              {formatCurrency(
                Math.abs(projectedBalance - statementBalance),
                ccy,
              )}
            </span>
            . Statements often lag — pending transactions may not have cleared.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
