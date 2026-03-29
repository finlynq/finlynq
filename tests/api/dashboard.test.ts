import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockGetAccountBalances = vi.fn();
const mockGetIncomeVsExpenses = vi.fn();
const mockGetSpendingByCategory = vi.fn();
const mockGetNetWorthOverTime = vi.fn();
vi.mock("@/lib/queries", () => ({
  getAccountBalances: (...a: unknown[]) => mockGetAccountBalances(...a),
  getIncomeVsExpenses: (...a: unknown[]) => mockGetIncomeVsExpenses(...a),
  getSpendingByCategory: (...a: unknown[]) => mockGetSpendingByCategory(...a),
  getNetWorthOverTime: (...a: unknown[]) => mockGetNetWorthOverTime(...a),
}));

const mockGetRateMap = vi.fn();
const mockConvertWithRateMap = vi.fn();
vi.mock("@/lib/fx-service", () => ({
  getRateMap: (...a: unknown[]) => mockGetRateMap(...a),
  convertWithRateMap: (...a: unknown[]) => mockConvertWithRateMap(...a),
}));

import { GET } from "@/app/api/dashboard/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRateMap.mockResolvedValue(new Map([["CAD", 1], ["USD", 1.36]]));
    mockConvertWithRateMap.mockImplementation((amount: number) => amount);
    mockGetAccountBalances.mockReturnValue([]);
    mockGetIncomeVsExpenses.mockReturnValue([]);
    mockGetSpendingByCategory.mockReturnValue([]);
    mockGetNetWorthOverTime.mockReturnValue([]);
  });

  it("returns dashboard data structure", async () => {
    const req = createMockRequest("http://localhost:3000/api/dashboard");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d).toHaveProperty("displayCurrency");
    expect(d).toHaveProperty("balances");
    expect(d).toHaveProperty("incomeVsExpenses");
    expect(d).toHaveProperty("spendingByCategory");
    expect(d).toHaveProperty("netWorthOverTime");
  });

  it("defaults to CAD display currency", async () => {
    const req = createMockRequest("http://localhost:3000/api/dashboard");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect((data as { displayCurrency: string }).displayCurrency).toBe("CAD");
  });

  it("uses custom display currency", async () => {
    const req = createMockRequest("http://localhost:3000/api/dashboard?currency=USD");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    expect((data as { displayCurrency: string }).displayCurrency).toBe("USD");
    expect(mockGetRateMap).toHaveBeenCalledWith("USD");
  });

  it("converts account balances to display currency", async () => {
    mockGetAccountBalances.mockReturnValue([
      { accountId: 1, accountName: "Checking", accountType: "A", accountGroup: "Banking", currency: "CAD", balance: 1000 },
    ]);
    const req = createMockRequest("http://localhost:3000/api/dashboard");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { balances: { convertedBalance: number; displayCurrency: string }[] };
    expect(d.balances.length).toBe(1);
    expect(d.balances[0].displayCurrency).toBe("CAD");
  });

  it("consolidates multi-currency net worth", async () => {
    mockGetNetWorthOverTime.mockReturnValue([
      { month: "2024-01", currency: "CAD", cumulative: 5000 },
      { month: "2024-01", currency: "USD", cumulative: 3000 },
    ]);
    const req = createMockRequest("http://localhost:3000/api/dashboard");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { netWorthOverTime: { month: string }[] };
    // Should be consolidated into one entry per month
    expect(d.netWorthOverTime.length).toBe(1);
    expect(d.netWorthOverTime[0].month).toBe("2024-01");
  });

  it("accepts custom date range", async () => {
    const req = createMockRequest("http://localhost:3000/api/dashboard?startDate=2023-01-01&endDate=2023-12-31");
    await GET(req);
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith("default", "2023-01-01", "2023-12-31");
    expect(mockGetSpendingByCategory).toHaveBeenCalledWith("default", "2023-01-01", "2023-12-31");
  });
});
