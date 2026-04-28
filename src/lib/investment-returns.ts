// Feature 4: Investment Returns (XIRR / TWR)
// Feature 14: Dividend tracking

type CashFlow = { date: Date; amount: number };

// XIRR: Money-weighted return using Newton's method
export function xirr(cashFlows: CashFlow[]): number {
  if (cashFlows.length < 2) return 0;

  const days = cashFlows.map((cf) => (cf.date.getTime() - cashFlows[0].date.getTime()) / (365.25 * 86400000));

  function npv(rate: number): number {
    return cashFlows.reduce((sum, cf, i) => sum + cf.amount / Math.pow(1 + rate, days[i]), 0);
  }

  function dnpv(rate: number): number {
    return cashFlows.reduce((sum, cf, i) => sum + (-days[i] * cf.amount) / Math.pow(1 + rate, days[i] + 1), 0);
  }

  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const n = npv(rate);
    const d = dnpv(rate);
    if (Math.abs(d) < 1e-10) break;
    const newRate = rate - n / d;
    if (Math.abs(newRate - rate) < 1e-7) break;
    rate = newRate;
  }

  return Math.round(rate * 10000) / 100; // return as percentage
}

// TWR: Time-weighted return
export function twr(periods: { startValue: number; endValue: number; cashFlow: number }[]): number {
  if (periods.length === 0) return 0;

  let cumulative = 1;
  for (const p of periods) {
    const adjustedStart = p.startValue + p.cashFlow;
    if (adjustedStart === 0) continue;
    cumulative *= p.endValue / adjustedStart;
  }

  return Math.round((cumulative - 1) * 10000) / 100;
}

// Calculate returns for a holding given transaction history and current value
export function calculateHoldingReturns(
  transactions: { date: string; amount: number }[],
  currentValue: number
): { xirr: number; totalReturn: number; totalInvested: number } {
  const invested = transactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const cashFlows: CashFlow[] = transactions.map((t) => ({
    date: new Date(t.date + "T00:00:00"),
    amount: t.amount, // negative for purchases, positive for sales
  }));

  // Add current value as final "sale"
  cashFlows.push({ date: new Date(), amount: currentValue });

  const xirrReturn = xirr(cashFlows);
  const totalReturn = invested > 0 ? Math.round(((currentValue - invested) / invested) * 10000) / 100 : 0;

  return { xirr: xirrReturn, totalReturn, totalInvested: invested };
}

// Dividend analysis
export type DividendSummary = {
  totalDividends: number;
  dividendsByYear: Record<string, number>;
  dividendsByMonth: Record<string, number>;
  avgMonthlyDividend: number;
  yieldOnCost: number;
};

export function analyzeDividends(
  dividendTransactions: { date: string; amount: number }[],
  totalInvested: number
): DividendSummary {
  const totalDividends = dividendTransactions.reduce((s, t) => s + t.amount, 0);
  const dividendsByYear: Record<string, number> = {};
  const dividendsByMonth: Record<string, number> = {};

  for (const t of dividendTransactions) {
    const year = t.date.substring(0, 4);
    const month = t.date.substring(0, 7);
    dividendsByYear[year] = (dividendsByYear[year] ?? 0) + t.amount;
    dividendsByMonth[month] = (dividendsByMonth[month] ?? 0) + t.amount;
  }

  const months = Object.keys(dividendsByMonth).length || 1;
  return {
    totalDividends: Math.round(totalDividends * 100) / 100,
    dividendsByYear,
    dividendsByMonth,
    avgMonthlyDividend: Math.round((totalDividends / months) * 100) / 100,
    yieldOnCost: totalInvested > 0 ? Math.round((totalDividends / totalInvested) * 10000) / 100 : 0,
  };
}
