import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

// B4 — verifyOwnership runs a real DB query in the route. These existing
// tests don't seed accounts/categories, so bypass the helper here. The
// dedicated authz-ownership.test.ts covers the cross-tenant rejection path.
vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => undefined),
  OwnershipError: class OwnershipError extends Error {
    constructor() { super("ownership"); }
  },
}));

const mockGetBudgets = vi.fn();
const mockUpsertBudget = vi.fn();
const mockDeleteBudget = vi.fn();
const mockGetBudgetRollover = vi.fn();
const mockGetSpendingByCategoryAndCurrency = vi.fn();
vi.mock("@/lib/queries", () => ({
  getBudgets: (...a: unknown[]) => mockGetBudgets(...a),
  upsertBudget: (...a: unknown[]) => mockUpsertBudget(...a),
  deleteBudget: (...a: unknown[]) => mockDeleteBudget(...a),
  getBudgetRollover: (...a: unknown[]) => mockGetBudgetRollover(...a),
  getSpendingByCategoryAndCurrency: (...a: unknown[]) => mockGetSpendingByCategoryAndCurrency(...a),
}));

const mockGetRateMap = vi.fn();
const mockConvertWithRateMap = vi.fn();
vi.mock("@/lib/fx-service", () => ({
  getRateMap: (...a: unknown[]) => mockGetRateMap(...a),
  convertWithRateMap: (...a: unknown[]) => mockConvertWithRateMap(...a),
  // Routes call getDisplayCurrency to resolve `?currency=` against the user's
  // settings. The override-or-CAD fallback matches every existing test that
  // doesn't explicitly pass a currency.
  getDisplayCurrency: vi.fn(async (_userId: string, override: string | null) => override ?? "CAD"),
}));

// Category display names are encrypted at rest; the route decrypts
// `categoryNameCt` into `categoryName` for the budgets page to render.
const mockDecryptName = vi.fn();
vi.mock("@/lib/crypto/encrypted-columns", () => ({
  decryptName: (...a: unknown[]) => mockDecryptName(...a),
}));

import { GET, POST, DELETE } from "@/app/api/budgets/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/budgets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRateMap.mockResolvedValue(new Map([["CAD", 1]]));
    mockConvertWithRateMap.mockImplementation((amount: number) => amount);
    mockDecryptName.mockImplementation((ct: string | null) => (ct ? "Groceries" : null));
  });

  describe("GET", () => {
    it("returns budgets for a given month", async () => {
      const budgets = [
        { id: 1, categoryId: 1, categoryName: "Food", categoryGroup: "Essentials", month: "2024-01", amount: 500, currency: "CAD" },
      ];
      mockGetBudgets.mockReturnValue(budgets);
      const req = createMockRequest("http://localhost:3000/api/budgets?month=2024-01");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(mockGetBudgets).toHaveBeenCalledWith("default", "2024-01");
    });

    it("decrypts categoryNameCt into a plaintext categoryName", async () => {
      // Regression: the route previously shipped only the encrypted
      // `categoryNameCt`, so the budgets page — which renders
      // `b.categoryName` directly — showed every row with a blank label.
      mockGetBudgets.mockReturnValue([
        { id: 1, categoryId: 7, categoryNameCt: "v1:abc:def:ghi", categoryGroup: "Personal", month: "2024-01", amount: 500, currency: "CAD" },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budgets?month=2024-01");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect((data as Array<{ categoryName: string }>)[0].categoryName).toBe("Groceries");
      expect(mockDecryptName).toHaveBeenCalledWith("v1:abc:def:ghi", expect.anything(), null);
    });

    it("falls back to 'Category #<id>' when the DEK cannot decrypt the name", async () => {
      // A cold DEK (server restart) or a DEK-less auth path (API key, OAuth
      // MCP) must still render an identifiable row, never an empty label.
      mockDecryptName.mockReturnValue(null);
      mockGetBudgets.mockReturnValue([
        { id: 1, categoryId: 42, categoryNameCt: "v1:abc:def:ghi", categoryGroup: "Personal", month: "2024-01", amount: 500, currency: "CAD" },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budgets?month=2024-01");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect((data as Array<{ categoryName: string }>)[0].categoryName).toBe("Category #42");
    });

    it("includes spending data when requested", async () => {
      mockGetBudgets.mockReturnValue([
        { id: 1, categoryId: 1, month: "2024-01", amount: 500, currency: "CAD" },
      ]);
      mockGetSpendingByCategoryAndCurrency.mockReturnValue([
        { categoryId: 1, total: -300, currency: "CAD" },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budgets?month=2024-01&spending=1");
      const res = await GET(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
      expect(mockGetSpendingByCategoryAndCurrency).toHaveBeenCalled();
    });

    it("includes rollover data when requested", async () => {
      mockGetBudgets.mockReturnValue([
        { id: 1, categoryId: 1, month: "2024-02", amount: 500, currency: "CAD" },
      ]);
      mockGetBudgetRollover.mockReturnValue([
        { categoryId: 1, rolloverAmount: 50 },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budgets?month=2024-02&rollover=1");
      const res = await GET(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
      expect(mockGetBudgetRollover).toHaveBeenCalledWith("default", "2024-02");
    });

    it("returns budgets with display currency conversion", async () => {
      mockGetBudgets.mockReturnValue([
        { id: 1, categoryId: 1, month: "2024-01", amount: 500, currency: "USD" },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budgets?month=2024-01&currency=EUR");
      await GET(req);
      // getRateMap signature is (displayCurrency, userId) per Stream D rate caching.
      expect(mockGetRateMap).toHaveBeenCalledWith("EUR", "default");
    });
  });

  describe("POST", () => {
    it("creates or updates a budget", async () => {
      const budget = { id: 1, categoryId: 1, month: "2024-01", amount: 500 };
      mockUpsertBudget.mockReturnValue(budget);
      const req = createMockRequest("http://localhost:3000/api/budgets", {
        method: "POST",
        body: { categoryId: 1, month: "2024-01", amount: 500 },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("returns 400 for missing fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/budgets", {
        method: "POST",
        body: { categoryId: 1 },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes budget by id", async () => {
      const req = createMockRequest("http://localhost:3000/api/budgets?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/budgets", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
