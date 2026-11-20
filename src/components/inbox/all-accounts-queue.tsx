"use client";

/**
 * AllAccountsQueue (GH #422, 2026-11-20) — every Auto-pilot and Approve-each
 * account with rows waiting, on one page.
 *
 * Each account gets its own section rendering the SAME per-account tab the
 * account page uses (To categorize for Auto-pilot, To approve for Approve-each),
 * so every action (categorize, approve, link, delete, bulk, create a rule)
 * works exactly as it does there, with no second implementation to drift.
 * Each section loads its own suggestions; the server limits match-engine runs
 * per user (reconcile/compute-limiter.ts), so many sections queue rather than
 * flooding the pool.
 *
 * Manual-review accounts are listed at the end with an Open link only: by the
 * owner's decision their statement-line matching stays one account at a time.
 */

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { InboxToApproveTab } from "./inbox-to-approve-tab";
import { InboxToCategorizeTab } from "./inbox-to-categorize-tab";
import {
  MODE_LABELS,
  accountsNeedingAttention,
  combinedQueueAccounts,
  useReconcileSummary,
} from "./import-overview";

type TabAccounts = ComponentProps<typeof InboxToCategorizeTab>["accounts"];

export function AllAccountsQueue({
  accounts,
  onOpenAccount,
  onBack,
  reloadKey,
}: {
  accounts: TabAccounts;
  onOpenAccount: (accountId: number) => void;
  onBack: () => void;
  reloadKey?: number;
}) {
  const { rows, error, loading, reload } = useReconcileSummary(reloadKey);
  const queue = rows ? combinedQueueAccounts(rows) : [];
  const manual = rows
    ? accountsNeedingAttention(rows).filter((r) => (r.mode ?? "manual") === "manual")
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold">All Auto-pilot and Approve-each accounts</h2>
          <p className="text-sm text-muted-foreground">
            Every row still waiting, grouped by account. Actions here are the same as on each account&apos;s page.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" /> Overview
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">Couldn&apos;t load your accounts: {error}</p>}

      {rows && queue.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          Nothing waiting in your Auto-pilot and Approve-each accounts.
        </p>
      )}

      {queue.map((r) => (
        <section key={r.accountId} className="rounded-xl border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold truncate">{r.accountName}</h3>
              <p className="text-xs text-muted-foreground">
                {MODE_LABELS[r.mode ?? "auto"]} · {r.pendingCount} row{r.pendingCount === 1 ? "" : "s"} waiting
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => onOpenAccount(r.accountId)}>
              Open account
            </Button>
          </div>
          {r.mode === "approve" ? (
            <InboxToApproveTab key={`all-approve-${r.accountId}-${reloadKey ?? 0}`} accountId={r.accountId} accounts={accounts} />
          ) : (
            <InboxToCategorizeTab key={`all-cat-${r.accountId}-${reloadKey ?? 0}`} accountId={r.accountId} accounts={accounts} />
          )}
        </section>
      ))}

      {manual.length > 0 && (
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <h3 className="text-sm font-semibold">Manual-review accounts</h3>
          <p className="text-xs text-muted-foreground">
            These are reviewed one account at a time, line by line against your statement.
          </p>
          <div className="rounded-lg border divide-y">
            {manual.map((r) => (
              <div key={r.accountId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-sm truncate">{r.accountName}</span>
                <Button size="sm" variant="outline" onClick={() => onOpenAccount(r.accountId)}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
