"use client";

/**
 * InboxReconciledTab — Manual-lens Reconciled tab body for /inbox.
 *
 * Read-only list of bank rows that already have a `transaction_bank_links`
 * row in the snapshot returned by /api/reconcile/suggestions. Shares the
 * data fetched by InboxReconcileTab via lifted-up state on the page; no
 * second fetch. Filters down to the rows where `linked.length > 0`.
 */

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Check, Inbox } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import type { ReconcileData } from "./inbox-reconcile-tab";

export function InboxReconciledTab({ data }: { data: ReconcileData | null }) {
  if (!data) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          Loading…
        </CardContent>
      </Card>
    );
  }

  // Each bank row may appear in `linked` more than once when the user
  // attached an "extra" link in addition to the primary FK row. Surface
  // each (bank, tx) pair as one reconciled-row entry for transparency.
  const rows = data.linked
    .map((l) => {
      const bank = data.bankTransactions[l.bankTransactionId];
      const tx = data.transactions[l.transactionId];
      if (!bank || !tx) return null;
      return { link: l, bank, tx };
    })
    .filter(
      (r): r is NonNullable<typeof r> => r !== null,
    )
    .sort((a, b) => b.bank.date.localeCompare(a.bank.date));

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-3">
          <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
          <div>
            <p className="text-sm font-medium">
              Nothing reconciled yet on this account
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Once you accept a suggestion or bulk-link rows on the Reconcile
              tab, they&apos;ll show up here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Fully reconciled rows — in your bank ledger AND in your transaction
        history. {rows.length} link{rows.length === 1 ? "" : "s"}.
      </p>
      <div className="space-y-1.5">
        {rows.map(({ link, bank, tx }) => (
          <div
            key={`${link.transactionId}:${link.bankTransactionId}`}
            className="rounded-lg border bg-muted/20 px-4 py-2.5 opacity-90 hover:opacity-100 transition-opacity"
          >
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-xs font-mono text-muted-foreground w-24 shrink-0">
                {bank.date}
              </span>
              <span className="text-sm truncate flex-1 min-w-0">
                {bank.payee ?? tx.payee ?? "(no payee)"}
              </span>
              <Badge
                variant="outline"
                className="gap-1 text-[10px] font-mono uppercase border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
              >
                <Check className="h-2.5 w-2.5" />
                {link.linkType === "primary" ? "primary" : "extra"}
              </Badge>
              {tx.categoryName && (
                <Badge variant="secondary" className="text-[10px] font-mono">
                  {tx.categoryName}
                </Badge>
              )}
              <span
                className={`text-sm font-mono w-28 text-right shrink-0 ${
                  bank.amount < 0 ? "text-rose-500" : "text-emerald-500"
                }`}
              >
                {formatCurrency(bank.amount, bank.currency)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
