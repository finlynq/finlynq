"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { OnboardingTips } from "@/components/onboarding-tips";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";

type AccountBalance = {
  accountId: number;
  accountName: string;
  accountType: string;
  accountGroup: string;
  currency: string;
  balance: number;
};

function SummarySkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-40 bg-muted animate-pulse rounded-lg" />
        <div className="h-4 w-64 bg-muted animate-pulse rounded-lg mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-muted animate-pulse" />
                <div className="h-4 w-24 bg-muted animate-pulse rounded" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-7 w-32 bg-muted animate-pulse rounded mt-1" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-4">
            <div className="h-6 w-28 bg-muted animate-pulse rounded" />
            <Card>
              <CardHeader className="pb-2">
                <div className="h-4 w-20 bg-muted animate-pulse rounded" />
              </CardHeader>
              <CardContent className="space-y-3">
                {Array.from({ length: 3 }).map((_, j) => (
                  <div key={j} className="flex items-center justify-between py-2.5 px-3">
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
                      <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                    </div>
                    <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  function loadAccounts() {
    setLoading(true);
    setError(false);
    fetch("/api/dashboard")
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((d) => {
        setAccounts(d.balances ?? []);
        setLoading(false);
      })
      .catch(() => { setError(true); setLoading(false); });
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  const assets = accounts.filter((a) => a.accountType === "A");
  const liabilities = accounts.filter((a) => a.accountType === "L");

  const groups = (list: AccountBalance[]) => {
    const map = new Map<string, AccountBalance[]>();
    list.forEach((a) => {
      const group = a.accountGroup || "Other";
      map.set(group, [...(map.get(group) ?? []), a]);
    });
    return Array.from(map.entries());
  };

  const renderSection = (
    title: string,
    list: AccountBalance[],
    color: string,
    SectionIcon: typeof TrendingUp,
    avatarClasses: string,
  ) => (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <SectionIcon className={`h-5 w-5 ${color}`} />
        <h2 className="text-xl font-semibold">{title}</h2>
      </div>
      {groups(list).map(([group, accts]) => (
        <Card key={group}>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {group}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {accts.map((a) => (
              <Link
                key={a.accountId}
                href={`/accounts/${a.accountId}`}
                className="flex items-center justify-between hover:bg-muted/50 transition-colors rounded-lg py-2.5 px-3 gap-2"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-xs font-bold ${avatarClasses}`}
                  >
                    {a.accountName.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{a.accountName}</p>
                    <Badge variant="outline" className="text-[10px] mt-0.5">{a.currency}</Badge>
                  </div>
                </div>
                <span className={`font-mono text-sm font-semibold shrink-0 ${a.balance >= 0 ? color : "text-rose-600"}`}>
                  {formatCurrency(a.balance, a.currency)}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );

  const totalAssets = (currency: string) =>
    assets.filter((a) => a.currency === currency).reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = (currency: string) =>
    liabilities.filter((a) => a.currency === currency).reduce((s, a) => s + a.balance, 0);

  if (loading) {
    return <SummarySkeleton />;
  }

  if (error) {
    return <ErrorState title="Couldn't load accounts" message="We had trouble loading your account data." onRetry={loadAccounts} />;
  }

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <OnboardingTips page="accounts" />
        <EmptyState
          icon={Wallet}
          title="No accounts yet"
          description="Add your bank accounts, credit cards, and investments to start tracking your net worth."
          action={{ label: "Import data", href: "/import" }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <OnboardingTips page="accounts" />
      <div>
        <h1 className="text-2xl font-bold">Accounts</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Overview of your assets, liabilities, and net worth
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <TrendingUp className="h-5 w-5" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Assets (CAD)</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-emerald-600">{formatCurrency(totalAssets("CAD"), "CAD")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <TrendingUp className="h-5 w-5" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Assets (USD)</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-emerald-600">{formatCurrency(totalAssets("USD"), "USD")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center">
                <TrendingDown className="h-5 w-5" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Liabilities (CAD)</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-rose-600">{formatCurrency(totalLiabilities("CAD"), "CAD")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center">
                <TrendingDown className="h-5 w-5" />
              </div>
              <CardTitle className="text-sm text-muted-foreground">Liabilities (USD)</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-rose-600">{formatCurrency(totalLiabilities("USD"), "USD")}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {renderSection(
          "Assets",
          assets,
          "text-emerald-600",
          ArrowUpRight,
          "bg-indigo-100 text-indigo-700",
        )}
        {renderSection(
          "Liabilities",
          liabilities,
          "text-rose-600",
          ArrowDownRight,
          "bg-rose-100 text-rose-700",
        )}
      </div>
    </div>
  );
}
