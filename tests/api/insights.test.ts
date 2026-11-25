import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

// GH #457 — insights is no longer behind dev mode; no guard to mock.
const mockGetMonthlySpending = vi.fn();
const mockGetTransactions = vi.fn();
const mockGetMerchantSpendRows = vi.fn();
vi.mock("@/lib/queries", () => ({
  getMonthlySpending: (...a: unknown[]) => mockGetMonthlySpending(...a),
  getTransactions: (...a: unknown[]) => mockGetTransactions(...a),
  getMerchantSpendRows: (...a: unknown[]) => mockGetMerchantSpendRows(...a),
}));

// FINLYNQ-123 — insights converts each monthly-spending slice to the display
// currency. Mock fx-service so the route exercises the convert+collapse path
// deterministically (CAD→USD at 0.7175, USD identity).
vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: vi.fn(async () => "USD"),
  getRateMap: vi.fn(async () => new Map<string, number>([["USD", 1], ["CAD", 0.7175]])),
  // Used by convertReportingSlice's current-rate fallback (reporting-amount.ts).
  convertWithRateMap: vi.fn((amount: number, from: string, map: Map<string, number>) => amount * (map.get(from.toUpperCase()) ?? 1)),
}));

// detectAnomalies/analyzeTrends receive the COLLAPSED monthlyNorm rows; their
// mock.calls let a focused case assert the FX conversion + per-(month,category)
// collapse happened.
vi.mock("@/lib/spending-insights", () => ({
  detectAnomalies: vi.fn(() => [{ category: "Food", severity: "high" }]),
  comparePeriods: vi.fn(() => [{ category: "Food", trend: "rising" }]),
  merchantSpending: vi.fn(() => [{ payee: "Starbucks", totalSpent: 200 }]),
  spendingByDayOfWeek: vi.fn(() => [{ day: "Monday", total: -100 }]),
}));

vi.mock("@/lib/crypto/encrypted-columns", () => ({
  decryptName: vi.fn((_ct: string | null, _dek: Buffer | null) => "Food"),
}));

vi.mock("@/lib/currency", () => ({
  getCurrentMonth: vi.fn(() => "2024-01"),
}));

import { GET } from "@/app/api/insights/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/insights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMonthlySpending.mockReturnValue([]);
    mockGetTransactions.mockReturnValue([]);
    mockGetMerchantSpendRows.mockReturnValue([]);
  });

  it("returns insights structure", async () => {
    const req = createMockRequest("http://localhost:3000/api/insights");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d).toHaveProperty("anomalies");
    expect(d).toHaveProperty("trends");
    expect(d).toHaveProperty("topMerchants");
    expect(d).toHaveProperty("spendingByDay");
  });

  it("limits trends to 15 items", async () => {
    const { comparePeriods } = await import("@/lib/spending-insights");
    vi.mocked(comparePeriods).mockReturnValue(Array(20).fill({ category: "Test", group: "", trend: "rising", changePercent: 5, currentTotal: 1, previousTotal: 1 }));
    const req = createMockRequest("http://localhost:3000/api/insights");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { trends: unknown[] };
    expect(d.trends.length).toBeLessThanOrEqual(15);
  });

  it("limits merchants to 20 items", async () => {
    const { merchantSpending } = await import("@/lib/spending-insights");
    vi.mocked(merchantSpending).mockReturnValue(Array(25).fill({ payee: "Test", totalSpent: 100, count: 1, avgTransaction: 100 }));
    const req = createMockRequest("http://localhost:3000/api/insights");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { topMerchants: unknown[] };
    expect(d.topMerchants.length).toBeLessThanOrEqual(20);
  });

  // FINLYNQ-123 (tc-1, code) — monthly spending feeds anomaly/trend detection
  // as a FLOW figure: each (currency, reporting_currency) slice is converted to
  // the display currency (stored reporting_amount when it matches, else a
  // current-rate fallback) and collapsed per (month, category). A CAD-only
  // category must read in USD, not native C$, so FX swings don't look like
  // spikes.
  it("converts monthly spending to display currency before anomaly detection", async () => {
    const { detectAnomalies } = await import("@/lib/spending-insights");
    // One CAD slice whose stored reporting_amount is already USD (preferred),
    // and one CAD slice with NO stored reporting_amount (current-rate fallback
    // 1000 * 0.7175 = 717.5). Same (month, category) → collapse to one row.
    mockGetMonthlySpending.mockReturnValue([
      { month: "2024-01", categoryGroup: "Food", categoryNameCt: "ct", categoryType: "E", currency: "CAD", reportingCurrency: "USD", totalAmount: -1000, totalReporting: -700 },
      { month: "2024-01", categoryGroup: "Food", categoryNameCt: "ct", categoryType: "E", currency: "CAD", reportingCurrency: null, totalAmount: -1000, totalReporting: null },
      // GH #457 — an income category never reaches alerts or trends.
      { month: "2024-01", categoryGroup: "Pay", categoryNameCt: "ct", categoryType: "I", currency: "USD", reportingCurrency: "USD", totalAmount: 5000, totalReporting: 5000 },
    ]);
    const req = createMockRequest("http://localhost:3000/api/insights");
    const res = await GET(req);
    const { status } = await parseResponse(res);
    expect(status).toBe(200);

    // The collapsed monthlyNorm passed to detectAnomalies must carry the
    // display-currency total: 700 (stored) + 717.5 (fallback) = 1417.5, NOT the
    // raw native 2000 C$.
    const passed = vi.mocked(detectAnomalies).mock.calls[0]?.[0] as { month: string; categoryName: string; total: number }[];
    expect(passed).toHaveLength(1);
    expect(passed[0].month).toBe("2024-01");
    expect(passed[0].total).toBeCloseTo(1417.5, 2);
  });

  it("refuses an unknown period and names the choices", async () => {
    const res = await GET(createMockRequest("http://localhost:3000/api/insights?period=forever"));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain("last_3");
  });

  it("returns the period it covered", async () => {
    const res = await GET(createMockRequest("http://localhost:3000/api/insights?period=last_month"));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect((data as { period: { key: string } }).period.key).toBe("last_month");
    expect(mockGetMerchantSpendRows).toHaveBeenCalledTimes(1);
  });
});
