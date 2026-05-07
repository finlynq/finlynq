import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "update", "delete", "values", "set", "returning"];
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
    transactionRules: { id: "id", name: "name", matchField: "matchField", matchType: "matchType", matchValue: "matchValue", assignCategoryId: "assignCategoryId", assignTags: "assignTags", renameTo: "renameTo", isActive: "isActive", priority: "priority", createdAt: "createdAt", userId: "userId" },
    categories: { id: "id", name: "name" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), asc: vi.fn(), and: vi.fn(), inArray: vi.fn() }));

// B4 — bypass verifyOwnership; cross-tenant rejection in authz-ownership.test.ts.
vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => undefined),
  OwnershipError: class OwnershipError extends Error {
    constructor() { super("ownership"); }
  },
}));

import { GET, POST, PUT, DELETE } from "@/app/api/rules/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns all rules", async () => {
      const rules = [{ id: 1, name: "Coffee", matchField: "payee", matchType: "contains", matchValue: "Starbucks", isActive: 1 }];
      mockDbChain.all!.mockReturnValueOnce(rules);
      const req = createMockRequest("http://localhost:3000/api/rules");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(rules);
    });
  });

  describe("POST", () => {
    it("creates a rule", async () => {
      const rule = { id: 1, name: "Coffee", matchField: "payee", matchType: "contains", matchValue: "Starbucks" };
      mockDbChain.get!.mockReturnValueOnce(rule);
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "POST",
        body: { name: "Coffee", matchField: "payee", matchType: "contains", matchValue: "Starbucks" },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("returns 400 for missing fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "POST",
        body: { name: "Test" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("PUT", () => {
    it("updates a rule", async () => {
      const rule = { id: 1, name: "Updated" };
      mockDbChain.get!.mockReturnValueOnce(rule);
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "PUT",
        body: { id: 1, name: "Updated" },
      });
      const res = await PUT(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });

    it("returns 404 when rule not found", async () => {
      mockDbChain.get!.mockReturnValueOnce(undefined);
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "PUT",
        body: { id: 999, name: "Missing" },
      });
      const res = await PUT(req);
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE", () => {
    it("deletes rule by id", async () => {
      const req = createMockRequest("http://localhost:3000/api/rules?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { data } = await parseResponse(res);
      expect(data).toEqual({ success: true });
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/rules", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
