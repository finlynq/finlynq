"use client";

/**
 * BalanceWarningBanner — surfaced on /import/pending when the parsed
 * bank balance anchors don't line up with the running total of bank
 * rows about to be approved (2026-05-24).
 *
 * The banner is informational; clicking Approve still goes through. The
 * user can review the per-day deltas to figure out whether the file is
 * missing rows or carries duplicates the system already has.
 */

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

export interface BalanceWarning {
  date: string;
  expected: number;
  actual: number;
  delta: number;
  priorAnchorDate: string;
  priorAnchorBalance: number;
  intervalSum: number;
}

interface BalanceWarningBannerProps {
  warnings: BalanceWarning[];
  currency: string | null;
}

function fmt(value: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      currencyDisplay: "narrowSymbol",
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

export function BalanceWarningBanner({
  warnings,
  currency,
}: BalanceWarningBannerProps) {
  const [open, setOpen] = useState(false);
  if (warnings.length === 0) return null;

  const label =
    warnings.length === 1
      ? "1 day doesn't match the bank's reported balance"
      : `${warnings.length} days don't match the bank's reported balance`;

  return (
    <Card className="border-amber-300 bg-amber-50/60">
      <CardContent className="py-2.5 px-3 space-y-2">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-sm">
            <div className="font-medium text-amber-900">
              Bank balance check: {label}
            </div>
            <p className="text-xs text-amber-800/90 mt-0.5">
              Approve still works — this is a heads-up that one or more
              transactions may be missing, duplicated, or wrong on the
              affected days.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-amber-900 hover:bg-amber-100"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? (
              <>
                Hide
                <ChevronUp className="h-3.5 w-3.5 ml-1" />
              </>
            ) : (
              <>
                Details
                <ChevronDown className="h-3.5 w-3.5 ml-1" />
              </>
            )}
          </Button>
        </div>
        {open && (
          <div className="rounded-md border border-amber-200 bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-amber-100/60 text-amber-900">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">Date</th>
                  <th className="text-left px-2 py-1.5 font-medium">
                    Prior anchor
                  </th>
                  <th className="text-right px-2 py-1.5 font-medium">
                    Expected
                  </th>
                  <th className="text-right px-2 py-1.5 font-medium">
                    Bank says
                  </th>
                  <th className="text-right px-2 py-1.5 font-medium">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100">
                {warnings.map((w) => (
                  <tr key={w.date}>
                    <td className="px-2 py-1.5 font-mono">{w.date}</td>
                    <td className="px-2 py-1.5">
                      <span className="font-mono">{w.priorAnchorDate}</span>
                      <span className="text-muted-foreground ml-1">
                        ({fmt(w.priorAnchorBalance, currency)})
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {fmt(w.expected, currency)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {fmt(w.actual, currency)}
                    </td>
                    <td
                      className={
                        "px-2 py-1.5 text-right font-mono " +
                        (w.delta >= 0 ? "text-emerald-700" : "text-rose-700")
                      }
                    >
                      {w.delta >= 0 ? "+" : ""}
                      {fmt(w.delta, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
