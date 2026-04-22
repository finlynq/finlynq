import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schemaModule from "@/db/schema-pg";

type AccountRow = { id: number; userId: string; name: string };
type CategoryRow = { id: number; userId: string; name: string };
type HoldingRow = { id: number; userId: string; accountId: number; name: string };
type TxRow = Record<string, unknown> & { id: number };

const store: {
  accounts: AccountRow[];
  categories: CategoryRow[];
  portfolioHoldings: HoldingRow[];
  transactions: TxRow[];
} = { accounts: [], categories: [], portfolioHoldings: [], transactions: [] };

type Cond =
  | { __kind: "eq"; col: unknown; val: unknown }
  | { __kind: "and"; conds: Cond[] };

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __kind: "eq", col, val }) as Cond,
    and: (...conds: Cond[]) => ({ __kind: "and", conds }) as Cond,
  };
});

vi.mock("@/lib/import-hash", () => ({
  generateImportHash: (date: string, accountId: number, amount: number, payee: string) =>
    `${date}|${accountId}|${amount}|${payee}`,
  checkDuplicates: vi.fn(async () => new Set<string>()),
}));

vi.mock("@/db", () => {
  const schema = schemaModule;

  type TableKey = "accounts" | "categories" | "portfolioHoldings" | "transactions";

  function matchTable(table: unknown): TableKey | null {
    if (table === schema.accounts) return "accounts";
    if (table === schema.categories) return "categories";
    if (table === schema.portfolioHoldings) return "portfolioHoldings";
    if (table === schema.transactions) return "transactions";
    return null;
  }

  const columnField = new Map<unknown, string>([
    [schema.accounts.userId, "userId"],
    [schema.accounts.name, "name"],
    [schema.categories.userId, "userId"],
    [schema.categories.name, "name"],
    [schema.portfolioHoldings.userId, "userId"],
    [schema.portfolioHoldings.name, "name"],
  ]);

  function evalCond(cond: Cond | null, row: Record<string, unknown>): boolean {
    if (!cond) return true;
    if (cond.__kind === "and") return cond.conds.every((c) => evalCond(c, row));
    if (cond.__kind === "eq") {
      const field = columnField.get(cond.col);
      if (!field) throw new Error("Unmapped column in mock eq() condition");
      return row[field] === cond.val;
    }
    return true;
  }

  function makeSelectChain() {
    let tableName: TableKey | null = null;
    let cond: Cond | null = null;
    const chain = {
      from(t: unknown) {
        tableName = matchTable(t);
        if (!tableName) throw new Error("Unknown table in mock select()");
        return chain;
      },
      where(c: Cond) {
        cond = c;
        return chain;
      },
      async all() {
        if (!tableName) return [];
        return store[tableName].filter((r) => evalCond(cond, r as unknown as Record<string, unknown>));
      },
      async get() {
        const rows = await chain.all();
        return rows[0];
      },
    };
    return chain;
  }

  function makeInsertChain(table: unknown) {
    const tableName = matchTable(table);
    return {
      async values(vals: Record<string, unknown> | Record<string, unknown>[]) {
        if (!tableName) return;
        const arr = Array.isArray(vals) ? vals : [vals];
        for (const v of arr) {
          const nextId = store[tableName].length + 1;
          (store[tableName] as Array<Record<string, unknown>>).push({ id: nextId, ...v });
        }
      },
    };
  }

  const db = {
    select: () => makeSelectChain(),
    insert: (t: unknown) => makeInsertChain(t),
  };

  return { db, schema };
});

const { importTransactions } = await import("@/lib/csv-parser");

describe("importTransactions — multi-tenancy", () => {
  beforeEach(() => {
    store.accounts.length = 0;
    store.categories.length = 0;
    store.portfolioHoldings.length = 0;
    store.transactions.length = 0;
  });

  it("resolves 'Checking' to the importing user's account when another user has the same account name", async () => {
    // User A's Checking (id=1) is inserted first; user B's Checking (id=2) is inserted second.
    // With the bug, `new Map(allAccounts.map((a) => [a.name, a.id]))` would end up with
    // "Checking" -> 2 (user B's id) because Map's last-write-wins, so user A's imported
    // transaction would be cross-linked to user B's account.
    store.accounts.push({ id: 1, userId: "user-a", name: "Checking" });
    store.accounts.push({ id: 2, userId: "user-b", name: "Checking" });

    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags
2024-01-15,Checking,-50.00,Store,,CAD,,`;

    const result = await importTransactions(csv, "user-a");

    expect(result.imported).toBe(1);
    expect(store.transactions).toHaveLength(1);
    const tx = store.transactions[0];
    expect(tx.userId).toBe("user-a");
    // Must point at user A's account (id=1), not user B's (id=2).
    expect(tx.accountId).toBe(1);
  });

  it("does not find user B's account when importing as user A with a name only user B has", async () => {
    store.accounts.push({ id: 1, userId: "user-b", name: "UserBOnly" });

    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags
2024-01-15,UserBOnly,-50.00,Store,,CAD,,`;

    const result = await importTransactions(csv, "user-a");

    // No matching account for user-a → row skipped, no transaction written.
    expect(result.imported).toBe(0);
    expect(store.transactions).toHaveLength(0);
  });
});
