/**
 * Migrated route-group proof — FINLYNQ-116 tc-1.
 *
 * /api/holding-accounts + /api/notifications now run through `apiHandler` in
 * raw/compat mode. These tests pin the BARE wire contract their only consumers
 * depend on (verified by grepping: holding-accounts → web Settings page reads a
 * bare array + bare `{ error }`; notifications → no consumer at all). The shape
 * must stay byte-compatible — that is the whole point of compat mode.
 *
 *   - GET /holding-accounts → BARE array (NOT { success, data })
 *   - POST valid           → 201 BARE row
 *   - POST invalid body     → 400 bare `{ error }` (NOT the success envelope)
 *   - POST duplicate        → 409 bare `{ error }` (handler-returned NextResponse)
 *   - DELETE last pairing   → 409 bare `{ error }`
 *   - GET /notifications    → BARE { notifications, unreadCount }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockAuthContext, createMockRequest, parseResponse } from "../helpers/api-test-utils";

// Hoisted Drizzle mock — a programmable query-builder whose terminal awaits /
// .limit()/.returning() resolve to a per-test queue of result arrays.
const dbHolder = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock("@/db", () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    // `limit` is a non-terminal here so BOTH usages work: holding-accounts
    // awaits `.limit(1)` directly (the chain is thenable) while notifications
    // chains `.limit(50).all()`. The result array is dequeued only by a true
    // terminal: an await on the chain, or `.all()` / `.get()` / `.returning()`.
    const passthrough = ["select", "from", "where", "leftJoin", "orderBy", "groupBy", "values", "set", "insert", "update", "delete", "limit"];
    for (const m of passthrough) chain[m] = vi.fn(() => chain);
    const resolve = () => (dbHolder.results.length ? dbHolder.results.shift()! : []);
    chain.returning = vi.fn(() => resolve());
    chain.all = vi.fn(() => resolve());
    chain.get = vi.fn(() => resolve()[0]);
    // Awaiting the chain resolves to the next queued result array.
    chain.then = (r: (v: unknown) => unknown) => r(resolve());
    return chain;
  }
  const db = makeChain();
  return {
    db,
    schema: {
      holdingAccounts: { holdingId: {}, accountId: {}, qty: {}, costBasis: {}, isPrimary: {}, createdAt: {}, userId: {} },
      portfolioHoldings: { id: {}, nameCt: {}, symbolCt: {}, currency: {}, accountId: {}, userId: {} },
      accounts: { id: {}, nameCt: {}, isInvestment: {}, userId: {} },
      notifications: { id: {}, userId: {}, read: {}, createdAt: {}, type: {}, title: {}, message: {} },
      categories: { nameCt: {}, id: {} },
      budgets: { amount: {}, month: {}, userId: {}, id: {}, categoryId: {} },
      transactions: { date: {}, amount: {}, categoryId: {} },
    },
  };
});

vi.mock("@/lib/crypto/encrypted-columns", () => ({
  decryptNamedRows: (rows: unknown[]) => rows,
  decryptName: () => "Cat",
}));
vi.mock("@/lib/server-logger", () => ({ logServerError: vi.fn(async () => undefined) }));

const authHolder = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () =>
    authHolder.ctx
      ? { authenticated: true, context: authHolder.ctx }
      : { authenticated: false, response: new Response(null, { status: 401 }) },
  ),
}));

import { GET, POST, DELETE } from "@/app/api/holding-accounts/route";
import { GET as NOTIF_GET } from "@/app/api/notifications/route";

beforeEach(() => {
  vi.clearAllMocks();
  authHolder.ctx = mockAuthContext();
  dbHolder.results = [];
});

describe("GET /api/holding-accounts (migrated, raw/compat)", () => {
  it("returns a BARE array (no { success, data } envelope)", async () => {
    dbHolder.results = [[{ holdingId: 1, accountId: 2, qty: 5, isPrimary: true }]];
    const req = createMockRequest("http://localhost:3000/api/holding-accounts");
    const res = await GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect((data as { success?: boolean }).success).toBeUndefined();
    expect((data as unknown[])[0]).toMatchObject({ holdingId: 1, accountId: 2 });
  });

  it("returns 401 when unauthenticated", async () => {
    authHolder.ctx = null;
    const req = createMockRequest("http://localhost:3000/api/holding-accounts");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/holding-accounts (migrated, raw/compat)", () => {
  it("returns 201 with a BARE row on a valid request", async () => {
    dbHolder.results = [
      [{ id: 1 }], // assertOwnership: holding exists
      [{ id: 2 }], // assertOwnership: account exists
      [], // duplicate pre-check: none
      [{ holdingId: 1, accountId: 2, qty: 5, costBasis: 100, isPrimary: false }], // insert().returning()
    ];
    const req = createMockRequest("http://localhost:3000/api/holding-accounts", {
      method: "POST",
      body: { holdingId: 1, accountId: 2, qty: 5, costBasis: 100 },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(201);
    expect(data).toMatchObject({ holdingId: 1, accountId: 2 });
    expect((data as { success?: boolean }).success).toBeUndefined();
  });

  it("returns a bare 400 { error } on an invalid body (no envelope)", async () => {
    const req = createMockRequest("http://localhost:3000/api/holding-accounts", {
      method: "POST",
      body: { holdingId: -1, accountId: 2 }, // holdingId must be positive
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect((data as { error?: string }).error).toBeDefined();
    expect((data as { success?: boolean }).success).toBeUndefined();
  });

  it("returns a bare 409 { error } on a duplicate pairing", async () => {
    dbHolder.results = [
      [{ id: 1 }], // holding exists
      [{ id: 2 }], // account exists
      [{ holdingId: 1 }], // duplicate pre-check: one found
    ];
    const req = createMockRequest("http://localhost:3000/api/holding-accounts", {
      method: "POST",
      body: { holdingId: 1, accountId: 2 },
    });
    const res = await POST(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect((data as { error?: string }).error).toContain("already exists");
    expect((data as { success?: boolean }).success).toBeUndefined();
  });
});

describe("DELETE /api/holding-accounts (migrated, raw/compat)", () => {
  it("returns a bare 409 { error } when removing the last pairing", async () => {
    dbHolder.results = [[{ accountId: 2, isPrimary: true }]]; // single pairing
    const req = createMockRequest(
      "http://localhost:3000/api/holding-accounts?holdingId=1&accountId=2",
      { method: "DELETE" },
    );
    const res = await DELETE(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect((data as { error?: string }).error).toContain("last account pairing");
    expect((data as { success?: boolean }).success).toBeUndefined();
  });

  it("returns a bare 400 { error } on missing query params", async () => {
    const req = createMockRequest("http://localhost:3000/api/holding-accounts", {
      method: "DELETE",
    });
    const res = await DELETE(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect((data as { error?: string }).error).toBeDefined();
  });
});

describe("GET /api/notifications (migrated, raw/compat)", () => {
  it("returns a BARE { notifications, unreadCount } object (no envelope)", async () => {
    dbHolder.results = [
      [{ id: 1, title: "Hi" }], // notifications list (.all())
      [{ count: 1 }], // unread count (.get())
    ];
    const req = createMockRequest("http://localhost:3000/api/notifications");
    const res = await NOTIF_GET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect((data as { success?: boolean }).success).toBeUndefined();
    expect(data).toHaveProperty("notifications");
    expect(data).toHaveProperty("unreadCount", 1);
  });
});
