"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

/**
 * Compact banner shown on the dashboard when the user has unresolved
 * cross-currency rows in tx_currency_audit. Renders nothing when count = 0.
 *
 * Listens for `currency-audit-changed` window events so the banner
 * refreshes immediately when the user resolves a row on /transactions/audit.
 */
export function CurrencyAuditBanner() {
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/transactions/audit")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.unresolvedCount === "number") setCount(d.unresolvedCount);
        else setCount(0);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("currency-audit-changed", handler);
    return () => window.removeEventListener("currency-audit-changed", handler);
  }, [refresh]);

  if (!count || count === 0) return null;

  return (
    <Link
      href="/transactions/audit"
      className="block group"
    >
      <div className="rounded-lg border border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/30 px-3 py-2 flex items-center gap-3 hover:border-amber-500/60 transition-colors">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <p className="text-xs">
          <strong className="font-semibold">{count} transaction{count === 1 ? "" : "s"}</strong> need a currency review.{" "}
          <span className="text-muted-foreground group-hover:text-foreground transition-colors">
            Review →
          </span>
        </p>
      </div>
    </Link>
  );
}
