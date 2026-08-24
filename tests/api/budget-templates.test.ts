import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

// Category display names are encrypted at rest; the route decrypts
// `categoryNameCt` into `categoryName` before responding.
const mockDecryptName = vi.fn();
vi.mock("@/lib/crypto/encrypted-columns", () => ({
  decryptName: (...a: unknown[]) => mockDecryptName(...a),
}));

const mockGetBudgetTemplates = vi.fn();
const mockCreateBudgetTemplate = vi.fn();
const mockDeleteBudgetTemplate = vi.fn();
vi.mock("@/lib/queries", () => ({
  getBudgetTemplates: (...a: unknown[]) => mockGetBudgetTemplates(...a),
  createBudgetTemplate: (...a: unknown[]) => mockCreateBudgetTemplate(...a),
  deleteBudgetTemplate: (...a: unknown[]) => mockDeleteBudgetTemplate(...a),
}));

import { GET, POST, DELETE } from "@/app/api/budget-templates/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/budget-templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptName.mockImplementation((ct: string | null) => (ct ? "Groceries" : null));
  });

  describe("GET", () => {
    it("returns all budget templates", async () => {
      // The fixture carries `categoryNameCt`, the shape `getBudgetTemplates`
      // actually returns. The previous fixture omitted it entirely, which is
      // how the missing decrypt survived a passing test (the same fiction that
      // hid GH #338 in the budgets route).
      mockGetBudgetTemplates.mockReturnValue([
        { id: 1, name: "Basic", categoryId: 1, categoryNameCt: "v1:abc:def:ghi", categoryGroup: "Personal", amount: 500, createdAt: "2024-01-01" },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budget-templates");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual([
        { id: 1, name: "Basic", categoryId: 1, categoryName: "Groceries", categoryGroup: "Personal", amount: 500, createdAt: "2024-01-01" },
      ]);
    });

    it("decrypts categoryNameCt and does not ship the ciphertext", async () => {
      mockGetBudgetTemplates.mockReturnValue([
        { id: 1, name: "Basic", categoryId: 7, categoryNameCt: "v1:abc:def:ghi", categoryGroup: "Personal", amount: 500, createdAt: "2024-01-01" },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budget-templates");
      const res = await GET(req);
      const { data } = await parseResponse(res);
      const row = (data as Array<Record<string, unknown>>)[0];
      expect(row.categoryName).toBe("Groceries");
      expect(row).not.toHaveProperty("categoryNameCt");
      expect(mockDecryptName).toHaveBeenCalledWith("v1:abc:def:ghi", expect.anything(), null);
    });

    it("falls back to 'Category #<id>' when the DEK cannot decrypt the name", async () => {
      // A cold DEK (server restart) or a DEK-less auth path (API key, OAuth
      // MCP) must still render an identifiable row, never an empty label.
      mockDecryptName.mockReturnValue(null);
      mockGetBudgetTemplates.mockReturnValue([
        { id: 1, name: "Basic", categoryId: 42, categoryNameCt: "v1:abc:def:ghi", categoryGroup: "Personal", amount: 500, createdAt: "2024-01-01" },
      ]);
      const req = createMockRequest("http://localhost:3000/api/budget-templates");
      const res = await GET(req);
      const { data } = await parseResponse(res);
      expect((data as Array<{ categoryName: string }>)[0].categoryName).toBe("Category #42");
    });
  });

  describe("POST", () => {
    it("creates a new template", async () => {
      const template = { id: 2, name: "Premium", categoryId: 1, amount: 1000, createdAt: "2024-01-01" };
      mockCreateBudgetTemplate.mockReturnValue(template);
      const req = createMockRequest("http://localhost:3000/api/budget-templates", {
        method: "POST",
        body: { name: "Premium", categoryId: 1, amount: 1000 },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("returns 400 for missing fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/budget-templates", {
        method: "POST",
        body: { name: "Test" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes template by id", async () => {
      const req = createMockRequest("http://localhost:3000/api/budget-templates?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { data } = await parseResponse(res);
      expect(data).toEqual({ success: true });
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/budget-templates", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
