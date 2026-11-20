"use client";

/**
 * SimpleFIN pending charges (holds / not-yet-posted) — shared by Settings → Bank
 * feeds (every account) and the account page (one account, GH #421).
 *
 * Pending charges are a LIVE snapshot (`simplefin_pending_transactions`,
 * replaced on every sync) and are never booked as transactions: a hold can be
 * reversed or re-posted as a different charge, so it only reaches the ledger
 * once the bank posts it. Nothing here is counted in a balance or total.
 */

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { safeName } from "@/lib/safe-name";

export interface PendingCharge {
  accountId: number | null;
  accountName: string;
  fitId: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  description: string | null;
  syncedAt: string;
}

/** Fetch the pending snapshot, all accounts or one. A failure reads as "none". */
export async function fetchPendingCharges(accountId?: number): Promise<PendingCharge[]> {
  const qs = accountId != null ? `?accountId=${accountId}` : "";
  try {
    const res = await fetch(`/api/settings/bank-feeds/simplefin/pending${qs}`);
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { pending?: PendingCharge[] } };
    return json.data?.pending ?? [];
  } catch {
    return [];
  }
}

/** The rows. `showAccount` adds the account name under each payee. */
export function PendingChargesList({
  rows,
  showAccount = true,
}: {
  rows: PendingCharge[];
  showAccount?: boolean;
}) {
  return (
    <div className="rounded-xl border divide-y">
      {rows.map((p) => (
        <div
          key={`${p.accountId ?? "x"}-${p.fitId}`}
          className="flex items-center justify-between gap-3 px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{safeName(p.payee, "charge", 0)}</p>
            <p className="text-xs text-muted-foreground truncate">
              {[p.date || null, showAccount ? p.accountName : null].filter(Boolean).join(" · ") ||
                "Pending"}
            </p>
          </div>
          <span className="text-sm font-medium tabular-nums shrink-0 text-muted-foreground">
            {formatCurrency(p.amount, p.currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The account page's card: renders nothing until the account has at least one
 * pending charge (most accounts have no bank feed), and nothing on a failure.
 */
export function AccountPendingChargesCard({ accountId }: { accountId: number }) {
  const [rows, setRows] = useState<PendingCharge[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchPendingCharges(accountId).then((r) => {
      if (!cancelled) setRows(r);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <Clock className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base">Pending charges</CardTitle>
            <CardDescription>
              Not posted by your bank yet, so they aren&apos;t in your transactions or this
              balance. A charge appears there once it posts; a reversed hold just disappears.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <PendingChargesList rows={rows} showAccount={false} />
      </CardContent>
    </Card>
  );
}
