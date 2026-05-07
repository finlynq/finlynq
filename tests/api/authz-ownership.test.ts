/**
 * B4 / H-1 — Cross-tenant FK regression test.
 *
 * Seeds two users (A + B) with their own accounts/categories/holdings, then
 * exercises every offending route by sending user A's session a body that
 * references one of user B's FK ids. Each must respond 404 (anti-enumeration:
 * "not found", same shape as a deleted-or-never-existed id), and never
 * reach the INSERT/UPDATE.
 *
 * The strategy is deliberately small: we mock the DB through an in-memory
 * store that knows enough about `select(...).from(table).where(eq(userId, ?)
 * AND inArray(id, [?, ?]))` to answer the helper's SELECT correctly. Any
 * write call against the store records the table + values so the test can
 * also assert the cross-tenant request did NOT reach the write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- in-memory two-user fixture ------------------------------------------

const SEED = {
  accounts: [
    { id: 100, userId: "userA", currency: "CAD" },
    { id: 200, userId: "userB", currency: "CAD" },
  ],
  categories: [
    { id: 110, userId: "userA" },
    { id: 210, userId: "userB" },
  ],
  portfolioHoldings: [
    { id: 120, userId: "userA", accountId: 100 },
    { id: 220, userId: "userB", accountId: 200 },
  ],
};

type TableKey = "accounts" | "categories" | "portfolioHoldings";

// Track every write so each test can assert "did NOT reach INSERT".
const writes: Array<{ kind: string; table?: TableKey; values?: unknown }> = [];

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");

  // Drizzle predicate hooks come back as `{__kind, col, val}` thanks to the
  // drizzle-orm mock below. We pattern-match those here.
  type Cond =
    | { __kind: "eq"; col: { __field: string; __table: TableKey }; val: unknown }
    | { __kind: "inArray"; col: { __field: string; __table: TableKey }; vals: number[] }
    | { __kind: "and"; conds: Cond[] };

  function flatten(c: Cond): Cond[] {
    return c.__kind === "and" ? c.conds.flatMap(flatten) : [c];
  }

  function findTable(c: Cond[]): TableKey | undefined {
    for (const cond of c) {
      if (cond.__kind === "eq" || cond.__kind === "inArray") {
        return cond.col.__table;
      }
    }
    return undefined;
  }

  function applyConds(rows: Record<string, unknown>[], conds: Cond[]): Record<string, unknown>[] {
    return rows.filter((row) =>
      conds.every((c) => {
        if (c.__kind === "eq") return row[c.col.__field] === c.val;
        if (c.__kind === "inArray") return c.vals.includes(row[c.col.__field] as number);
        return true;
      }),
    );
  }

  const db = {
    select: (_cols: unknown) => ({
      from: (table: { __table: TableKey }) => ({
        where: (cond: Cond) => {
          const conds = flatten(cond);
          const tableKey = findTable(conds) ?? table.__table;
          const rows = SEED[tableKey] as Record<string, unknown>[];
          return Promise.resolve(applyConds(rows, conds));
        },
      }),
    }),
    insert: (_table: { __table: TableKey }) => ({
      values: (v: unknown) => {
        writes.push({ kind: "insert", table: _table.__table, values: v });
        return {
          returning: () => ({ get: () => Promise.resolve({ id: 999 }) }),
        };
      },
    }),
    update: (_table: { __table: TableKey }) => ({
      set: (v: unknown) => ({
        where: () => {
          writes.push({ kind: "update", table: _table.__table, values: v });
          return {
            returning: () => ({ get: () => Promise.resolve({ id: 999 }) }),
          };
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  };

  // schema columns get a sentinel marker the drizzle-orm mock can read.
  function col(table: TableKey, field: string) {
    return { __field: field, __table: table };
  }
  const schema = {
    ...actual.schema,
    accounts: { __table: "accounts" as TableKey, id: col("accounts", "id"), userId: col("accounts", "userId") },
    categories: { __table: "categories" as TableKey, id: col("categories", "id"), userId: col("categories", "userId") },
    portfolioHoldings: { __table: "portfolioHoldings" as TableKey, id: col("portfolioHoldings", "id"), userId: col("portfolioHoldings", "userId") },
    goals: { __table: "goals" as TableKey, id: col("goals" as TableKey, "id"), userId: col("goals" as TableKey, "userId") },
    loans: { __table: "loans" as TableKey, id: col("loans" as TableKey, "id"), userId: col("loans" as TableKey, "userId") },
    subscriptions: { __table: "subscriptions" as TableKey, id: col("subscriptions" as TableKey, "id"), userId: col("subscriptions" as TableKey, "userId") },
    transactionRules: { __table: "transactionRules" as TableKey, id: col("transactionRules" as TableKey, "id"), userId: col("transactionRules" as TableKey, "userId") },
  };

  return { db, schema };
});

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ __kind: "eq", col, val }),
  inArray: (col: unknown, vals: number[]) => ({ __kind: "inArray", col, vals }),
  and: (...conds: unknown[]) => ({ __kind: "and", conds }),
  sql: Object.assign(
    (..._args: unknown[]) => ({ __kind: "sql" }),
    { raw: (..._args: unknown[]) => ({ __kind: "sql.raw" }) },
  ),
  desc: vi.fn(),
  asc: vi.fn(),
  lte: vi.fn(),
  gte: vi.fn(),
}));

import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";

beforeEach(() => {
  writes.length = 0;
});

describe("verifyOwnership helper (B4 / H-1)", () => {
  it("passes when every supplied id belongs to the user", async () => {
    await expect(
      verifyOwnership("userA", {
        accountIds: [100],
        categoryIds: [110],
        holdingIds: [120],
      }),
    ).resolves.toBeUndefined();
  });

  it("throws OwnershipError when the user supplies another user's account id", async () => {
    let caught: unknown;
    try {
      await verifyOwnership("userA", { accountIds: [200] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OwnershipError);
    expect((caught as OwnershipError).kind).toBe("account");
    expect((caught as OwnershipError).missingIds).toContain(200);
  });

  it("throws on cross-tenant categoryId", async () => {
    await expect(verifyOwnership("userA", { categoryIds: [210] })).rejects.toBeInstanceOf(
      OwnershipError,
    );
  });

  it("throws on cross-tenant holdingId", async () => {
    await expect(verifyOwnership("userA", { holdingIds: [220] })).rejects.toBeInstanceOf(
      OwnershipError,
    );
  });

  it("ignores null / undefined / non-positive ids cleanly", async () => {
    await expect(
      verifyOwnership("userA", {
        accountIds: [null, undefined, 0, -1],
        categoryIds: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("allows the same id repeated (de-dup)", async () => {
    await expect(
      verifyOwnership("userA", { accountIds: [100, 100, 100] }),
    ).resolves.toBeUndefined();
  });

  it("rejects mixed valid + cross-tenant batch", async () => {
    let caught: OwnershipError | null = null;
    try {
      await verifyOwnership("userA", { accountIds: [100, 200] });
    } catch (e) {
      caught = e as OwnershipError;
    }
    expect(caught).toBeInstanceOf(OwnershipError);
    expect(caught!.missingIds).toEqual([200]);
    expect(caught!.missingIds).not.toContain(100);
  });
});

// ---- route-level smoke: each affected route returns 404 on cross-tenant ----

describe("Cross-tenant FK rejection at route boundary (B4 / H-1)", () => {
  describe("/api/snapshots POST", () => {
    it("returns 404 when userA targets userB's accountId", async () => {
      // Reset modules so the snapshots-route-specific mocks don't leak.
      vi.resetModules();
      vi.doMock("@/lib/auth/require-auth", () => ({
        requireAuth: vi.fn(async () => ({
          authenticated: true,
          context: { userId: "userA", method: "passphrase" as const, mfaVerified: false },
        })),
      }));
      const { POST } = await import("@/app/api/snapshots/route");
      const { createMockRequest } = await import("../helpers/api-test-utils");
      const req = createMockRequest("http://localhost:3000/api/snapshots", {
        method: "POST",
        body: { accountId: 200 /* userB's account */, date: "2026-01-01", value: 9999 },
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
      // The cross-tenant request must NOT reach the snapshot INSERT — only
      // the helper's SELECT against `accounts` is allowed.
      const realInsert = writes.find((w) => w.kind === "insert");
      expect(realInsert).toBeUndefined();
    });
  });

  describe("/api/budgets POST", () => {
    it("returns 404 when userA targets userB's categoryId", async () => {
      vi.resetModules();
      vi.doMock("@/lib/auth/require-auth", () => ({
        requireAuth: vi.fn(async () => ({
          authenticated: true,
          context: { userId: "userA", method: "passphrase" as const, mfaVerified: false },
        })),
      }));
      vi.doMock("@/lib/queries", () => ({
        upsertBudget: vi.fn(async () => ({ id: 999 })),
        getBudgets: vi.fn(),
        deleteBudget: vi.fn(),
        getBudgetRollover: vi.fn(),
        getSpendingByCategoryAndCurrency: vi.fn(),
      }));
      vi.doMock("@/lib/fx-service", () => ({
        getRateMap: vi.fn(async () => new Map([["CAD", 1]])),
        convertWithRateMap: vi.fn((amount: number) => amount),
        getDisplayCurrency: vi.fn(async () => "CAD"),
      }));
      const { POST } = await import("@/app/api/budgets/route");
      const { createMockRequest } = await import("../helpers/api-test-utils");
      const req = createMockRequest("http://localhost:3000/api/budgets", {
        method: "POST",
        body: { categoryId: 210 /* userB's category */, month: "2026-01", amount: 500 },
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
    });
  });

  describe("/api/rules POST", () => {
    it("returns 404 when userA targets userB's assignCategoryId", async () => {
      vi.resetModules();
      vi.doMock("@/lib/auth/require-auth", () => ({
        requireAuth: vi.fn(async () => ({
          authenticated: true,
          context: { userId: "userA", method: "passphrase" as const, mfaVerified: false, dek: null },
        })),
      }));
      const { POST } = await import("@/app/api/rules/route");
      const { createMockRequest } = await import("../helpers/api-test-utils");
      const req = createMockRequest("http://localhost:3000/api/rules", {
        method: "POST",
        body: {
          name: "Coffee",
          matchField: "payee",
          matchType: "contains",
          matchValue: "Starbucks",
          assignCategoryId: 210, // userB's category
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
    });
  });

  describe("/api/transactions/bulk POST update_account", () => {
    it("returns 404 when userA bulk-updates rows to userB's accountId", async () => {
      vi.resetModules();
      vi.doMock("@/lib/auth/require-auth", () => ({
        requireAuth: vi.fn(async () => ({
          authenticated: true,
          context: { userId: "userA", method: "passphrase" as const, mfaVerified: false },
        })),
      }));
      vi.doMock("@/lib/auth/require-encryption", () => ({
        requireEncryption: vi.fn(async () => ({ ok: true, userId: "userA", dek: Buffer.alloc(32) })),
      }));
      const { POST } = await import("@/app/api/transactions/bulk/route");
      const { createMockRequest } = await import("../helpers/api-test-utils");
      const req = createMockRequest("http://localhost:3000/api/transactions/bulk", {
        method: "POST",
        body: { action: "update_account", ids: [1, 2, 3], accountId: 200 /* userB */ },
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
    });

    it("returns 404 when userA bulk-updates rows to userB's categoryId", async () => {
      vi.resetModules();
      vi.doMock("@/lib/auth/require-auth", () => ({
        requireAuth: vi.fn(async () => ({
          authenticated: true,
          context: { userId: "userA", method: "passphrase" as const, mfaVerified: false },
        })),
      }));
      vi.doMock("@/lib/auth/require-encryption", () => ({
        requireEncryption: vi.fn(async () => ({ ok: true, userId: "userA", dek: Buffer.alloc(32) })),
      }));
      const { POST } = await import("@/app/api/transactions/bulk/route");
      const { createMockRequest } = await import("../helpers/api-test-utils");
      const req = createMockRequest("http://localhost:3000/api/transactions/bulk", {
        method: "POST",
        body: { action: "update_category", ids: [1, 2, 3], categoryId: 210 /* userB */ },
      });
      const res = await POST(req);
      expect(res.status).toBe(404);
    });
  });
});
