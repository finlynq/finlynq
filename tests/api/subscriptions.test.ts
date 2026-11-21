import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbChain: Record<string, ReturnType<typeof vi.fn>> = {};
const chainMethods = ["select", "from", "where", "orderBy", "leftJoin", "insert", "update", "delete", "values", "set", "returning", "groupBy", "limit", "offset"];
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
    subscriptions: { id: "id", name: "name", amount: "amount", currency: "currency", frequency: "frequency", categoryId: "categoryId", accountId: "accountId", nextDate: "nextDate", status: "status", cancelReminderDate: "cancelReminderDate", notes: "notes" },
    categories: { id: "id", name: "name" },
    accounts: { id: "id", name: "name" },
    transactions: { id: "id", date: "date", payee: "payee", amount: "amount", accountId: "accountId", categoryId: "categoryId" },
  },
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "default", method: "passphrase" as const, mfaVerified: false, dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" } })),
}));

vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: vi.fn(async () => ({ ok: true, userId: "default", dek: Buffer.alloc(32, 0xaa), sessionId: "test-session-jti" })),
}));

vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: vi.fn(async (_userId: string, override?: string | null) => override ?? "USD"),
  getRateMap: vi.fn(async () => new Map()),
  convertWithRateMap: vi.fn((amount: number) => amount),
}));

// GH #428 — the dismissal store reads its own table; no dismissals here.
vi.mock("@/lib/subscriptions/dismissals", () => ({
  dismissedLookups: vi.fn(async () => new Set<string>()),
  withoutDismissed: <T,>(rows: T[]) => rows,
}));
vi.mock("@/lib/recurring-detector", () => ({
  detectRecurringTransactions: vi.fn(() => [
    { payee: "Netflix", avgAmount: -15.99, currency: "USD", frequency: "monthly", nextDate: "2024-02-01", accountId: 1, categoryId: 2, count: 6, lastDate: "2024-01-01" },
    { payee: "Domain", avgAmount: -20, currency: "USD", frequency: "yearly", nextDate: "2025-03-01", accountId: 1, categoryId: null, count: 3, lastDate: "2024-03-01" },
    { payee: "Cleaner", avgAmount: -80, currency: "USD", frequency: "biweekly", nextDate: "2024-02-05", accountId: 1, categoryId: null, count: 9, lastDate: "2024-01-22" },
    { payee: "Salary", avgAmount: 4000, currency: "USD", frequency: "monthly", nextDate: "2024-02-01", accountId: 1, categoryId: null, count: 12, lastDate: "2024-01-01" },
  ]),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), sql: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(), inArray: vi.fn(),
}));

// B4 — bypass verifyOwnership; cross-tenant rejection in authz-ownership.test.ts.
vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => undefined),
  OwnershipError: class OwnershipError extends Error {
    constructor() { super("ownership"); }
  },
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
      const req = createMockRequest("http://localhost:3000/api/subscriptions");
      const res = await GET(req);
      const { status, data } = await parseResponse(res);
      expect(status).toBe(200);
      expect(data).toEqual([
        // Names are ct-only post Stream D; the fixture carries none, so only shape + conversion are asserted.
        expect.objectContaining({ id: 1, amount: 15.99, frequency: "monthly", displayCurrency: "USD", displayAmount: 15.99 }),
      ]);
    });

    it("serves a canonical cadence (MCP-written 'yearly' reads as 'annual')", async () => {
      mockDbChain.all!.mockReturnValueOnce([{ id: 2, name: "Domain", amount: 20, currency: "USD", frequency: "yearly", status: "active" }]);
      const res = await GET(createMockRequest("http://localhost:3000/api/subscriptions"));
      const { data } = await parseResponse(res);
      expect((data as { frequency: string }[])[0].frequency).toBe("annual");
    });

    it("is not dev-mode gated", async () => {
      // No settings row means dev mode is off. The merged page is a regular feature.
      const res = await GET(createMockRequest("http://localhost:3000/api/subscriptions"));
      expect(res.status).toBe(200);
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

    it("accepts null for every empty optional field (what the form sends)", async () => {
      mockDbChain.get!.mockReturnValueOnce({ id: 3 });
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { name: "Gym", amount: 40, currency: "USD", frequency: "monthly", categoryId: null, accountId: null, nextDate: null, notes: null, cancelReminderDate: null },
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
    });

    it("stores alternate cadence spellings canonically", async () => {
      mockDbChain.get!.mockReturnValueOnce({ id: 4 });
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { name: "Car insurance", amount: 600, frequency: "semi-annual", nextDate: "2026-11-01" },
      });
      expect((await POST(req)).status).toBe(201);
      expect(mockDbChain.values).toHaveBeenCalledWith(expect.objectContaining({ frequency: "semiannual", nextDate: "2026-11-01" }));
    });

    it("rejects an unknown cadence and a malformed date", async () => {
      const badFreq = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { name: "X", amount: 1, frequency: "hourly" },
      });
      expect((await POST(badFreq)).status).toBe(400);
      const badDate = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { name: "X", amount: 1, nextDate: "next tuesday" },
      });
      expect((await POST(badDate)).status).toBe(400);
    });

    it("auto-detect maps every detector cadence onto a subscription cadence", async () => {
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "POST",
        body: { action: "detect" },
      });
      const { data } = await parseResponse(await POST(req));
      const byName = Object.fromEntries((data as { suggestions: { name: string; frequency: string }[] }).suggestions.map((s) => [s.name, s.frequency]));
      // Expenses only; "yearly" becomes "annual"; biweekly is no longer squashed to monthly.
      expect(byName).toEqual({ Netflix: "monthly", Domain: "annual", Cleaner: "biweekly" });
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

    it("never writes a column outside the editable field list", async () => {
      mockDbChain.get!.mockReturnValueOnce({ id: 1 });
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "PUT",
        // `userId` used to pass straight through `.passthrough()` into the SET clause.
        body: { id: 1, status: "paused", userId: "someone-else", nameLookup: "x" },
      });
      expect((await PUT(req)).status).toBe(200);
      const setArg = mockDbChain.set!.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).toEqual({ status: "paused" });
    });

    it("404s when the row isn't the caller's", async () => {
      mockDbChain.get!.mockReturnValueOnce(undefined);
      const req = createMockRequest("http://localhost:3000/api/subscriptions", {
        method: "PUT",
        body: { id: 999, status: "paused" },
      });
      expect((await PUT(req)).status).toBe(404);
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
