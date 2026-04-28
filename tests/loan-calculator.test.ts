import { describe, it, expect } from "vitest";
import {
  calculateMonthlyPayment,
  generateAmortizationSchedule,
  calculateDebtPayoff,
  calculateExtraPaymentImpact,
} from "@/lib/loan-calculator";

describe("calculateMonthlyPayment", () => {
  it("computes correct payment for standard mortgage", () => {
    // $300,000 at 5% for 30 years (360 months)
    const payment = calculateMonthlyPayment(300000, 5, 360);
    expect(payment).toBeCloseTo(1610.46, 0);
  });

  it("handles 0% interest rate", () => {
    const payment = calculateMonthlyPayment(12000, 0, 12);
    expect(payment).toBe(1000);
  });

  it("handles short-term loan", () => {
    // $1,000 at 12% for 12 months
    const payment = calculateMonthlyPayment(1000, 12, 12);
    expect(payment).toBeCloseTo(88.85, 0);
  });
});

describe("generateAmortizationSchedule", () => {
  it("generates correct number of periods for simple loan", () => {
    const result = generateAmortizationSchedule(12000, 0, 12, "2024-01-01");
    expect(result.schedule.length).toBeLessThanOrEqual(12);
    expect(result.monthlyPayment).toBe(1000);
  });

  it("ends with zero balance", () => {
    const result = generateAmortizationSchedule(10000, 5, 60, "2024-01-01");
    const lastRow = result.schedule[result.schedule.length - 1];
    expect(lastRow.balance).toBe(0);
  });

  it("total payments = monthly * periods (approx for 0% rate)", () => {
    const result = generateAmortizationSchedule(12000, 0, 12, "2024-01-01");
    expect(result.totalPayments).toBeCloseTo(12000, 0);
    expect(result.totalInterest).toBeCloseTo(0, 0);
  });

  it("total interest is positive for non-zero rates", () => {
    const result = generateAmortizationSchedule(100000, 6, 120, "2024-01-01");
    expect(result.totalInterest).toBeGreaterThan(0);
  });

  it("extra payments reduce total interest and schedule length", () => {
    const baseline = generateAmortizationSchedule(100000, 6, 360, "2024-01-01", 0);
    const withExtra = generateAmortizationSchedule(100000, 6, 360, "2024-01-01", 200);
    expect(withExtra.schedule.length).toBeLessThan(baseline.schedule.length);
    expect(withExtra.totalInterest).toBeLessThan(baseline.totalInterest);
  });

  it("each row has principal + interest = payment (approx)", () => {
    const result = generateAmortizationSchedule(50000, 5, 60, "2024-01-01");
    for (const row of result.schedule) {
      const computed = row.interest + row.principal;
      expect(computed).toBeCloseTo(row.payment, 1);
    }
  });
});

describe("calculateDebtPayoff", () => {
  const debts = [
    { id: 1, name: "Credit Card", balance: 5000, rate: 22, minPayment: 100 },
    { id: 2, name: "Car Loan", balance: 15000, rate: 5, minPayment: 300 },
    { id: 3, name: "Student Loan", balance: 20000, rate: 6, minPayment: 200 },
  ];

  it("avalanche pays off highest-rate first", () => {
    const result = calculateDebtPayoff(debts, 200, "avalanche");
    expect(result.strategy).toBe("avalanche");
    expect(result.order[0].name).toBe("Credit Card");
    expect(result.totalMonths).toBeGreaterThan(0);
    expect(result.totalInterest).toBeGreaterThan(0);
  });

  it("snowball pays off smallest-balance first", () => {
    const result = calculateDebtPayoff(debts, 200, "snowball");
    expect(result.strategy).toBe("snowball");
    expect(result.order[0].name).toBe("Credit Card"); // smallest balance
  });

  it("avalanche saves more interest than snowball", () => {
    const avalanche = calculateDebtPayoff(debts, 200, "avalanche");
    const snowball = calculateDebtPayoff(debts, 200, "snowball");
    expect(avalanche.totalInterest).toBeLessThanOrEqual(snowball.totalInterest);
  });

  it("all debts are eventually paid off", () => {
    const result = calculateDebtPayoff(debts, 200, "avalanche");
    expect(result.order).toHaveLength(3);
    result.order.forEach((o) => expect(o.paidOffMonth).toBeGreaterThan(0));
  });
});

describe("calculateExtraPaymentImpact", () => {
  it("returns impact for each extra payment amount", () => {
    const impacts = calculateExtraPaymentImpact(100000, 6, 360, "2024-01-01", [0, 100, 500]);
    expect(impacts).toHaveLength(3);
    expect(impacts[0].monthsSaved).toBe(0);
    expect(impacts[0].interestSaved).toBe(0);
  });

  it("more extra payment = more savings", () => {
    const impacts = calculateExtraPaymentImpact(100000, 6, 360, "2024-01-01", [100, 200, 500]);
    expect(impacts[1].interestSaved).toBeGreaterThan(impacts[0].interestSaved);
    expect(impacts[2].interestSaved).toBeGreaterThan(impacts[1].interestSaved);
    expect(impacts[1].monthsSaved).toBeGreaterThanOrEqual(impacts[0].monthsSaved);
  });
});
