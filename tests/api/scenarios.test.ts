import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockCalcMonthly = vi.fn(() => 500);
const mockGenAmort = vi.fn(() => ({ schedule: [{ period: 1, balance: 99500 }] }));
const mockDebtPayoff = vi.fn(() => ({ totalInterest: 1000, totalMonths: 12 }));
vi.mock("@/lib/loan-calculator", () => ({
  calculateMonthlyPayment: (...a: unknown[]) => mockCalcMonthly(...a),
  generateAmortizationSchedule: (...a: unknown[]) => mockGenAmort(...a),
  calculateDebtPayoff: (...a: unknown[]) => mockDebtPayoff(...a),
}));

import { POST } from "@/app/api/scenarios/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calculates home-purchase scenario", async () => {
    const req = createMockRequest("http://localhost:3000/api/scenarios", {
      method: "POST",
      body: {
        type: "home-purchase",
        purchasePrice: 500000,
        downPaymentPct: 20,
        interestRate: 5,
        amortizationYears: 25,
        propertyTaxYear: 4000,
        maintenanceYear: 3000,
      },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(d).toHaveProperty("downPayment");
    expect(d).toHaveProperty("principal");
    expect(d).toHaveProperty("monthlyPayment");
    expect(d).toHaveProperty("totalInterest");
    expect(d.downPayment).toBe(100000);
    expect(d.principal).toBe(400000);
  });

  it("calculates extra-savings scenario", async () => {
    const req = createMockRequest("http://localhost:3000/api/scenarios", {
      method: "POST",
      body: {
        type: "extra-savings",
        monthlySavings: 500,
        returnRate: 7,
        years: 10,
      },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as { futureValue: number; projections: unknown[] };
    expect(d).toHaveProperty("futureValue");
    expect(d).toHaveProperty("totalContributions");
    expect(d).toHaveProperty("totalGrowth");
    expect(d.projections.length).toBe(10);
  });

  it("calculates debt-payoff scenario", async () => {
    const req = createMockRequest("http://localhost:3000/api/scenarios", {
      method: "POST",
      body: {
        type: "debt-payoff",
        debts: [{ name: "CC", balance: 5000, rate: 20, minPayment: 100 }],
        extraBudget: 200,
      },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(data).toHaveProperty("avalanche");
    expect(data).toHaveProperty("snowball");
  });

  it("calculates income-change scenario", async () => {
    const req = createMockRequest("http://localhost:3000/api/scenarios", {
      method: "POST",
      body: {
        type: "income-change",
        currentIncome: 80000,
        newIncome: 100000,
        currentSavingsRate: 20,
      },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    const d = data as { current: Record<string, unknown>; new: Record<string, unknown>; difference: Record<string, unknown> };
    expect(d).toHaveProperty("current");
    expect(d).toHaveProperty("new");
    expect(d).toHaveProperty("difference");
  });

  it("returns 400 for unknown scenario type", async () => {
    const req = createMockRequest("http://localhost:3000/api/scenarios", {
      method: "POST",
      body: { type: "unknown-type" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
