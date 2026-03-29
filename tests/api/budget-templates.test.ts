import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
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
  });

  describe("GET", () => {
    it("returns all budget templates", async () => {
      const templates = [
        { id: 1, name: "Basic", categoryId: 1, amount: 500, createdAt: "2024-01-01" },
      ];
      mockGetBudgetTemplates.mockReturnValue(templates);
      const req = createMockRequest("http://localhost:3000/api/budget-templates");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(templates);
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
