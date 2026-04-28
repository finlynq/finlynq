"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { formatCurrency } from "@/lib/currency";
import { useDisplayCurrency } from "@/components/currency-provider";
import { Calculator, PiggyBank, GraduationCap, Percent, ArrowRight, Lightbulb } from "lucide-react";

type TaxData = {
  tfsa: { totalRoom: number; used: number; remaining: number; currentYearLimit: number };
  rrsp: { contributions: { year: number; room: number; used: number }[] };
  resp: { contributions: { year: number; room: number; used: number }[]; grantExample: number };
  assetLocationAdvice: { holding: string; symbol: string; currentAccount: string; recommendedAccountType: string; reason: string }[];
  marginalRates: Record<string, { federal: number; provincial: number; combined: number }>;
};

function TaxPageContent() {
  const { displayCurrency } = useDisplayCurrency();
  const [data, setData] = useState<TaxData | null>(null);
  const [income, setIncome] = useState("100000");
  const [contribution, setContribution] = useState("10000");
  const [comparison, setComparison] = useState<{ rrspBenefit: number; tfsaBenefit: string; recommendation: string } | null>(null);

  useEffect(() => {
    fetch("/api/tax").then((r) => r.json()).then(setData);
  }, []);

  async function compareRrspTfsa() {
    const res = await fetch("/api/tax", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rrsp-vs-tfsa", income: parseFloat(income), contribution: parseFloat(contribution) }),
    });
    setComparison(await res.json());
  }

  if (!data) return (
    <div className="space-y-6">
      <div className="h-8 w-56 bg-muted animate-pulse rounded-lg" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-32 bg-muted animate-pulse rounded-xl" />)}
      </div>
    </div>
  );

  const tfsaPct = data.tfsa.totalRoom > 0 ? (data.tfsa.used / data.tfsa.totalRoom) * 100 : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tax Optimization</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Maximize your tax-advantaged accounts and minimize your tax bill</p>
      </div>

      {/* Contribution Room */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">TFSA Room</p>
                <p className="text-2xl font-bold tracking-tight mt-1">{formatCurrency(data.tfsa.remaining, displayCurrency)}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <PiggyBank className="h-5 w-5" />
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Used: {formatCurrency(data.tfsa.used, displayCurrency)}</span>
                <span className="font-semibold">{Math.round(tfsaPct)}%</span>
              </div>
              <Progress value={tfsaPct} className="h-2.5" />
              <p className="text-[11px] text-muted-foreground">Total room: {formatCurrency(data.tfsa.totalRoom, displayCurrency)} &middot; This year: {formatCurrency(data.tfsa.currentYearLimit, displayCurrency)}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">RESP Grant</p>
                <p className="text-2xl font-bold tracking-tight text-emerald-600 mt-1">{formatCurrency(data.resp.grantExample, displayCurrency)}/yr</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
                <GraduationCap className="h-5 w-5" />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">CESG: 20% on first $2,500/year (max $500/yr, $7,200 lifetime)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Marginal Rate @ $100K</p>
                <p className="text-2xl font-bold tracking-tight mt-1">{data.marginalRates.at100k.combined}%</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
                <Percent className="h-5 w-5" />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">Federal: {data.marginalRates.at100k.federal}% &middot; Provincial: {data.marginalRates.at100k.provincial}%</p>
          </CardContent>
        </Card>
      </div>

      {/* RRSP vs TFSA Calculator */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
              <Calculator className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">RRSP vs TFSA Calculator</CardTitle>
              <CardDescription>Compare the tax benefit of contributing to RRSP vs TFSA</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4 mb-4 flex-wrap">
            <div>
              <Label className="text-xs text-muted-foreground">Annual Income</Label>
              <Input type="number" value={income} onChange={(e) => setIncome(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Contribution Amount</Label>
              <Input type="number" value={contribution} onChange={(e) => setContribution(e.target.value)} className="mt-1" />
            </div>
            <Button onClick={compareRrspTfsa}>Compare</Button>
          </div>
          {comparison && (
            <div className="space-y-3 p-4 bg-muted/50 rounded-xl border border-dashed">
              <div className="flex justify-between items-center">
                <span className="font-medium text-sm">RRSP Tax Refund:</span>
                <span className="font-bold text-emerald-600 text-lg">{formatCurrency(comparison.rrspBenefit, displayCurrency)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="font-medium text-sm">TFSA Benefit:</span>
                <span className="text-sm text-muted-foreground">{comparison.tfsaBenefit}</span>
              </div>
              <Separator />
              <div className="flex items-start gap-2">
                <Lightbulb className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="font-medium text-sm">{comparison.recommendation}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Marginal Tax Rates */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100 text-rose-600">
              <Percent className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Marginal Tax Rates (Ontario)</CardTitle>
              <CardDescription>Combined federal and provincial rates</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Income Level</TableHead>
                <TableHead className="text-xs">Federal</TableHead>
                <TableHead className="text-xs">Provincial</TableHead>
                <TableHead className="text-xs">Combined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(data.marginalRates).map(([key, rates]) => (
                <TableRow key={key} className="hover:bg-muted/30">
                  <TableCell className="font-medium text-sm">{key.replace("at", "$").replace("k", ",000")}</TableCell>
                  <TableCell className="text-sm tabular-nums">{rates.federal}%</TableCell>
                  <TableCell className="text-sm tabular-nums">{rates.provincial}%</TableCell>
                  <TableCell className="font-bold text-sm tabular-nums">{rates.combined}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Asset Location Advice */}
      {data.assetLocationAdvice.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600">
                <Lightbulb className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Asset Location Advice</CardTitle>
                <CardDescription>Optimize which holdings go in which account type for tax efficiency</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {data.assetLocationAdvice.map((a, i) => (
                <div key={i} className="p-3.5 border rounded-xl hover:bg-muted/30 transition-colors">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="secondary" className="font-mono text-xs">{a.symbol}</Badge>
                    <span className="font-medium text-sm">{a.holding}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Currently in:</span>
                    <span className="font-medium">{a.currentAccount}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <Badge>{a.recommendedAccountType}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">{a.reason}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function TaxPage() { return <DevModeGuard><TaxPageContent /></DevModeGuard>; }
