"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import { ArrowLeft, Wallet, Layers, Hash } from "lucide-react";

type Transaction = {
  id: number;
  date: string;
  accountName: string;
  categoryName: string;
  categoryType: string;
  currency: string;
  amount: number;
  payee: string;
  note: string;
};

type Account = {
  id: number;
  type: string;
  group: string;
  name: string;
  currency: string;
};

type AccountBalance = {
  accountId: number;
  balance: number;
};

export default function AccountDetailPage() {
  const { id } = useParams();
  const [account, setAccount] = useState<Account | null>(null);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((accts) => {
        const found = accts.find((a: Account) => a.id === Number(id));
        setAccount(found ?? null);
      });

    // Fetch the computed balance from the dashboard API (sums all transactions for the account)
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => {
        const acctBalance = d.balances?.find((b: AccountBalance) => b.accountId === Number(id));
        setBalance(acctBalance?.balance ?? 0);
      });

    fetch(`/api/transactions?accountId=${id}&limit=200`)
      .then((r) => r.json())
      .then((d) => {
        setTxns(d.data);
        setTotal(d.total);
      });
  }, [id]);

  if (!account) return (
    <div className="space-y-6">
      <div className="h-4 w-32 bg-muted animate-pulse rounded" />
      <div className="h-8 w-64 bg-muted animate-pulse rounded-lg" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" />)}
      </div>
    </div>
  );

  const displayBalance = balance ?? 0;

  return (
    <div className="space-y-6">
      <Link href="/accounts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Accounts
      </Link>

      <div className="flex items-center gap-3">
        <div className={`h-10 w-10 rounded-xl flex items-center justify-center text-sm font-bold ${account.type === "A" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
          {account.name.charAt(0)}
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{account.name}</h1>
          <div className="flex gap-2 mt-0.5">
            <Badge variant="outline" className="text-[10px]">{account.currency}</Badge>
            <Badge variant={account.type === "A" ? "default" : "destructive"} className="text-[10px]">
              {account.type === "A" ? "Asset" : "Liability"}
            </Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Balance</p>
                <p className={`text-2xl font-bold tracking-tight mt-1 ${displayBalance >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {formatCurrency(displayBalance, account.currency)}
                </p>
              </div>
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${displayBalance >= 0 ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"}`}>
                <Wallet className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Group</p>
                <p className="text-lg font-semibold mt-1">{account.group || "None"}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
                <Layers className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Transactions</p>
                <p className="text-lg font-semibold mt-1">{total}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
                <Hash className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent Transactions</CardTitle>
          <p className="text-xs text-muted-foreground">Last {txns.length} transactions</p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Category</TableHead>
                <TableHead className="text-xs">Payee</TableHead>
                <TableHead className="text-xs">Note</TableHead>
                <TableHead className="text-xs text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txns.map((t) => (
                <TableRow key={t.id} className="hover:bg-muted/30">
                  <TableCell className="text-sm">{formatDate(t.date)}</TableCell>
                  <TableCell className="text-sm">{t.categoryName ?? "-"}</TableCell>
                  <TableCell className="text-sm">{t.payee || "-"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-40 truncate">{t.note || "-"}</TableCell>
                  <TableCell className={`text-right font-mono text-sm font-semibold ${t.amount >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {formatCurrency(t.amount, t.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
