/**
 * Regression test for M-5 (security/B9): the notifications POST handler
 * was dropping `await` on `db.update(...)` and `db.insert(...)` chains
 * (4 sites). The route returned 200/201 to the client before the DB
 * write resolved.
 *
 * To detect this, we replace the chain's terminal `where()` / `values()`
 * with a Promise that we resolve manually after the route returns. If
 * the route awaited correctly, the response promise itself does not
 * resolve until we resolve the inner DB write. If the await is missing,
 * the route resolves immediately while the DB write is still pending.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Drizzle chain mock — we replace the terminal Promise per test.
const mockChain: Record<string, unknown> = {};
const passthroughs = ["select", "from", "where", "set", "values", "returning", "insert", "update", "delete", "leftJoin", "groupBy", "orderBy", "limit"];
for (const m of passthroughs) mockChain[m] = vi.fn().mockReturnValue(mockChain);
(mockChain.all as unknown) = vi.fn().mockReturnValue([]);
(mockChain.get as unknown) = vi.fn().mockReturnValue({ count: 0 });

vi.mock("@/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => mockChain[prop as string] ?? vi.fn().mockReturnValue(mockChain) }),
  schema: {
    notifications: { id: "id", type: "type", title: "title", message: "message", read: "read", createdAt: "createdAt", userId: "userId" },
    budgets: { id: "id", categoryId: "categoryId", month: "month", amount: "amount", userId: "userId" },
    categories: { id: "id", name: "name", nameCt: "nameCt" },
    transactions: { date: "date", amount: "amount", categoryId: "categoryId" },
  },
}));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({ authenticated: true, context: { userId: "user-1", method: "passphrase" as const, mfaVerified: false } })),
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), desc: vi.fn(), sql: vi.fn(), and: vi.fn() }));

import { POST } from "@/app/api/notifications/route";
import { createMockRequest } from "../helpers/api-test-utils";

describe("notifications POST awaits Drizzle promises (M-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const m of passthroughs) (mockChain[m] as ReturnType<typeof vi.fn>).mockReturnValue(mockChain);
  });

  it("mark-read awaits the update chain before returning", async () => {
    let resolveUpdate: (() => void) | null = null;
    const updateDeferred = new Promise<void>((resolve) => { resolveUpdate = resolve; });
    // Make the terminal `.where()` from `db.update(...).set(...).where(...)`
    // return our deferred Promise. If the handler awaited it, the
    // response Promise won't resolve until we resolve the deferred.
    (mockChain.where as ReturnType<typeof vi.fn>).mockReturnValueOnce(updateDeferred);

    const req = createMockRequest("http://localhost:3000/api/notifications", {
      method: "POST",
      body: { action: "mark-read", id: 1 },
    });
    const responseSettled = vi.fn();
    const responsePromise = POST(req).then(responseSettled);

    // Yield several macrotasks so any unawaited chain would resolve.
    await new Promise((r) => setTimeout(r, 25));
    expect(responseSettled).not.toHaveBeenCalled();

    // Resolve the deferred — now the route should return.
    if (resolveUpdate) (resolveUpdate as () => void)();
    await responsePromise;
    expect(responseSettled).toHaveBeenCalledTimes(1);
  });

  it("custom-create awaits the insert chain before returning", async () => {
    let resolveInsert: (() => void) | null = null;
    const insertDeferred = new Promise<{ id: number }>((resolve) => {
      resolveInsert = () => resolve({ id: 1 });
    });
    // The handler does `await db.insert(...).values(...).returning().get()`.
    // The terminal in pg-shim is `.get()`. Make it our deferred.
    (mockChain.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(insertDeferred);

    const req = createMockRequest("http://localhost:3000/api/notifications", {
      method: "POST",
      body: { title: "Custom", message: "Hello", type: "info" },
    });
    const responseSettled = vi.fn();
    const responsePromise = POST(req).then(responseSettled);

    await new Promise((r) => setTimeout(r, 25));
    expect(responseSettled).not.toHaveBeenCalled();

    if (resolveInsert) (resolveInsert as () => void)();
    await responsePromise;
    expect(responseSettled).toHaveBeenCalledTimes(1);
  });
});
