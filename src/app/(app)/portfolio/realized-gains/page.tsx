"use client";

/**
 * Realized-gain dashboard — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Reads /api/portfolio/realized-gains; renders one row per
 * holding_lot_closures row, sorted newest first. Tax-year + term
 * (short/long) filter chips on top; CSV export button hits the same
 * endpoint with `format=csv`.
 *
 * Empty-state copy is "No closed lots yet" rather than "no data" —
 * users whose lots backfill hasn't run yet (portfolio_lots_status not
 * populated) see this naturally.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Download } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

interface ApiRow {
  closureId: number;
  closeDate: string;
  openDate: string;
  holdingId: number;
  holdingName: string | null;
  accountId: number;
  accountName: string | null;
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  realizedGain: number;
  currency: string;
  daysHeld: number;
  term: "short" | "long";
  closeKind: "sell" | "transfer_out";
}

interface ApiResponse {
  success: boolean;
  data: {
    rows: ApiRow[];
    totals: {
      realizedGain: number;
      qtyClosed: number;
      rowCount: number;
      byCurrency: Record<string, { realizedGain: number; qtyClosed: number }>;
    };
  };
}

const CURRENT_YEAR = new Date().getFullYear();

export default function RealizedGainsPage() {
  const [taxYear, setTaxYear] = useState<number | null>(CURRENT_YEAR);
  const [term, setTerm] = useState<"all" | "short" | "long">("all");
  const [data, setData] = useState<ApiResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    if (taxYear) params.set("taxYear", String(taxYear));
    params.set("term", term);
    setLoading(true);
    fetch(`/api/portfolio/realized-gains?${params.toString()}`)
      .then((r) => r.json())
      .then((json: ApiResponse) => {
        if (json.success) setData(json.data);
        else setData(null);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [taxYear, term]);

  const csvHref = useMemo(() => {
    const params = new URLSearchParams();
    if (taxYear) params.set("taxYear", String(taxYear));
    params.set("term", term);
    params.set("format", "csv");
    return `/api/portfolio/realized-gains?${params.toString()}`;
  }, [taxYear, term]);

  const yearChoices = [
    CURRENT_YEAR,
    CURRENT_YEAR - 1,
    CURRENT_YEAR - 2,
    CURRENT_YEAR - 3,
  ];

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Realized gains</h1>
          <p className="text-sm text-muted-foreground">
            Lot-level realized gain on every closed sell / transfer-out, per (holding, account).
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/portfolio" className="text-sm text-muted-foreground hover:underline self-center">
            ← Overview
          </Link>
          <a
            href={csvHref}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Download className="mr-2 h-4 w-4" /> CSV
          </a>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Tax year:</span>
        {yearChoices.map((y) => (
          <Button
            key={y}
            size="sm"
            variant={taxYear === y ? "default" : "outline"}
            onClick={() => setTaxYear(y)}
          >
            {y}
          </Button>
        ))}
        <Button
          size="sm"
          variant={taxYear === null ? "default" : "outline"}
          onClick={() => setTaxYear(null)}
        >
          All time
        </Button>
        <span className="ml-4 text-sm text-muted-foreground">Term:</span>
        {(["all", "short", "long"] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant={term === t ? "default" : "outline"}
            onClick={() => setTerm(t)}
          >
            {t === "short" ? "Short (≤365d)" : t === "long" ? "Long (>365d)" : "All"}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {loading
              ? "Loading…"
              : data
                ? `${data.totals.rowCount} closed lot${data.totals.rowCount === 1 ? "" : "s"}`
                : "—"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!loading && data && Object.entries(data.totals.byCurrency).length > 0 && (
            <div className="mb-4 flex flex-wrap gap-3 text-sm">
              {Object.entries(data.totals.byCurrency).map(([ccy, t]) => (
                <Badge
                  key={ccy}
                  variant={t.realizedGain >= 0 ? "default" : "destructive"}
                  className="px-3 py-1"
                >
                  {formatCurrency(t.realizedGain, ccy)} {ccy}
                </Badge>
              ))}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data || data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No closed lots in this range yet. Lots are created on every new sell / in-kind
              transfer; pre-Phase-1 history is filled in by the lot backfill admin script.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Closed</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Holding</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Cost / sh</TableHead>
                  <TableHead className="text-right">Proceeds / sh</TableHead>
                  <TableHead className="text-right">Realized</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.closureId}>
                    <TableCell className="font-mono text-xs">{r.closeDate}</TableCell>
                    <TableCell className="font-mono text-xs">{r.openDate}</TableCell>
                    <TableCell className="text-xs">{r.daysHeld}</TableCell>
                    <TableCell>
                      <Badge variant={r.term === "long" ? "secondary" : "outline"}>
                        {r.term}
                      </Badge>
                    </TableCell>
                    <TableCell>{r.holdingName ?? `#${r.holdingId}`}</TableCell>
                    <TableCell>{r.accountName ?? `#${r.accountId}`}</TableCell>
                    <TableCell className="text-right">{r.qtyClosed}</TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(r.costPerShare, r.currency)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCurrency(r.proceedsPerShare, r.currency)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        r.realizedGain >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {formatCurrency(r.realizedGain, r.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
