import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

const mockGetCategories = vi.fn();
const mockCreateCategory = vi.fn();
const mockUpdateCategory = vi.fn();
const mockDeleteCategory = vi.fn();
const mockGetTransactionCountByCategory = vi.fn();
vi.mock("@/lib/queries", () => ({
  getCategories: (...args: unknown[]) => mockGetCategories(...args),
  createCategory: (...args: unknown[]) => mockCreateCategory(...args),
  updateCategory: (...args: unknown[]) => mockUpdateCategory(...args),
  deleteCategory: (...args: unknown[]) => mockDeleteCategory(...args),
  getTransactionCountByCategory: (...args: unknown[]) => mockGetTransactionCountByCategory(...args),
}));

import { GET, POST, PUT, DELETE } from "@/app/api/categories/route";
import { requireAuth } from "@/lib/auth/require-auth";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";
import { NextResponse } from "next/server";

describe("API /api/categories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      vi.mocked(requireAuth).mockResolvedValueOnce({
        authenticated: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      });
      const req = createMockRequest("http://localhost:3000/api/categories");
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it("returns all categories", async () => {
      const cats = [
        { id: 1, type: "E", group: "Food", name: "Groceries" },
        { id: 2, type: "I", group: "Income", name: "Salary" },
      ];
      mockGetCategories.mockReturnValue(cats);
      const req = createMockRequest("http://localhost:3000/api/categories");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(cats);
    });
  });

  describe("POST", () => {
    it("creates category with valid data", async () => {
      const cat = { id: 3, name: "Dining", type: "E", group: "Food" };
      mockCreateCategory.mockReturnValue(cat);
      const req = createMockRequest("http://localhost:3000/api/categories", {
        method: "POST",
        body: { name: "Dining", type: "E", group: "Food" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(201);
      expect(data).toEqual(cat);
    });

    it("returns 400 for missing fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/categories", {
        method: "POST",
        body: { name: "Test" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("PUT", () => {
    it("updates category", async () => {
      const updated = { id: 1, name: "Updated" };
      mockUpdateCategory.mockReturnValue(updated);
      const req = createMockRequest("http://localhost:3000/api/categories", {
        method: "PUT",
        body: { id: 1, name: "Updated" },
      });
      const res = await PUT(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/categories", {
        method: "PUT",
        body: { name: "Updated" },
      });
      const res = await PUT(req);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE", () => {
    it("deletes category with no transactions", async () => {
      mockGetTransactionCountByCategory.mockReturnValue(0);
      const req = createMockRequest("http://localhost:3000/api/categories?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
    });

    it("returns 409 when category has transactions", async () => {
      mockGetTransactionCountByCategory.mockReturnValue(5);
      const req = createMockRequest("http://localhost:3000/api/categories?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toContain("5 transactions");
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/categories", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
