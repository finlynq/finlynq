import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

const mockGetCategories = vi.fn();
const mockCreateCategory = vi.fn();
const mockUpdateCategory = vi.fn();
const mockDeleteCategory = vi.fn();
vi.mock("@/lib/queries", () => ({
  getCategories: (...args: unknown[]) => mockGetCategories(...args),
  createCategory: (...args: unknown[]) => mockCreateCategory(...args),
  updateCategory: (...args: unknown[]) => mockUpdateCategory(...args),
  deleteCategory: (...args: unknown[]) => mockDeleteCategory(...args),
}));

vi.mock("@/db", () => ({ db: {}, schema: {} }));

// Only the DB-touching count is stubbed; the refusal-message builder stays real
// so the assertions below exercise the wording users actually see.
const mockGetCategoryDeleteBlockers = vi.fn();
vi.mock("@/lib/categories/delete-blockers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/categories/delete-blockers")>();
  return {
    ...actual,
    getCategoryDeleteBlockers: (...args: unknown[]) => mockGetCategoryDeleteBlockers(...args),
  };
});

/** A Postgres unique-violation as `pg` surfaces it. */
function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint,
  });
}

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

    it("returns 409, not 500, when the name is already taken", async () => {
      mockCreateCategory.mockRejectedValue(uniqueViolation("categories_user_name_lookup_uniq"));
      const req = createMockRequest("http://localhost:3000/api/categories", {
        method: "POST",
        body: { name: "Groceries", type: "E", group: "Food" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toMatch(/already have a category with that name/i);
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

    // Prod 2026-07-24 20:25 UTC: renaming onto an existing name 500'd.
    it("returns 409, not 500, when renaming onto an existing name", async () => {
      mockUpdateCategory.mockRejectedValue(uniqueViolation("categories_user_name_lookup_uniq"));
      const req = createMockRequest("http://localhost:3000/api/categories", {
        method: "PUT",
        body: { id: 1, name: "Groceries" },
      });
      const res = await PUT(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toMatch(/already have a category with that name/i);
    });

    it("still 500s on an unrelated unique violation", async () => {
      mockUpdateCategory.mockRejectedValue(uniqueViolation("some_other_uniq"));
      const req = createMockRequest("http://localhost:3000/api/categories", {
        method: "PUT",
        body: { id: 1, name: "Updated" },
      });
      const res = await PUT(req);
      expect(res.status).toBe(500);
    });
  });

  describe("DELETE", () => {
    it("deletes category with nothing referencing it", async () => {
      mockGetCategoryDeleteBlockers.mockResolvedValue([]);
      const req = createMockRequest("http://localhost:3000/api/categories?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
    });

    it("returns 409 when category has transactions", async () => {
      mockGetCategoryDeleteBlockers.mockResolvedValue([
        { table: "transactions", label: "transaction", count: 5 },
      ]);
      const req = createMockRequest("http://localhost:3000/api/categories?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toContain("5 transactions");
      expect(mockDeleteCategory).not.toHaveBeenCalled();
    });

    // Prod 2026-07-24 20:01 UTC: this case escaped as a raw budgets_category_id_fkey
    // 23503 because the handler only ever counted transactions.
    it("returns 409 when only a budget references the category", async () => {
      mockGetCategoryDeleteBlockers.mockResolvedValue([
        { table: "budgets", label: "budget", count: 1 },
      ]);
      const req = createMockRequest("http://localhost:3000/api/categories?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toContain("1 budget");
      expect(mockDeleteCategory).not.toHaveBeenCalled();
    });

    it("names every blocking table in one message", async () => {
      mockGetCategoryDeleteBlockers.mockResolvedValue([
        { table: "transactions", label: "transaction", count: 12 },
        { table: "budgets", label: "budget", count: 2 },
        { table: "subscriptions", label: "subscription", count: 1 },
      ]);
      const req = createMockRequest("http://localhost:3000/api/categories?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(409);
      expect((data as { error: string }).error).toContain(
        "12 transactions, 2 budgets and 1 subscription",
      );
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/categories", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
