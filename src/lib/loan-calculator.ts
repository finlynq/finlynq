// Feature 1: Loan & Amortization Calculator
// Feature 12: Debt Payoff Planner

export type AmortizationRow = {
  period: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  extraPayment: number;
  balance: number;
};

export type LoanSummary = {
  monthlyPayment: number;
  totalPayments: number;
  totalInterest: number;
  payoffDate: string;
  schedule: AmortizationRow[];
};

export function calculateMonthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  const r = annualRate / 100 / 12;
  if (r === 0) return principal / termMonths;
  return (principal * r * Math.pow(1 + r, termMonths)) / (Math.pow(1 + r, termMonths) - 1);
}

export function generateAmortizationSchedule(
  principal: number,
  annualRate: number,
  termMonths: number,
  startDate: string,
  extraPayment: number = 0,
  paymentFrequency: string = "monthly"
): LoanSummary {
  const r = annualRate / 100 / 12;
  const payment = calculateMonthlyPayment(principal, annualRate, termMonths);
  const schedule: AmortizationRow[] = [];
  let balance = principal;
  let totalInterest = 0;
  let totalPayments = 0;
  const start = new Date(startDate + "T00:00:00");

  for (let i = 1; balance > 0.01 && i <= termMonths + 120; i++) {
    const interest = balance * r;
    let principalPortion = payment - interest + extraPayment;
    if (principalPortion > balance) principalPortion = balance;

    const actualPayment = interest + principalPortion;
    balance -= principalPortion;
    totalInterest += interest;
    totalPayments += actualPayment;

    const date = new Date(start);
    if (paymentFrequency === "biweekly") {
      date.setDate(date.getDate() + i * 14);
    } else {
      date.setMonth(date.getMonth() + i);
    }

    schedule.push({
      period: i,
      date: date.toISOString().split("T")[0],
      payment: Math.round(actualPayment * 100) / 100,
      principal: Math.round(principalPortion * 100) / 100,
      interest: Math.round(interest * 100) / 100,
      extraPayment: Math.round(Math.min(extraPayment, principalPortion) * 100) / 100,
      balance: Math.round(Math.max(balance, 0) * 100) / 100,
    });

    if (balance <= 0.01) break;
  }

  const lastRow = schedule[schedule.length - 1];
  return {
    monthlyPayment: Math.round(payment * 100) / 100,
    totalPayments: Math.round(totalPayments * 100) / 100,
    totalInterest: Math.round(totalInterest * 100) / 100,
    payoffDate: lastRow?.date ?? startDate,
    schedule,
  };
}

// Feature 12: Debt payoff strategies
export type Debt = {
  id: number;
  name: string;
  balance: number;
  rate: number;
  minPayment: number;
};

export type PayoffPlan = {
  strategy: string;
  totalInterest: number;
  totalMonths: number;
  order: { name: string; paidOffMonth: number }[];
};

export function calculateDebtPayoff(debts: Debt[], extraBudget: number, strategy: "avalanche" | "snowball"): PayoffPlan {
  const sorted = [...debts].sort((a, b) =>
    strategy === "avalanche" ? b.rate - a.rate : a.balance - b.balance
  );

  const balances = new Map(sorted.map((d) => [d.name, d.balance]));
  const order: { name: string; paidOffMonth: number }[] = [];
  let totalInterest = 0;
  let month = 0;
  let extra = extraBudget;

  while (Array.from(balances.values()).some((b) => b > 0.01) && month < 600) {
    month++;
    let availableExtra = extra;

    for (const debt of sorted) {
      const bal = balances.get(debt.name) ?? 0;
      if (bal <= 0.01) continue;

      const interest = (bal * debt.rate) / 100 / 12;
      totalInterest += interest;
      let payment = debt.minPayment;

      // First non-zero debt gets the extra
      if (sorted.find((d) => (balances.get(d.name) ?? 0) > 0.01)?.name === debt.name) {
        payment += availableExtra;
        availableExtra = 0;
      }

      const newBal = Math.max(bal + interest - payment, 0);
      balances.set(debt.name, newBal);

      if (newBal <= 0.01 && !order.find((o) => o.name === debt.name)) {
        order.push({ name: debt.name, paidOffMonth: month });
        extra += debt.minPayment;
      }
    }
  }

  return {
    strategy,
    totalInterest: Math.round(totalInterest * 100) / 100,
    totalMonths: month,
    order,
  };
}

// What-if scenario: extra payment impact
export function calculateExtraPaymentImpact(
  principal: number,
  annualRate: number,
  termMonths: number,
  startDate: string,
  extraAmounts: number[]
) {
  return extraAmounts.map((extra) => {
    const result = generateAmortizationSchedule(principal, annualRate, termMonths, startDate, extra);
    const baseline = generateAmortizationSchedule(principal, annualRate, termMonths, startDate, 0);
    return {
      extraPayment: extra,
      monthsSaved: baseline.schedule.length - result.schedule.length,
      interestSaved: Math.round((baseline.totalInterest - result.totalInterest) * 100) / 100,
      newPayoffDate: result.payoffDate,
      totalInterest: result.totalInterest,
    };
  });
}
