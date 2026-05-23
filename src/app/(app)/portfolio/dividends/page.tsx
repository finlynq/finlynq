"use client";

/**
 * Dividend-income dashboard — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Quarterly / annual / per-holding views. Reads
 * /api/portfolio/dividends with a `groupBy` param. Negative-amount
 * rows (withholding tax, corrections) surface as a separate badge
 * count per group rather than being netted.
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

interface GroupRow {
  bucket: string;
  label: string;
  amount: number;
  currency: string;
  rowCount: number;
  reinvestedCount: number;
  withholdingCount: number;
}

interface ApiResponse {
  success: boolean;
  data: {
    groups?: GroupRow[];
    totals: {
      amount: number;
      rowCount: number;
      byCurrency: Record<string, number>;
    };
  };
}

type GroupBy = "quarter" | "year" | "holding";

export default function DividendsPage() {
  const [groupBy, setGroupBy] = useState<GroupBy>("year");
  const [data, setData] = useState<ApiResponse["data"] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("groupBy", groupBy);
    setLoading(true);
    fetch(`/api/portfolio/dividends?${params.toString()}`)
      .then((r) => r.json())
      .then((json: ApiResponse) => {
        if (json.success) setData(json.data);
        else setData(null);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [groupBy]);

  const csvHref = useMemo(() => {
    const params = new URLSearchParams();
    params.set("groupBy", groupBy);
    params.set("format", "csv");
    return `/api/portfolio/dividends?${params.toString()}`;
  }, [groupBy]);

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dividend income</h1>
          <p className="text-sm text-muted-foreground">
            Every transaction categorized as Dividends, including reinvestments and
            withholding-tax entries.
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
        <span className="text-sm text-muted-foreground">Group by:</span>
        {(["year", "quarter", "holding"] as const).map((g) => (
          <Button
            key={g}
            size="sm"
            variant={groupBy === g ? "default" : "outline"}
            onClick={() => setGroupBy(g)}
          >
            {g[0].toUpperCase() + g.slice(1)}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {loading
              ? "Loading…"
              : data
                ? `${data.totals.rowCount} dividend row${data.totals.rowCount === 1 ? "" : "s"}`
                : "—"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!loading && data && Object.entries(data.totals.byCurrency).length > 0 && (
            <div className="mb-4 flex flex-wrap gap-3 text-sm">
              {Object.entries(data.totals.byCurrency).map(([ccy, total]) => (
                <Badge
                  key={ccy}
                  variant={total >= 0 ? "default" : "destructive"}
                  className="px-3 py-1"
                >
                  {formatCurrency(total, ccy)} {ccy}
                </Badge>
              ))}
            </div>
          )}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data || !data.groups || data.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No dividend transactions yet. Tag dividend payouts with a category named
              &quot;Dividends&quot; for them to show up here.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{groupBy === "holding" ? "Holding" : "Period"}</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Reinvested</TableHead>
                  <TableHead className="text-right">Withholding</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.groups.map((g) => (
                  <TableRow key={g.bucket}>
                    <TableCell>{g.label}</TableCell>
                    <TableCell className="text-right">{g.rowCount}</TableCell>
                    <TableCell className="text-right">{g.reinvestedCount}</TableCell>
                    <TableCell className="text-right">{g.withholdingCount}</TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        g.amount >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {formatCurrency(g.amount, g.currency)} {g.currency}
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
