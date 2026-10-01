// Savings-rate display shared by the Reports hub, Income statement and Trends.
// The server returns savingsRate = 0 when there is no income, which rendered
// as a green "0%" — a rate is undefined without income, so show "—" instead.

export interface SavingsRateDisplay {
  text: string;
  tone: "pos" | "neg" | "default";
}

export function formatSavingsRate(totalIncome: number, savingsRate: number): SavingsRateDisplay {
  if (!(totalIncome > 0) || !Number.isFinite(savingsRate)) return { text: "—", tone: "default" };
  return { text: `${savingsRate.toFixed(0)}%`, tone: savingsRate >= 0 ? "pos" : "neg" };
}
