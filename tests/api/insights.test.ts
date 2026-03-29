import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-unlock", () => ({ requireUnlock: vi.fn(() => null) }));

const mockGetMonthlySpending = vi.fn();
const mockGetTransactions = vi.fn();
vi.mock("@/lib/queries", () => ({
  getMonthlySpending: (...a: unknown[]) => mockGetMonthlySpending(...a),
  getTransactions: (...a: unknown[]) => mockGetTransactions(...a),
}));

vi.mock("@/lib/spending-insights", () => ({
  detectAnomalies: vi.fn(() => [{ category: "Food", severity: "high" }]),
  analyzeTrends: vi.fn(() => [{ category: "Food", direction: "up" }]),
  analyzeMerchants: vi.fn(() => [{ payee: "Starbucks", total: -200 }]),
  spendingByDayOfWeek: vi.fn(() => [{ day: "Monday", total: -100 }]),
}));

vi.mock("@/lib/currency", () => ({
  getCurrentMonth: vi.fn(() => "2024-01"),
}));

import { GET } from "@/app/api/insights/route";
import { parseResponse } from "../helpers/api-test-utils";

describe("API /api/insights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMonthlySpending.mockReturnValue([]);
    mockGetTransactions.mockReturnValue([]);
  });

  it("returns insights structure", async () => {
    const res = await GET();
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d).toHaveProperty("anomalies");
    expect(d).toHaveProperty("trends");
    expect(d).toHaveProperty("topMerchants");
    expect(d).toHaveProperty("spendingByDay");
  });

  it("limits trends to 15 items", async () => {
    const { analyzeTrends } = await import("@/lib/spending-insights");
    vi.mocked(analyzeTrends).mockReturnValue(Array(20).fill({ category: "Test", direction: "up" }));
    const res = await GET();
    const { data } = await parseResponse(res);
    const d = data as { trends: unknown[] };
    expect(d.trends.length).toBeLessThanOrEqual(15);
  });

  it("limits merchants to 20 items", async () => {
    const { analyzeMerchants } = await import("@/lib/spending-insights");
    vi.mocked(analyzeMerchants).mockReturnValue(Array(25).fill({ payee: "Test", total: -100 }));
    const res = await GET();
    const { data } = await parseResponse(res);
    const d = data as { topMerchants: unknown[] };
    expect(d.topMerchants.length).toBeLessThanOrEqual(20);
  });
});
