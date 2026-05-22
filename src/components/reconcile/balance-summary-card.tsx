"use client";

/**
 * BalanceSummaryCard — final bank-vs-system balance compare for the
 * /reconcile page header (2026-05-24).
 *
 * Shows the bank's latest anchored balance projected forward by every
 * subsequent bank row, alongside the system-side latest balance per the
 * canonical "investment → holdings.value, cash → SUM(transactions)"
 * rule. The delta is the reconciliation signal — non-zero means the two
 * ledgers disagree.
 *
 * `no_anchor` state: the account has bank rows but no statement-balance
 * anchor yet. The bank-side number is just Σ(bank_tx.amount) starting
 * from zero, which is informative but unvalidated. The card surfaces a
 * hint encouraging the user to upload a statement balance.
 */

import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";

export interface BalanceSummary {
  accountId: number;
  currency: string;
  latestAnchor: {
    date: string;
    balance: number;
    source: string;
    currency: string;
  } | null;
  bankSideLatest: number;
  systemSideLatest: number;
  delta: number;
  status: "balanced" | "mismatch" | "no_anchor";
}

interface BalanceSummaryCardProps {
  summary: BalanceSummary | null;
  loading?: boolean;
}

function fmt(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function BalanceSummaryCard({
  summary,
  loading,
}: BalanceSummaryCardProps) {
  if (!summary && !loading) return null;

  if (loading || !summary) {
    return (
      <Card className="border-muted">
        <CardContent className="py-3 text-sm text-muted-foreground">
          Loading balance summary…
        </CardContent>
      </Card>
    );
  }

  const { status, bankSideLatest, systemSideLatest, delta, currency, latestAnchor } =
    summary;

  const tone =
    status === "balanced"
      ? "border-emerald-300 bg-emerald-50/60"
      : status === "mismatch"
        ? "border-rose-300 bg-rose-50/60"
        : "border-sky-300 bg-sky-50/40";

  const Icon =
    status === "balanced"
      ? CheckCircle2
      : status === "mismatch"
        ? AlertTriangle
        : Info;

  const iconTone =
    status === "balanced"
      ? "text-emerald-700"
      : status === "mismatch"
        ? "text-rose-700"
        : "text-sky-700";

  return (
    <Card className={tone}>
      <CardContent className="py-2.5 px-3">
        <div className="flex items-start gap-3">
          <Icon className={`h-4 w-4 ${iconTone} shrink-0 mt-1`} />
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">
                {latestAnchor ? (
                  <>
                    Bank says (as of{" "}
                    <span className="font-mono">{latestAnchor.date}</span>)
                  </>
                ) : (
                  <>Bank says (no anchor yet)</>
                )}
              </div>
              <div className="font-mono font-medium">
                {fmt(bankSideLatest, currency)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Finlynq has</div>
              <div className="font-mono font-medium">
                {fmt(systemSideLatest, currency)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                {status === "no_anchor" ? "Status" : "Delta"}
              </div>
              {status === "balanced" && (
                <div className="font-medium text-emerald-700">✓ Balanced</div>
              )}
              {status === "mismatch" && (
                <div className="font-mono font-medium text-rose-700">
                  {delta >= 0 ? "+" : ""}
                  {fmt(delta, currency)}
                </div>
              )}
              {status === "no_anchor" && (
                <div className="text-xs text-sky-800">
                  Upload a statement balance to enable validation
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
