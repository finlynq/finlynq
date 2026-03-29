import { describe, it, expect } from "vitest";
import { detectRecurringTransactions, forecastCashFlow } from "@/lib/recurring-detector";

function makeTxn(id: number, date: string, payee: string, amount: number) {
  return { id, date, payee, amount, accountId: 1, categoryId: 1 };
}

describe("detectRecurringTransactions", () => {
  it("detects monthly recurring transactions", () => {
    const txns = [
      makeTxn(1, "2024-01-15", "Netflix", -15.99),
      makeTxn(2, "2024-02-15", "Netflix", -15.99),
      makeTxn(3, "2024-03-15", "Netflix", -15.99),
      makeTxn(4, "2024-04-15", "Netflix", -15.99),
    ];
    const result = detectRecurringTransactions(txns);
    expect(result.length).toBe(1);
    expect(result[0].payee).toBe("Netflix");
    expect(result[0].frequency).toBe("monthly");
    expect(result[0].avgAmount).toBe(-15.99);
    expect(result[0].count).toBe(4);
  });

  it("detects weekly recurring transactions", () => {
    const txns = [];
    for (let i = 0; i < 5; i++) {
      txns.push(makeTxn(i, `2024-01-${String(1 + i * 7).padStart(2, "0")}`, "Gym", -10));
    }
    const result = detectRecurringTransactions(txns);
    expect(result.length).toBe(1);
    expect(result[0].frequency).toBe("weekly");
  });

  it("rejects inconsistent amounts (>20% variance)", () => {
    const txns = [
      makeTxn(1, "2024-01-15", "Store", -50),
      makeTxn(2, "2024-02-15", "Store", -200),
      makeTxn(3, "2024-03-15", "Store", -10),
    ];
    const result = detectRecurringTransactions(txns);
    expect(result.length).toBe(0);
  });

  it("requires at least 3 transactions", () => {
    const txns = [
      makeTxn(1, "2024-01-15", "Netflix", -15.99),
      makeTxn(2, "2024-02-15", "Netflix", -15.99),
    ];
    expect(detectRecurringTransactions(txns)).toEqual([]);
  });

  it("skips empty payees", () => {
    const txns = [
      makeTxn(1, "2024-01-15", "", -100),
      makeTxn(2, "2024-02-15", "", -100),
      makeTxn(3, "2024-03-15", "", -100),
    ];
    expect(detectRecurringTransactions(txns)).toEqual([]);
  });

  it("calculates next date", () => {
    const txns = [
      makeTxn(1, "2024-01-15", "Netflix", -15.99),
      makeTxn(2, "2024-02-15", "Netflix", -15.99),
      makeTxn(3, "2024-03-15", "Netflix", -15.99),
    ];
    const result = detectRecurringTransactions(txns);
    expect(result[0].nextDate).toBe("2024-04-15");
  });

  it("sorts by absolute amount descending", () => {
    const txns = [
      makeTxn(1, "2024-01-15", "Small", -10),
      makeTxn(2, "2024-02-15", "Small", -10),
      makeTxn(3, "2024-03-15", "Small", -10),
      makeTxn(4, "2024-01-15", "Big", -100),
      makeTxn(5, "2024-02-15", "Big", -100),
      makeTxn(6, "2024-03-15", "Big", -100),
    ];
    const result = detectRecurringTransactions(txns);
    expect(result[0].payee).toBe("Big");
  });
});

describe("forecastCashFlow", () => {
  it("forecasts balance over time", () => {
    const recurring = [{
      payee: "Salary",
      avgAmount: 5000,
      frequency: "monthly" as const,
      count: 6,
      lastDate: "2024-01-01",
      nextDate: "2024-02-01",
      accountId: 1,
      categoryId: 1,
      transactions: [],
    }];
    const forecast = forecastCashFlow(recurring, 10000, 60);
    expect(forecast.length).toBeGreaterThan(0);
    // Balance should grow with income
    const lastEntry = forecast[forecast.length - 1];
    expect(lastEntry.balance).toBeGreaterThan(10000);
  });

  it("handles empty recurring list", () => {
    const forecast = forecastCashFlow([], 10000, 30);
    expect(forecast).toEqual([]);
  });
});
