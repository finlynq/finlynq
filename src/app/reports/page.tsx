"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatCurrency } from "@/lib/currency";
import { Download, FileText, BarChart3, ArrowUpRight, ArrowDownRight } from "lucide-react";

type IncomeStatement = {
  period: { startDate: string; endDate: string };
  income: { categoryGroup: string; categoryName: string; total: number; count: number }[];
  expenses: { categoryGroup: string; categoryName: string; total: number; count: number }[];
  totalIncome: number; totalExpenses: number; netSavings: number; savingsRate: number;
};
type BalanceSheet = {
  date: string;
  assets: { accountGroup: string; accountName: string; currency: string; balance: number }[];
  liabilities: { accountGroup: string; accountName: string; currency: string; balance: number }[];
  totalAssets: number; totalLiabilities: number; netWorth: number;
};

export default function ReportsPage() {
  const [startDate, setStartDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(new Date().toISOString().split("T")[0]);
  const [incomeStatement, setIncomeStatement] = useState<IncomeStatement | null>(null);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheet | null>(null);
  const [isBusiness, setIsBusiness] = useState(false);

  useEffect(() => {
    const biz = isBusiness ? "&business=true" : "";
    fetch(`/api/reports?type=income-statement&startDate=${startDate}&endDate=${endDate}${biz}`).then((r) => r.json()).then(setIncomeStatement);
    fetch(`/api/reports?type=balance-sheet&endDate=${endDate}`).then((r) => r.json()).then(setBalanceSheet);
  }, [startDate, endDate, isBusiness]);

  function exportCSV(data: Record<string, unknown>[], filename: string) {
    if (!data.length) return;
    const headers = Object.keys(data[0]);
    const csv = [headers.join(","), ...data.map((row) => headers.map((h) => String(row[h] ?? "")).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Financial Reports</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Detailed income statements and balance sheets</p>
      </div>

      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4 flex-wrap">
            <div>
              <Label className="text-xs text-muted-foreground">Start Date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">End Date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1" />
            </div>
            <Button variant={isBusiness ? "default" : "outline"} onClick={() => setIsBusiness(!isBusiness)}>
              {isBusiness ? "Business Only" : "All Transactions"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="income">
        <TabsList>
          <TabsTrigger value="income">
            <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Income Statement
          </TabsTrigger>
          <TabsTrigger value="balance">
            <FileText className="h-3.5 w-3.5 mr-1.5" /> Balance Sheet
          </TabsTrigger>
        </TabsList>

        <TabsContent value="income">
          {incomeStatement && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
                      <BarChart3 className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Income Statement</CardTitle>
                      <p className="text-xs text-muted-foreground">{incomeStatement.period.startDate} to {incomeStatement.period.endDate}</p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => exportCSV([...incomeStatement.income.map((i) => ({ ...i, type: "Income" })), ...incomeStatement.expenses.map((e) => ({ ...e, type: "Expense" }))], "income-statement.csv")}>
                    <Download className="h-4 w-4 mr-1" /> Export
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 mb-3">
                  <ArrowUpRight className="h-4 w-4 text-emerald-600" />
                  <h3 className="font-semibold text-emerald-600">Income</h3>
                </div>
                <Table>
                  <TableBody>
                    {incomeStatement.income.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        <TableCell className="text-muted-foreground text-xs">{r.categoryGroup}</TableCell>
                        <TableCell className="text-sm">{r.categoryName}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold text-emerald-600">{formatCurrency(r.total, "CAD")}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-bold border-t-2">
                      <TableCell colSpan={2}>Total Income</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600">{formatCurrency(incomeStatement.totalIncome, "CAD")}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <Separator className="my-5" />
                <div className="flex items-center gap-2 mb-3">
                  <ArrowDownRight className="h-4 w-4 text-rose-600" />
                  <h3 className="font-semibold text-rose-600">Expenses</h3>
                </div>
                <Table>
                  <TableBody>
                    {incomeStatement.expenses.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        <TableCell className="text-muted-foreground text-xs">{r.categoryGroup}</TableCell>
                        <TableCell className="text-sm">{r.categoryName}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold text-rose-600">{formatCurrency(r.total, "CAD")}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-bold border-t-2">
                      <TableCell colSpan={2}>Total Expenses</TableCell>
                      <TableCell className="text-right font-mono text-rose-600">{formatCurrency(incomeStatement.totalExpenses, "CAD")}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <Separator className="my-5" />
                <div className="flex justify-between items-center p-4 rounded-xl bg-muted/50">
                  <div>
                    <p className="text-lg font-bold">Net Savings</p>
                    <p className="text-sm text-muted-foreground">Savings Rate: <span className="font-semibold">{incomeStatement.savingsRate}%</span></p>
                  </div>
                  <p className={`text-2xl font-bold ${incomeStatement.netSavings >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{formatCurrency(incomeStatement.netSavings, "CAD")}</p>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="balance">
          {balanceSheet && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
                      <FileText className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Balance Sheet</CardTitle>
                      <p className="text-xs text-muted-foreground">As of {balanceSheet.date}</p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => exportCSV([...balanceSheet.assets.map((a) => ({ ...a, type: "Asset" })), ...balanceSheet.liabilities.map((l) => ({ ...l, type: "Liability" }))], "balance-sheet.csv")}>
                    <Download className="h-4 w-4 mr-1" /> Export
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 mb-3">
                  <ArrowUpRight className="h-4 w-4 text-emerald-600" />
                  <h3 className="font-semibold text-emerald-600">Assets</h3>
                </div>
                <Table>
                  <TableBody>
                    {balanceSheet.assets.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        <TableCell className="text-muted-foreground text-xs">{r.accountGroup}</TableCell>
                        <TableCell className="text-sm">{r.accountName}</TableCell>
                        <TableCell><Badge variant="outline" className="text-[10px]">{r.currency}</Badge></TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold">{formatCurrency(r.balance, r.currency)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-bold border-t-2">
                      <TableCell colSpan={3}>Total Assets</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600">{formatCurrency(balanceSheet.totalAssets, "CAD")}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <Separator className="my-5" />
                <div className="flex items-center gap-2 mb-3">
                  <ArrowDownRight className="h-4 w-4 text-rose-600" />
                  <h3 className="font-semibold text-rose-600">Liabilities</h3>
                </div>
                <Table>
                  <TableBody>
                    {balanceSheet.liabilities.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        <TableCell className="text-muted-foreground text-xs">{r.accountGroup}</TableCell>
                        <TableCell className="text-sm">{r.accountName}</TableCell>
                        <TableCell><Badge variant="outline" className="text-[10px]">{r.currency}</Badge></TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold">{formatCurrency(r.balance, r.currency)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-bold border-t-2">
                      <TableCell colSpan={3}>Total Liabilities</TableCell>
                      <TableCell className="text-right font-mono text-rose-600">{formatCurrency(balanceSheet.totalLiabilities, "CAD")}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <Separator className="my-5" />
                <div className="flex justify-between items-center p-4 rounded-xl bg-muted/50">
                  <p className="text-lg font-bold">Net Worth</p>
                  <p className={`text-2xl font-bold ${balanceSheet.netWorth >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{formatCurrency(balanceSheet.netWorth, "CAD")}</p>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
