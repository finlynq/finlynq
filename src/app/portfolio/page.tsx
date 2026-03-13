"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { TrendingUp, Wallet, BarChart3, Coins } from "lucide-react";

const COLORS = [
  "#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#f43f5e",
  "#8b5cf6", "#14b8a6", "#84cc16", "#ec4899", "#f97316",
];

const SYMBOL_BADGE_COLORS = [
  "bg-indigo-100 text-indigo-700",
  "bg-cyan-100 text-cyan-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-violet-100 text-violet-700",
  "bg-teal-100 text-teal-700",
  "bg-lime-100 text-lime-700",
  "bg-pink-100 text-pink-700",
  "bg-orange-100 text-orange-700",
];

type Holding = {
  id: number;
  accountId: number;
  accountName: string;
  name: string;
  symbol: string | null;
  currency: string;
  note: string;
};

function PortfolioPieTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { name: string; value: number; payload: { name: string; percent: number } }[];
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div className="rounded-lg border bg-card/95 backdrop-blur-sm px-3 py-2 shadow-lg">
      <p className="text-xs font-semibold mb-0.5">{entry.payload.name}</p>
      <p className="text-sm font-bold">
        {entry.value} holding{entry.value !== 1 ? "s" : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        {((entry.payload.percent ?? 0) * 100).toFixed(1)}% of portfolio
      </p>
    </div>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-40 bg-muted animate-pulse rounded-lg" />
        <div className="h-4 w-72 bg-muted animate-pulse rounded-lg mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <div className="h-3 w-20 bg-muted animate-pulse rounded" />
                  <div className="h-7 w-12 bg-muted animate-pulse rounded" />
                </div>
                <div className="h-10 w-10 rounded-xl bg-muted animate-pulse" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <div className="h-5 w-36 bg-muted animate-pulse rounded" />
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-8">
            <div className="h-44 w-44 rounded-full bg-muted animate-pulse shrink-0" />
            <div className="flex-1 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-muted animate-pulse" />
                  <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                  <div className="h-3 w-8 bg-muted animate-pulse rounded ml-auto" />
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="h-5 w-32 bg-muted animate-pulse rounded" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} className="flex items-center gap-4 py-2">
                <div className="h-4 w-28 bg-muted animate-pulse rounded" />
                <div className="h-5 w-14 bg-muted animate-pulse rounded-full" />
                <div className="h-5 w-10 bg-muted animate-pulse rounded-full ml-auto" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function PortfolioPage() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/portfolio")
      .then((r) => r.json())
      .then((data) => {
        setHoldings(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return <PortfolioSkeleton />;
  }

  // Group by account
  const groupMap = new Map<string, Holding[]>();
  holdings.forEach((h) => {
    const key = h.accountName ?? "Unknown";
    groupMap.set(key, [...(groupMap.get(key) ?? []), h]);
  });

  // Allocation by account chart
  const allocationData = Array.from(groupMap.entries()).map(([name, items]) => ({
    name,
    value: items.length,
  }));
  const totalHoldings = holdings.length;

  // Count by type
  const etfCount = holdings.filter((h) => h.symbol && !["Bitcoin", "Ethereum", "Solana", "Cardano", "Ripple", "DogeCoin", "AAVE", "Atom", "Avalanche", "Curve", "Fantom", "HBAR", "LINK", "Lite Coin", "Matic", "Polkadot", "Stellar", "Uniswap", "YFI", "Sonic"].includes(h.name)).length;
  const cryptoCount = holdings.filter((h) => h.accountName === "WealthSImple" && h.name !== "CAD WS").length;

  // Symbol color map for consistent badge colors
  const symbolColorMap = new Map<string, string>();
  let colorIndex = 0;
  holdings.forEach((h) => {
    if (h.symbol && !symbolColorMap.has(h.symbol)) {
      symbolColorMap.set(h.symbol, SYMBOL_BADGE_COLORS[colorIndex % SYMBOL_BADGE_COLORS.length]);
      colorIndex++;
    }
  });

  const summaryCards = [
    {
      label: "Total Holdings",
      value: holdings.length,
      icon: TrendingUp,
      iconBg: "bg-indigo-100 text-indigo-600",
    },
    {
      label: "Accounts",
      value: groupMap.size,
      icon: Wallet,
      iconBg: "bg-violet-100 text-violet-600",
    },
    {
      label: "ETFs/Stocks",
      value: etfCount,
      icon: BarChart3,
      iconBg: "bg-cyan-100 text-cyan-600",
    },
    {
      label: "Crypto",
      value: cryptoCount,
      icon: Coins,
      iconBg: "bg-amber-100 text-amber-600",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Portfolio</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Your investment holdings across all accounts
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map((card) => (
          <Card key={card.label} className="relative overflow-hidden">
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{card.label}</p>
                  <p className="text-2xl font-bold tracking-tight">{card.value}</p>
                </div>
                <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${card.iconBg}`}>
                  <card.icon className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Allocation chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Holdings by Account</CardTitle>
          <p className="text-xs text-muted-foreground">Distribution across {groupMap.size} accounts</p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-8">
            <div className="w-48 h-48 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocationData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={85}
                    strokeWidth={2}
                    stroke="var(--color-card)"
                  >
                    {allocationData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<PortfolioPieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-1.5 min-w-0">
              {allocationData.map((item, i) => (
                <div key={item.name} className="flex items-center gap-2 text-sm">
                  <div
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ background: COLORS[i % COLORS.length] }}
                  />
                  <span className="truncate text-xs text-muted-foreground flex-1">
                    {item.name}
                  </span>
                  <span className="text-xs font-medium tabular-nums">
                    {item.value} ({totalHoldings > 0 ? Math.round((item.value / totalHoldings) * 100) : 0}%)
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Holdings by account */}
      {Array.from(groupMap.entries()).map(([accountName, items]) => (
        <Card key={accountName}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {accountName}
              <Badge variant="outline">{items.length} holding{items.length !== 1 ? "s" : ""}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Holding</TableHead>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Currency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((h) => (
                  <TableRow key={h.id} className="hover:bg-muted/30 transition-colors">
                    <TableCell className="font-medium text-sm">{h.name}</TableCell>
                    <TableCell>
                      {h.symbol ? (
                        <Badge
                          variant="secondary"
                          className={`font-mono text-xs ${symbolColorMap.get(h.symbol) ?? ""}`}
                        >
                          {h.symbol}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">Cash</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{h.currency}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
