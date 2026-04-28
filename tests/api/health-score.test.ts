import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockGetAccountBalances = vi.fn();
const mockGetIncomeVsExpenses = vi.fn();
const mockGetNetWorthOverTime = vi.fn();
const mockGetBudgets = vi.fn();
const mockGetSpendingByCategory = vi.fn();
vi.mock("@/lib/queries", () => ({
  getAccountBalances: (...a: unknown[]) => mockGetAccountBalances(...a),
  getIncomeVsExpenses: (...a: unknown[]) => mockGetIncomeVsExpenses(...a),
  getNetWorthOverTime: (...a: unknown[]) => mockGetNetWorthOverTime(...a),
  getBudgets: (...a: unknown[]) => mockGetBudgets(...a),
  getSpendingByCategory: (...a: unknown[]) => mockGetSpendingByCategory(...a),
}));

vi.mock("@/lib/age-of-money", () => ({
  calculateAgeOfMoney: vi.fn(() => ({ ageInDays: 15, trend: 2, history: [] })),
}));

import { GET } from "@/app/api/health-score/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/health-score", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccountBalances.mockReturnValue([]);
    mockGetIncomeVsExpenses.mockReturnValue([]);
    mockGetNetWorthOverTime.mockReturnValue([]);
    mockGetBudgets.mockReturnValue([]);
    mockGetSpendingByCategory.mockReturnValue([]);
  });

  it("returns health score structure", async () => {
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as { score: number; components: unknown[]; grade: string };
    expect(d).toHaveProperty("score");
    expect(d).toHaveProperty("components");
    expect(d).toHaveProperty("grade");
    expect(d.components).toHaveLength(6);
  });

  it("returns score between 0 and 100", async () => {
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { score: number };
    expect(d.score).toBeGreaterThanOrEqual(0);
    expect(d.score).toBeLessThanOrEqual(100);
  });

  it("calculates savings rate component", async () => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    mockGetIncomeVsExpenses.mockReturnValue([
      { month, type: "I", total: 5000 },
      { month, type: "E", total: -3000 },
    ]);
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { components: { name: string; score: number; detail: string }[] };
    const savingsRate = d.components.find((c) => c.name === "Savings Rate");
    expect(savingsRate).toBeDefined();
    expect(savingsRate!.detail).toContain("savings rate");
  });

  it("assigns correct grades", async () => {
    // With no data, most scores are neutral (50)
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { grade: string; score: number };
    expect(["Excellent", "Good", "Fair", "Needs Work"]).toContain(d.grade);
  });

  it("handles DTI with no debt", async () => {
    mockGetAccountBalances.mockReturnValue([
      { accountType: "A", accountGroup: "Banking", balance: 10000, currency: "CAD" },
    ]);
    const req = createMockRequest("http://localhost:3000/api/health-score");
    const res = await GET(req);
    const { data } = await parseResponse(res);
    const d = data as { components: { name: string; score: number; detail: string }[] };
    const dti = d.components.find((c) => c.name === "Debt-to-Income");
    expect(dti).toBeDefined();
  });
});
