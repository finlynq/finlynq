// Feature 6: Recurring Transaction Detection

type Transaction = {
  id: number;
  date: string;
  payee: string;
  amount: number;
  accountId: number;
  categoryId: number | null;
};

export type DetectedRecurring = {
  payee: string;
  avgAmount: number;
  frequency: "weekly" | "biweekly" | "monthly" | "yearly";
  count: number;
  lastDate: string;
  nextDate: string;
  accountId: number;
  categoryId: number | null;
  transactions: Transaction[];
};

function daysBetween(d1: string, d2: string): number {
  return Math.abs(
    (new Date(d1 + "T00:00:00").getTime() - new Date(d2 + "T00:00:00").getTime()) / 86400000
  );
}

function guessFrequency(avgDays: number): "weekly" | "biweekly" | "monthly" | "yearly" | null {
  if (avgDays >= 5 && avgDays <= 9) return "weekly";
  if (avgDays >= 12 && avgDays <= 18) return "biweekly";
  if (avgDays >= 25 && avgDays <= 35) return "monthly";
  if (avgDays >= 350 && avgDays <= 380) return "yearly";
  return null;
}

function addFrequency(date: string, frequency: string): string {
  const d = new Date(date + "T00:00:00");
  switch (frequency) {
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().split("T")[0];
}

export function detectRecurringTransactions(transactions: Transaction[]): DetectedRecurring[] {
  // Group by payee (normalized)
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const key = (t.payee || "").trim().toLowerCase();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const results: DetectedRecurring[] = [];

  for (const [, txns] of groups) {
    if (txns.length < 3) continue;

    // Sort by date
    const sorted = txns.sort((a, b) => a.date.localeCompare(b.date));

    // Check amount consistency (within 20% of average)
    const avgAmount = sorted.reduce((s, t) => s + t.amount, 0) / sorted.length;
    const amountConsistent = sorted.every(
      (t) => Math.abs(t.amount - avgAmount) / Math.abs(avgAmount) < 0.2
    );
    if (!amountConsistent) continue;

    // Check interval consistency
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(sorted[i].date, sorted[i - 1].date));
    }

    const avgInterval = intervals.reduce((s, d) => s + d, 0) / intervals.length;
    const frequency = guessFrequency(avgInterval);
    if (!frequency) continue;

    // Check interval consistency (within 40% of average)
    const intervalConsistent = intervals.every(
      (d) => Math.abs(d - avgInterval) / avgInterval < 0.4
    );
    if (!intervalConsistent) continue;

    const lastDate = sorted[sorted.length - 1].date;
    results.push({
      payee: sorted[0].payee,
      avgAmount: Math.round(avgAmount * 100) / 100,
      frequency,
      count: sorted.length,
      lastDate,
      nextDate: addFrequency(lastDate, frequency),
      accountId: sorted[0].accountId,
      categoryId: sorted[0].categoryId,
      transactions: sorted,
    });
  }

  return results.sort((a, b) => Math.abs(b.avgAmount) - Math.abs(a.avgAmount));
}

// Feature 7: Cash Flow Forecasting
export function forecastCashFlow(
  recurring: DetectedRecurring[],
  currentBalance: number,
  daysAhead: number = 90
): { date: string; balance: number; transactions: { payee: string; amount: number }[] }[] {
  const today = new Date();
  const forecast: { date: string; balance: number; transactions: { payee: string; amount: number }[] }[] = [];
  let balance = currentBalance;

  const upcoming: { date: string; payee: string; amount: number }[] = [];

  for (const r of recurring) {
    let nextDate = new Date(r.nextDate + "T00:00:00");

    while (nextDate <= new Date(today.getTime() + daysAhead * 86400000)) {
      if (nextDate >= today) {
        upcoming.push({
          date: nextDate.toISOString().split("T")[0],
          payee: r.payee,
          amount: r.avgAmount,
        });
      }
      // Advance to next occurrence
      const next = addFrequency(nextDate.toISOString().split("T")[0], r.frequency);
      nextDate = new Date(next + "T00:00:00");
    }
  }

  // Sort by date
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  // Group by date
  const byDate = new Map<string, { payee: string; amount: number }[]>();
  for (const u of upcoming) {
    byDate.set(u.date, [...(byDate.get(u.date) ?? []), { payee: u.payee, amount: u.amount }]);
  }

  // Generate forecast
  for (const [date, txns] of byDate) {
    const dayTotal = txns.reduce((s, t) => s + t.amount, 0);
    balance += dayTotal;
    forecast.push({ date, balance: Math.round(balance * 100) / 100, transactions: txns });
  }

  return forecast;
}
