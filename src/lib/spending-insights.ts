// Feature 10: Spending Insights & Anomaly Detection

type SpendingRow = {
  month: string;
  categoryName: string;
  categoryGroup: string;
  total: number;
};

export type Anomaly = {
  category: string;
  currentMonth: number;
  average: number;
  percentAbove: number;
  severity: "warning" | "alert";
};

export type CategoryTrend = {
  category: string;
  group: string;
  trend: "rising" | "stable" | "declining";
  changePercent: number;
  monthlyData: { month: string; total: number }[];
};

export type MerchantInsight = {
  payee: string;
  totalSpent: number;
  count: number;
  avgTransaction: number;
};

export function detectAnomalies(spending: SpendingRow[], currentMonth: string): Anomaly[] {
  // Group by category
  const byCategory = new Map<string, SpendingRow[]>();
  for (const row of spending) {
    byCategory.set(row.categoryName, [...(byCategory.get(row.categoryName) ?? []), row]);
  }

  const anomalies: Anomaly[] = [];

  for (const [category, rows] of byCategory) {
    const current = rows.find((r) => r.month === currentMonth);
    if (!current) continue;

    const previous = rows.filter((r) => r.month !== currentMonth && r.month < currentMonth);
    if (previous.length < 2) continue;

    const avg = previous.reduce((s, r) => s + Math.abs(r.total), 0) / previous.length;
    const currentAbs = Math.abs(current.total);

    if (avg > 0) {
      const pctAbove = ((currentAbs - avg) / avg) * 100;
      if (pctAbove > 30) {
        anomalies.push({
          category,
          currentMonth: Math.round(currentAbs * 100) / 100,
          average: Math.round(avg * 100) / 100,
          percentAbove: Math.round(pctAbove),
          severity: pctAbove > 50 ? "alert" : "warning",
        });
      }
    }
  }

  return anomalies.sort((a, b) => b.percentAbove - a.percentAbove);
}

export function analyzeTrends(spending: SpendingRow[]): CategoryTrend[] {
  const byCategory = new Map<string, SpendingRow[]>();
  for (const row of spending) {
    byCategory.set(row.categoryName, [...(byCategory.get(row.categoryName) ?? []), row]);
  }

  const trends: CategoryTrend[] = [];

  for (const [category, rows] of byCategory) {
    const sorted = rows.sort((a, b) => a.month.localeCompare(b.month));
    if (sorted.length < 3) continue;

    const recent = sorted.slice(-3);
    const older = sorted.slice(-6, -3);

    const recentAvg = recent.reduce((s, r) => s + Math.abs(r.total), 0) / recent.length;
    const olderAvg = older.length > 0
      ? older.reduce((s, r) => s + Math.abs(r.total), 0) / older.length
      : recentAvg;

    const change = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;

    trends.push({
      category,
      group: sorted[0].categoryGroup ?? "",
      trend: change > 10 ? "rising" : change < -10 ? "declining" : "stable",
      changePercent: Math.round(change),
      monthlyData: sorted.map((r) => ({ month: r.month, total: Math.abs(r.total) })),
    });
  }

  return trends.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
}

export function analyzeMerchants(
  transactions: { payee: string; amount: number }[]
): MerchantInsight[] {
  const byPayee = new Map<string, { total: number; count: number }>();

  for (const t of transactions) {
    if (!t.payee) continue;
    const key = t.payee.trim();
    const existing = byPayee.get(key) ?? { total: 0, count: 0 };
    existing.total += Math.abs(t.amount);
    existing.count++;
    byPayee.set(key, existing);
  }

  return Array.from(byPayee.entries())
    .map(([payee, data]) => ({
      payee,
      totalSpent: Math.round(data.total * 100) / 100,
      count: data.count,
      avgTransaction: Math.round((data.total / data.count) * 100) / 100,
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent);
}

// Day-of-week spending analysis
export function spendingByDayOfWeek(
  transactions: { date: string; amount: number }[]
): { day: string; total: number; avg: number; count: number }[] {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const data = days.map(() => ({ total: 0, count: 0 }));

  for (const t of transactions) {
    if (t.amount >= 0) continue; // only expenses
    const dow = new Date(t.date + "T00:00:00").getDay();
    data[dow].total += Math.abs(t.amount);
    data[dow].count++;
  }

  return days.map((day, i) => ({
    day,
    total: Math.round(data[i].total * 100) / 100,
    avg: data[i].count > 0 ? Math.round((data[i].total / data[i].count) * 100) / 100 : 0,
    count: data[i].count,
  }));
}
