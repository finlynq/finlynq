import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "update", "delete", "values", "set", "returning"];
for (const m of chainMethods) {
  mockDbChain[m] = vi.fn().mockReturnValue(mockDbChain);
}
mockDbChain.all = vi.fn().mockReturnValue([]);
mockDbChain.get = vi.fn().mockReturnValue(undefined);
mockDbChain.run = vi.fn();
// Make the chain awaitable — real Drizzle chains are thenables; without this,
// `await db.select()...` returns the chain object itself (not the rows),
// causing `rows.map`/`rows.length` to blow up in route code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(mockDbChain as any).then = (resolve: (v: unknown) => unknown) => resolve([]);

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
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
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
      const rules = [{ id: 1, name: "Coffee", matchField: "payee", matchType: "contains", matchValue: "Starbucks", isActive: true }];
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

    // FINLYNQ-66 — the Settings → Categorization form sends `null` for
    // empty optional fields (`assignTags: ruleForm.assignTags || null`,
    // same for `renameTo` and `assignCategoryId`). Before the fix, the
    // POST schema declared these as `z.string().optional()` (= `string |
    // undefined`) and Zod rejected `null` with "Invalid input: expected
    // string, received null". Each of these payloads MUST succeed.
    const finlynq66Payloads: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: "assignTags=null + renameTo=null", body: { name: "test", matchField: "payee", matchType: "contains", matchValue: "a", assignCategoryId: null, assignTags: null, renameTo: null, priority: 0 } },
      { label: "assignTags=''", body: { name: "test", matchField: "payee", matchType: "contains", matchValue: "a", assignTags: "" } },
      { label: "assignTags omitted", body: { name: "test", matchField: "payee", matchType: "contains", matchValue: "a" } },
      { label: "renameTo='sas' + assignTags=null (exact repro)", body: { name: "test", matchField: "payee", matchType: "contains", matchValue: "a", assignCategoryId: null, assignTags: null, renameTo: "sas", priority: 1 } },
    ];

    for (const { label, body } of finlynq66Payloads) {
      it(`FINLYNQ-66: accepts ${label}`, async () => {
        const rule = { id: 1, name: "test", matchField: "payee", matchType: "contains", matchValue: "a" };
        mockDbChain.get!.mockReturnValueOnce(rule);
        const req = createMockRequest("http://localhost:3000/api/rules", { method: "POST", body });
        const res = await POST(req);
        expect(res.status).toBe(201);
      });
    }
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
