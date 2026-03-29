import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "update", "delete", "values", "set", "returning", "groupBy", "limit", "offset"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
mockDbChain.get = vi.fn().mockReturnValue(undefined);
mockDbChain.run = vi.fn();

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    loans: { id: "id", name: "name", type: "type", accountId: "accountId", principal: "principal", annualRate: "annualRate", termMonths: "termMonths", startDate: "startDate", paymentAmount: "paymentAmount", paymentFrequency: "paymentFrequency", extraPayment: "extraPayment", note: "note" },
    accounts: { id: "id", name: "name" },
  },
}));

vi.mock("@/lib/require-unlock", () => ({
  requireUnlock: vi.fn(() => null),
}));

const mockGenerateAmortization = vi.fn();
const mockExtraPaymentImpact = vi.fn();
const mockDebtPayoff = vi.fn();
vi.mock("@/lib/loan-calculator", () => ({
  generateAmortizationSchedule: (...a: unknown[]) => mockGenerateAmortization(...a),
  calculateExtraPaymentImpact: (...a: unknown[]) => mockExtraPaymentImpact(...a),
  calculateDebtPayoff: (...a: unknown[]) => mockDebtPayoff(...a),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), sql: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(),
}));

import { GET, POST, DELETE } from "@/app/api/loans/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/loans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) {
      mockDbChain[m]!.mockReturnValue(mockDbChain);
    }
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns loans with amortization summary", async () => {
      mockDbChain.all!.mockReturnValueOnce([
        { id: 1, name: "Mortgage", type: "mortgage", principal: 300000, annualRate: 5, termMonths: 360, startDate: "2020-01-01", extraPayment: 0, paymentFrequency: "monthly", accountId: null, accountName: null, paymentAmount: null, note: "" },
      ]);
      mockGenerateAmortization.mockReturnValue({
        monthlyPayment: 1610.46,
        totalInterest: 279765.6,
        payoffDate: "2050-01-01",
        schedule: [
          { date: "2020-02-01", principal: 360.46, interest: 1250, balance: 299639.54, period: 1 },
        ],
      });

      const res = await GET();
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const loans = data as { monthlyPayment: number; totalInterest: number }[];
      expect(loans[0].monthlyPayment).toBe(1610.46);
      expect(loans[0].totalInterest).toBe(279765.6);
    });
  });

  describe("POST", () => {
    it("creates a new loan", async () => {
      const loan = { id: 1, name: "Car Loan", type: "loan", principal: 25000 };
      mockDbChain.get!.mockReturnValueOnce(loan);
      const req = createMockRequest("http://localhost:3000/api/loans", {
        method: "POST",
        body: { name: "Car Loan", type: "loan", principal: 25000, annualRate: 6, termMonths: 60, startDate: "2024-01-01" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("handles amortization action", async () => {
      const result = { monthlyPayment: 500, totalInterest: 5000, payoffDate: "2029-01-01", schedule: [] };
      mockGenerateAmortization.mockReturnValue(result);
      const req = createMockRequest("http://localhost:3000/api/loans", {
        method: "POST",
        body: { action: "amortization", principal: 25000, annualRate: 6, termMonths: 60, startDate: "2024-01-01" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(result);
    });

    it("handles what-if action", async () => {
      const result = [{ extra: 100, saved: 1000 }];
      mockExtraPaymentImpact.mockReturnValue(result);
      const req = createMockRequest("http://localhost:3000/api/loans", {
        method: "POST",
        body: { action: "what-if", principal: 25000, annualRate: 6, termMonths: 60, startDate: "2024-01-01" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });

    it("handles debt-payoff action", async () => {
      const payoffResult = { totalInterest: 5000, totalMonths: 24 };
      mockDebtPayoff.mockReturnValue(payoffResult);
      const req = createMockRequest("http://localhost:3000/api/loans", {
        method: "POST",
        body: { action: "debt-payoff", debts: [{ name: "CC", balance: 5000, rate: 20, minPayment: 100 }], extraBudget: 200 },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toHaveProperty("avalanche");
      expect(data).toHaveProperty("snowball");
    });

    it("returns 400 for invalid create data", async () => {
      const req = createMockRequest("http://localhost:3000/api/loans", {
        method: "POST",
        body: { name: "Test" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes loan by id", async () => {
      const req = createMockRequest("http://localhost:3000/api/loans?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { data } = await parseResponse(res);
      expect(data).toEqual({ success: true });
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/loans", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
