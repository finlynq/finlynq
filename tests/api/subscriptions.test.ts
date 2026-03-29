import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "update", "delete", "values", "set", "returning", "groupBy", "limit", "offset"];
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
    subscriptions: { id: "id", name: "name", amount: "amount", currency: "currency", frequency: "frequency", categoryId: "categoryId", accountId: "accountId", nextDate: "nextDate", status: "status", cancelReminderDate: "cancelReminderDate", notes: "notes" },
    categories: { id: "id", name: "name" },
    accounts: { id: "id", name: "name" },
    transactions: { id: "id", date: "date", payee: "payee", amount: "amount", accountId: "accountId", categoryId: "categoryId" },
  },
}));

vi.mock("@/lib/require-unlock", () => ({
  requireUnlock: vi.fn(() => null),
}));

vi.mock("@/lib/recurring-detector", () => ({
  detectRecurringTransactions: vi.fn(() => [
    { payee: "Netflix", avgAmount: -15.99, frequency: "monthly", nextDate: "2024-02-01", accountId: 1, categoryId: 2, count: 6, lastDate: "2024-01-01" },
  ]),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), sql: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(),
}));

import { GET, POST, PUT, DELETE } from "@/app/api/subscriptions/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

describe("API /api/subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of chainMethods) {
      mockDbChain[m]!.mockReturnValue(mockDbChain);
    }
    mockDbChain.all!.mockReturnValue([]);
    mockDbChain.get!.mockReturnValue(undefined);
  });

  describe("GET", () => {
    it("returns subscriptions list", async () => {
      const subs = [{ id: 1, name: "Netflix", amount: 15.99, frequency: "monthly", status: "active" }];
      mockDbChain.all!.mockReturnValueOnce(subs);
      const res = await GET();
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual(subs);
    });
  });

  describe("POST", () => {
    it("creates a subscription", async () => {
      const sub = { id: 1, name: "Spotify", amount: 9.99 };
      mockDbChain.get!.mockReturnValueOnce(sub);
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { name: "Spotify", amount: 9.99 },
      });
      const res = await POST(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(201);
    });

    it("auto-detects subscriptions from transactions", async () => {
      mockDbChain.all!.mockReturnValueOnce([
        { id: 1, date: "2024-01-01", payee: "Netflix", amount: -15.99, accountId: 1, categoryId: 2 },
      ]);
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { action: "detect" },
      });
      const res = await POST(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      const d = data as { suggestions: { name: string }[] };
      expect(d.suggestions).toBeDefined();
      expect(d.suggestions[0].name).toBe("Netflix");
    });

    it("returns 400 for missing fields", async () => {
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { amount: 9.99 },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("PUT", () => {
    it("updates subscription", async () => {
      mockDbChain.get!.mockReturnValueOnce({ id: 1, name: "Updated" });
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "PUT",
        body: { id: 1, name: "Updated", amount: 12.99 },
      });
      const res = await PUT(req);
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
    });
  });

  describe("DELETE", () => {
    it("deletes subscription by id", async () => {
      const req = createMockRequest("http://localhost:3000/api/subscriptions?id=1", { method: "DELETE" });
      const res = await DELETE(req);
      const { data } = await parseResponse(res);
      expect(data).toEqual({ success: true });
    });

    it("returns 400 without id", async () => {
      const req = createMockRequest("http://localhost:3000/api/subscriptions", { method: "DELETE" });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });
  });
});
