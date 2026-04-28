import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "limit", "offset", "insert", "update", "delete", "values", "set", "returning", "groupBy"];
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
    goals: { id: "id", name: "name", type: "type", targetAmount: "targetAmount", deadline: "deadline", accountId: "accountId", priority: "priority", status: "status", note: "note" },
    accounts: { id: "id", name: "name" },
    transactions: { amount: "amount", accountId: "accountId" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false } })),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), sql: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(),
}));

import { GET, POST, PUT, DELETE } from "@/app/api/goals/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/goals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) {
      mockDbChain[m]!.mockReturnValue(mockDbChain);
    }
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns goals list with progress calculations", async () => {
      mockDbChain.all!.mockReturnValueOnce([
        { id: 1, name: "Emergency Fund", type: "savings", targetAmount: 10000, deadline: "2025-12-31", accountId: 1, accountName: "Savings", priority: 1, status: "active", note: "" },
      ]);
      mockDbChain.get!.mockReturnValueOnce({ total: 5000 });

      const req = createMockRequest("http://localhost:3000/api/goals");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const goals = data as { currentAmount: number; progress: number; remaining: number }[];
      expect(goals[0].currentAmount).toBe(5000);
      expect(goals[0].progress).toBe(50);
      expect(goals[0].remaining).toBe(5000);
    });

    it("handles goals with no linked account", async () => {
      mockDbChain.all!.mockReturnValueOnce([
        { id: 1, name: "Vacation", type: "savings", targetAmount: 5000, deadline: null, accountId: null, accountName: null, priority: 1, status: "active", note: "" },
      ]);

      const req = createMockRequest("http://localhost:3000/api/goals");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const goals = data as { currentAmount: number; progress: number }[];
      expect(goals[0].currentAmount).toBe(0);
      expect(goals[0].progress).toBe(0);
    });

    it("caps progress at 100%", async () => {
      mockDbChain.all!.mockReturnValueOnce([
        { id: 1, name: "Goal", type: "savings", targetAmount: 1000, deadline: null, accountId: 1, accountName: "A", priority: 1, status: "active", note: "" },
      ]);
      mockDbChain.get!.mockReturnValueOnce({ total: 2000 });

      const req = createMockRequest("http://localhost:3000/api/goals");
      const res = await GET(req);
      const { data } = await parseResponse(res);
      const goals = data as { progress: number; remaining: number }[];
      expect(goals[0].progress).toBe(100);
      expect(goals[0].remaining).toBe(0);
    });
  });

  describe("POST", () => {
    it("creates goal with valid data", async () => {
      const goal = { id: 1, name: "Emergency Fund", type: "savings", targetAmount: 10000 };
      mockDbChain.get!.mockReturnValueOnce(goal);
      const req = createMockRequest("http://localhost:3000/api/goals", {
        method: "POST",
        body: { name: "Emergency Fund", type: "savings", targetAmount: 10000 },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("returns 400 for missing fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/goals", {
        method: "POST",
        body: { name: "Test" },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("PUT", () => {
    it("updates goal", async () => {
      mockDbChain.get!.mockReturnValueOnce({ id: 1, name: "Updated" });
      const req = createMockRequest("http://localhost:3000/api/goals", {
        method: "PUT",
        body: { id: 1, name: "Updated" },
      });
      const res = await PUT(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });
  });

  describe("DELETE", () => {
    it("deletes goal by id", async () => {
      const req = createMockRequest("http://localhost:3000/api/goals?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { data } = await parseResponse(res);
      expect(data).toEqual({ success: true });
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/goals", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
