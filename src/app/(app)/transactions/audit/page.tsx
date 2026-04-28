"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { ArrowLeft, AlertTriangle, RefreshCw, Check, X } from "lucide-react";

type AuditRow = {
  id: number;
  transactionId: number;
  accountCurrency: string;
  recordedCurrency: string;
  recordedAmount: number;
  flaggedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  txDate: string | null;
  accountId: number | null;
};

type PreviewState = {
  rate: number;
  source: string;
  oldAmount: number;
  oldCurrency: string;
  newAmount: number;
  newCurrency: string;
} | null;

export default function CurrencyAuditPage() {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Record<number, PreviewState>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/transactions/audit${includeResolved ? "?includeResolved=1" : ""}`);
      if (res.ok) {
        const data = await res.json();
        setItems(data.items ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeResolved]);

  async function loadPreview(row: AuditRow) {
    if (preview[row.id] || row.txDate == null) return;
    const url = `/api/fx/preview?from=${encodeURIComponent(row.recordedCurrency)}&to=${encodeURIComponent(row.accountCurrency)}&date=${encodeURIComponent(row.txDate)}&amount=${encodeURIComponent(row.recordedAmount)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setPreview((p) => ({
        ...p,
        [row.id]: {
          rate: data.rate,
          source: data.source,
          oldAmount: row.recordedAmount,
          oldCurrency: row.recordedCurrency,
          newAmount: data.converted ?? row.recordedAmount,
          newCurrency: data.to,
        },
      }));
    } catch { /* surfaces via convert action */ }
  }

  async function resolve(id: number, action: "convert" | "keep") {
    setBusy(id);
    setError("");
    try {
      const res = await fetch("/api/transactions/audit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed (HTTP ${res.status})`);
      }
      await load();
      // Notify the dashboard banner to refetch its count.
      try { window.dispatchEvent(new Event("currency-audit-changed")); } catch { /* SSR */ }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to resolve");
    } finally {
      setBusy(null);
    }
  }

  const unresolved = items.filter((r) => r.resolvedAt == null);

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/transactions" className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1 mb-2">
            <ArrowLeft className="h-3 w-3" />
            Back to Transactions
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Currency Review</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Transactions with a currency that doesn&apos;t match their account&apos;s currency.
            These were flagged when we added the entered/account/reporting model — they need
            a decision before balances reflect them correctly.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(e) => setIncludeResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {!loading && unresolved.length === 0 && !includeResolved ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            <Check className="h-8 w-8 mx-auto mb-3 text-emerald-500" />
            <p className="text-sm font-medium text-foreground">No flagged transactions</p>
            <p className="text-xs mt-1">All transactions match their account currency or have been reviewed.</p>
          </CardContent>
        </Card>
      ) : null}

      {items.map((row) => {
        const p = preview[row.id];
        const isResolved = row.resolvedAt != null;
        return (
          <Card key={row.id} onMouseEnter={() => loadPreview(row)}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <CardTitle className="text-sm">
                      Transaction #{row.transactionId}
                      {row.txDate ? <span className="text-xs text-muted-foreground font-normal ml-2">{row.txDate}</span> : null}
                    </CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    Recorded as <strong className="text-foreground">{formatCurrency(row.recordedAmount, row.recordedCurrency)}</strong>
                    {" "}in an account whose currency is <strong className="text-foreground">{row.accountCurrency}</strong>.
                  </CardDescription>
                </div>
                {isResolved ? (
                  <Badge variant="secondary" className="text-xs">
                    {row.resolution}
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            {!isResolved ? (
              <CardContent className="pt-0 space-y-3">
                {p ? (
                  <div className="rounded-md bg-muted/30 px-3 py-2 text-xs space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">Conversion preview at {row.txDate}:</span>
                      <span className="font-mono">{formatCurrency(p.oldAmount, p.oldCurrency)}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono font-semibold">{formatCurrency(p.newAmount, p.newCurrency)}</span>
                      <span className="text-muted-foreground">(rate {p.rate.toFixed(4)} · {p.source})</span>
                    </div>
                    <p className="text-muted-foreground">
                      Account balance will shift by {formatCurrency(p.newAmount - p.oldAmount, p.newCurrency)} if you convert.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Loading conversion preview…</p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => resolve(row.id, "convert")}
                    disabled={busy === row.id || !p}
                  >
                    <RefreshCw className="h-3 w-3 mr-1.5" />
                    Convert
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolve(row.id, "keep")}
                    disabled={busy === row.id}
                  >
                    <Check className="h-3 w-3 mr-1.5" />
                    Keep as-is
                  </Button>
                  <Link href={`/transactions?id=${row.transactionId}`}>
                    <Button size="sm" variant="ghost">
                      <X className="h-3 w-3 mr-1.5" />
                      Edit transaction
                    </Button>
                  </Link>
                </div>
              </CardContent>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
