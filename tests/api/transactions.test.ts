import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockGetTransactions = vi.fn();
const mockGetTransactionCount = vi.fn();
const mockCreateTransaction = vi.fn();
const mockUpdateTransaction = vi.fn();
const mockDeleteTransaction = vi.fn();
vi.mock("@/lib/queries", () => ({
  getTransactions: (...args: unknown[]) => mockGetTransactions(...args),
  getTransactionCount: (...args: unknown[]) => mockGetTransactionCount(...args),
  createTransaction: (...args: unknown[]) => mockCreateTransaction(...args),
  updateTransaction: (...args: unknown[]) => mockUpdateTransaction(...args),
  deleteTransaction: (...args: unknown[]) => mockDeleteTransaction(...args),
}));

// B4 — bypass verifyOwnership; cross-tenant rejection in authz-ownership.test.ts.
vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => undefined),
  OwnershipError: class OwnershipError extends Error {
    constructor() { super("ownership"); }
  },
}));

import { GET, POST, PUT, DELETE } from "@/app/api/transactions/route";
import { requireAuth } from "@/lib/auth/require-auth";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

describe("API /api/transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        authenticated: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      });
      const req = createMockRequest("http://localhost:3000/api/transactions");
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it("returns transactions with total count", async () => {
      const txns = [{ id: 1, date: "2024-01-15", amount: -50, payee: "Store" }];
      mockGetTransactions.mockReturnValue(txns);
      mockGetTransactionCount.mockReturnValue(1);
      const req = createMockRequest("http://localhost:3000/api/transactions");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ data: txns, total: 1 });
    });

    it("passes filter params to query", async () => {
      mockGetTransactions.mockReturnValue([]);
      mockGetTransactionCount.mockReturnValue(0);
      const req = createMockRequest(
        "http://localhost:3000/api/transactions?startDate=2024-01-01&endDate=2024-12-31&accountId=1&categoryId=2&search=coffee&limit=50&offset=10"
      );
      await GET(req);
      expect(mockGetTransactions).toHaveBeenCalledWith("default", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountId: 1,
        categoryId: 2,
        search: "coffee",
        limit: 50,
        offset: 10,
      });
    });

    it("uses default limit and offset", async () => {
      mockGetTransactions.mockReturnValue([]);
      mockGetTransactionCount.mockReturnValue(0);
      const req = createMockRequest("http://localhost:3000/api/transactions");
      await GET(req);
      expect(mockGetTransactions).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({ limit: 100, offset: 0 })
      );
    });
  });

  describe("POST", () => {
    it("creates transaction with valid data", async () => {
      const tx = { id: 1, date: "2024-01-15", amount: -50, accountId: 1, categoryId: 1, currency: "CAD" };
      mockCreateTransaction.mockReturnValue(tx);
      const req = createMockRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        body: { date: "2024-01-15", amount: -50, accountId: 1, categoryId: 1, currency: "CAD" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(201);
      expect(data).toEqual(tx);
    });

    it("returns 400 for missing required fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        body: { date: "2024-01-15" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("accepts optional fields", async () => {
      const tx = { id: 2, date: "2024-01-15", amount: 100, accountId: 1, categoryId: 1, currency: "CAD", payee: "Employer", note: "Salary", tags: "income" };
      mockCreateTransaction.mockReturnValue(tx);
      const req = createMockRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        body: {
          date: "2024-01-15", amount: 100, accountId: 1, categoryId: 1,
          currency: "CAD", payee: "Employer", note: "Salary", tags: "income",
        },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });
  });

  describe("PUT", () => {
    it("updates transaction with valid data", async () => {
      const updated = { id: 1, amount: -75 };
      mockUpdateTransaction.mockReturnValue(updated);
      const req = createMockRequest("http://localhost:3000/api/transactions", {
        method: "PUT",
        body: { id: 1, amount: -75 },
      });
      const res = await PUT(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
      expect(mockUpdateTransaction).toHaveBeenCalledWith(1, "default", { amount: -75 });
    });

    it("returns 400 when id is missing", async () => {
      const req = createMockRequest("http://localhost:3000/api/transactions", {
        method: "PUT",
        body: { amount: -75 },
      });
      const res = await PUT(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes transaction by id", async () => {
      const req = createMockRequest("http://localhost:3000/api/transactions?id=5", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      expect(mockDeleteTransaction).toHaveBeenCalledWith(5, "default");
    });

    it("returns 400 when id is missing", async () => {
      const req = createMockRequest("http://localhost:3000/api/transactions", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 when id is 0", async () => {
      const req = createMockRequest("http://localhost:3000/api/transactions?id=0", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
