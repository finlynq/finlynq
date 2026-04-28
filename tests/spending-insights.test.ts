import { describe, it, expect } from "vitest";
import { detectAnomalies, analyzeTrends, analyzeMerchants, spendingByDayOfWeek } from "@/lib/spending-insights";

describe("detectAnomalies", () => {
  it("detects spending anomalies above 30% of average", () => {
    const spending = [
      { month: "2024-01", categoryName: "Food", categoryGroup: "Essentials", total: -300 },
      { month: "2024-02", categoryName: "Food", categoryGroup: "Essentials", total: -320 },
      { month: "2024-03", categoryName: "Food", categoryGroup: "Essentials", total: -280 },
      { month: "2024-04", categoryName: "Food", categoryGroup: "Essentials", total: -500 },
    ];
    const anomalies = detectAnomalies(spending, "2024-04");
    expect(anomalies.length).toBe(1);
    expect(anomalies[0].category).toBe("Food");
    expect(anomalies[0].percentAbove).toBeGreaterThan(30);
  });

  it("assigns severity based on percent above", () => {
    const spending = [
      { month: "2024-01", categoryName: "Shopping", categoryGroup: "Discretionary", total: -100 },
      { month: "2024-02", categoryName: "Shopping", categoryGroup: "Discretionary", total: -100 },
      { month: "2024-03", categoryName: "Shopping", categoryGroup: "Discretionary", total: -100 },
      { month: "2024-04", categoryName: "Shopping", categoryGroup: "Discretionary", total: -200 },
    ];
    const anomalies = detectAnomalies(spending, "2024-04");
    expect(anomalies[0].severity).toBe("alert"); // 100% above, > 50% threshold
  });

  it("returns empty for normal spending", () => {
    const spending = [
      { month: "2024-01", categoryName: "Food", categoryGroup: "E", total: -300 },
      { month: "2024-02", categoryName: "Food", categoryGroup: "E", total: -310 },
      { month: "2024-03", categoryName: "Food", categoryGroup: "E", total: -290 },
      { month: "2024-04", categoryName: "Food", categoryGroup: "E", total: -320 },
    ];
    const anomalies = detectAnomalies(spending, "2024-04");
    expect(anomalies.length).toBe(0);
  });

  it("requires at least 2 previous months", () => {
    const spending = [
      { month: "2024-01", categoryName: "Food", categoryGroup: "E", total: -100 },
      { month: "2024-02", categoryName: "Food", categoryGroup: "E", total: -1000 },
    ];
    expect(detectAnomalies(spending, "2024-02")).toEqual([]);
  });

  it("sorts by percentAbove descending", () => {
    const spending = [
      { month: "2024-01", categoryName: "A", categoryGroup: "E", total: -100 },
      { month: "2024-02", categoryName: "A", categoryGroup: "E", total: -100 },
      { month: "2024-03", categoryName: "A", categoryGroup: "E", total: -100 },
      { month: "2024-04", categoryName: "A", categoryGroup: "E", total: -200 },
      { month: "2024-01", categoryName: "B", categoryGroup: "E", total: -100 },
      { month: "2024-02", categoryName: "B", categoryGroup: "E", total: -100 },
      { month: "2024-03", categoryName: "B", categoryGroup: "E", total: -100 },
      { month: "2024-04", categoryName: "B", categoryGroup: "E", total: -300 },
    ];
    const anomalies = detectAnomalies(spending, "2024-04");
    expect(anomalies[0].category).toBe("B");
  });
});

describe("analyzeTrends", () => {
  it("detects rising trends", () => {
    const spending = [
      { month: "2024-01", categoryName: "Food", categoryGroup: "E", total: -100 },
      { month: "2024-02", categoryName: "Food", categoryGroup: "E", total: -110 },
      { month: "2024-03", categoryName: "Food", categoryGroup: "E", total: -120 },
      { month: "2024-04", categoryName: "Food", categoryGroup: "E", total: -150 },
      { month: "2024-05", categoryName: "Food", categoryGroup: "E", total: -160 },
      { month: "2024-06", categoryName: "Food", categoryGroup: "E", total: -170 },
    ];
    const trends = analyzeTrends(spending);
    expect(trends[0].trend).toBe("rising");
  });

  it("detects stable trends", () => {
    const spending = [
      { month: "2024-01", categoryName: "Food", categoryGroup: "E", total: -100 },
      { month: "2024-02", categoryName: "Food", categoryGroup: "E", total: -102 },
      { month: "2024-03", categoryName: "Food", categoryGroup: "E", total: -98 },
      { month: "2024-04", categoryName: "Food", categoryGroup: "E", total: -101 },
      { month: "2024-05", categoryName: "Food", categoryGroup: "E", total: -99 },
      { month: "2024-06", categoryName: "Food", categoryGroup: "E", total: -100 },
    ];
    const trends = analyzeTrends(spending);
    expect(trends[0].trend).toBe("stable");
  });

  it("requires at least 3 data points", () => {
    const spending = [
      { month: "2024-01", categoryName: "Food", categoryGroup: "E", total: -100 },
      { month: "2024-02", categoryName: "Food", categoryGroup: "E", total: -200 },
    ];
    expect(analyzeTrends(spending)).toEqual([]);
  });
});

describe("analyzeMerchants", () => {
  it("aggregates spending by merchant", () => {
    const txns = [
      { payee: "Starbucks", amount: -5 },
      { payee: "Starbucks", amount: -6 },
      { payee: "McDonald's", amount: -10 },
    ];
    const merchants = analyzeMerchants(txns);
    expect(merchants[0].payee).toBe("Starbucks");
    expect(merchants[0].totalSpent).toBe(11);
    expect(merchants[0].count).toBe(2);
    expect(merchants[0].avgTransaction).toBe(5.5);
  });

  it("sorts by total spent descending", () => {
    const txns = [
      { payee: "A", amount: -5 },
      { payee: "B", amount: -20 },
    ];
    const merchants = analyzeMerchants(txns);
    expect(merchants[0].payee).toBe("B");
  });

  it("skips empty payees", () => {
    const txns = [
      { payee: "", amount: -5 },
      { payee: "Store", amount: -10 },
    ];
    const merchants = analyzeMerchants(txns);
    expect(merchants.length).toBe(1);
  });
});

describe("spendingByDayOfWeek", () => {
  it("aggregates by day of week", () => {
    const txns = [
      { date: "2024-01-15", amount: -50 }, // Monday
      { date: "2024-01-16", amount: -30 }, // Tuesday
      { date: "2024-01-22", amount: -40 }, // Monday
    ];
    const result = spendingByDayOfWeek(txns);
    expect(result.length).toBe(7);
    const monday = result.find((r) => r.day === "Monday")!;
    expect(monday.total).toBe(90);
    expect(monday.count).toBe(2);
    expect(monday.avg).toBe(45);
  });

  it("ignores income transactions", () => {
    const txns = [
      { date: "2024-01-15", amount: 5000 }, // income
      { date: "2024-01-15", amount: -50 },  // expense
    ];
    const result = spendingByDayOfWeek(txns);
    const monday = result.find((r) => r.day === "Monday")!;
    expect(monday.total).toBe(50);
    expect(monday.count).toBe(1);
  });

  it("returns zero for days with no spending", () => {
    const result = spendingByDayOfWeek([]);
    for (const day of result) {
      expect(day.total).toBe(0);
      expect(day.count).toBe(0);
      expect(day.avg).toBe(0);
    }
  });
});
