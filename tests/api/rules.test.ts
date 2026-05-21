/**
 * FINLYNQ-84 — API /api/rules tests rewritten for v2 (JSONB conditions+actions).
 *
 * The mock surface is intentionally minimal: we just want to confirm route
 * shape, validation gates, and ownership-error mapping. End-to-end Zod
 * coverage lives in the schema unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = [
  "select", "from", "where", "orderBy", "leftJoin", "insert", "update",
  "delete", "values", "set", "returning",
];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
mockDbChain.get = vi.fn().mockReturnValue(undefined);
mockDbChain.run = vi.fn();
// Make the chain awaitable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(mockDbChain as any).then = (resolve: (v: unknown) => unknown) => resolve([]);

vi.mock("@/db", () => ({
  db: new Proxy({}, {
    get: (_t, prop) => mockDbChain[prop as string] ?? vi.fn().mockReturnValue(mockDbChain),
  }),
  schema: {
    transactionRules: {
      id: "id", name: "name", conditions: "conditions", actions: "actions",
      isActive: "isActive", priority: "priority", createdAt: "createdAt",
      updatedAt: "updatedAt", userId: "userId",
    },
    categories: { id: "id", nameCt: "nameCt", userId: "userId" },
    accounts: { id: "id", nameCt: "nameCt", userId: "userId" },
    portfolioHoldings: { id: "id", nameCt: "nameCt", userId: "userId" },
  },
}));

vi.mock("@/lib/crypto/encrypted-columns", () => ({
  decryptName: () => null,
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: {
      userId: "default",
      method: "passphrase" as const,
      mfaVerified: false,
      dek: Buffer.alloc(32, 0xaa),
      sessionId: "test-session-jti",
    },
  })),
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), asc: vi.fn(), desc: vi.fn(), and: vi.fn(), inArray: vi.fn() }));

vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => undefined),
  OwnershipError: class OwnershipError extends Error {
    constructor() { super("ownership"); }
  },
}));

import { GET, POST, PUT, DELETE } from "@/app/api/rules/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const validConditions = { all: [{ field: "payee", op: "contains", value: "Starbucks" }] };
const validActions = [{ kind: "set_category", categoryId: 5 }];

describe("API /api/rules (FINLYNQ-84 v2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) mockDbChain[m]!.mockReturnValue(mockDbChain);
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns all rules", async () => {
      const rules = [{
        id: 1, name: "Coffee", conditions: validConditions, actions: validActions,
        isActive: true, priority: 0, createdAt: "2026-05-21", updatedAt: new Date(),
      }];
      mockDbChain.all!.mockReturnValueOnce(rules);
      const req = createMockRequest("http://localhost:3000/api/rules");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe("POST", () => {
    it("creates a rule with new shape", async () => {
      const rule = {
        id: 1, name: "Coffee", conditions: validConditions, actions: validActions,
        isActive: true, priority: 0,
      };
      mockDbChain.get!.mockReturnValueOnce(rule);
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "POST",
        body: { name: "Coffee", conditions: validConditions, actions: validActions },
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

    it("returns 400 for empty conditions", async () => {
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "POST",
        body: { name: "Test", conditions: { all: [] }, actions: validActions },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty actions", async () => {
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "POST",
        body: { name: "Test", conditions: validConditions, actions: [] },
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
