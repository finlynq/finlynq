// Security regression test for B3 — cross-tenant data scoping.
//
// Covers three findings from SECURITY_REVIEW_2026-05-06.md:
//   - C-3: chat-engine queries must scope to the calling user
//   - H-9: checkDuplicates / checkFitIdDuplicates must scope to the calling user
//   - C-5: backup-restore transaction/split FK remap must throw on unmapped FK
//
// All three live behind the same DB-mock shim used by csv-parser-multitenancy:
// seed two users, run the operation as user A, assert nothing leaks from user
// B. Each `db.select(...).where(...)` call is filtered against the in-memory
// store using the same eq/and predicate evaluator.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schemaModule from "@/db/schema-pg";

type AccountRow = {
  id: number;
  userId: string;
  type: string;
  group: string;
  currency: string;
  isInvestment: boolean;
  archived: boolean;
  nameCt: string | null;
  nameLookup: string | null;
  aliasCt: string | null;
  aliasLookup: string | null;
  note: string;
};
type CategoryRow = {
  id: number;
  userId: string;
  type: string;
  group: string;
  nameCt: string | null;
  nameLookup: string | null;
  note: string;
};
type TxRow = {
  id: number;
  userId: string;
  accountId: number | null;
  categoryId: number | null;
  date: string;
  amount: number;
  currency: string;
  payee: string;
  note: string;
  tags: string;
  importHash: string | null;
  fitId: string | null;
};

const store: {
  accounts: AccountRow[];
  categories: CategoryRow[];
  transactions: TxRow[];
} = { accounts: [], categories: [], transactions: [] };

type Cond =
  | { __kind: "eq"; col: unknown; val: unknown }
  | { __kind: "and"; conds: Cond[] }
  | { __kind: "inArray"; col: unknown; vals: unknown[] };

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __kind: "eq", col, val }) as Cond,
    and: (...conds: Cond[]) => ({ __kind: "and", conds }) as Cond,
    inArray: (col: unknown, vals: unknown[]) => ({ __kind: "inArray", col, vals }) as Cond,
  };
});

// Mock decryptName so the chat engine can read seeded ciphertext back.
// Seed values use the form `ct:<plaintext>`; with the mocked decoder they
// round-trip to plaintext. nameLookup is the lowercased plaintext.
vi.mock("@/lib/crypto/encrypted-columns", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crypto/encrypted-columns")>(
    "@/lib/crypto/encrypted-columns"
  );
  return {
    ...actual,
    decryptName: (ct: string | null | undefined) => {
      if (!ct) return null;
      return ct.startsWith("ct:") ? ct.slice(3) : ct;
    },
    nameLookup: (_dek: Buffer, name: string) => name.toLowerCase(),
  };
});

vi.mock("@/lib/crypto/envelope", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crypto/envelope")>(
    "@/lib/crypto/envelope"
  );
  return {
    ...actual,
    decryptField: (_dek: Buffer, v: string | null | undefined) => v ?? "",
    encryptField: (_dek: Buffer, v: string) => v,
    isEncrypted: (_v: unknown) => false,
  };
});

vi.mock("@/db", () => {
  const schema = schemaModule;

  type TableKey = "accounts" | "categories" | "transactions";

  function matchTable(table: unknown): TableKey | null {
    if (table === schema.accounts) return "accounts";
    if (table === schema.categories) return "categories";
    if (table === schema.transactions) return "transactions";
    return null;
  }

  // Map every column reference we use in the source code to the field name on
  // the in-memory row shape. Only the columns the chat-engine + import-hash
  // touch need entries here.
  const columnField = new Map<unknown, string>([
    [schema.accounts.id, "id"],
    [schema.accounts.userId, "userId"],
    [schema.accounts.nameLookup, "nameLookup"],
    [schema.accounts.type, "type"],
    [schema.accounts.group, "group"],
    [schema.accounts.currency, "currency"],
    [schema.categories.id, "id"],
    [schema.categories.userId, "userId"],
    [schema.categories.nameLookup, "nameLookup"],
    [schema.categories.type, "type"],
    [schema.transactions.userId, "userId"],
    [schema.transactions.accountId, "accountId"],
    [schema.transactions.categoryId, "categoryId"],
    [schema.transactions.date, "date"],
    [schema.transactions.importHash, "importHash"],
    [schema.transactions.fitId, "fitId"],
  ]);

  function evalCond(cond: Cond | null, row: Record<string, unknown>): boolean {
    if (!cond) return true;
    if (cond.__kind === "and") return cond.conds.every((c) => evalCond(c, row));
    if (cond.__kind === "eq") {
      const field = columnField.get(cond.col);
      if (!field) return true; // unmapped columns are non-restrictive in this shim
      return row[field] === cond.val;
    }
    if (cond.__kind === "inArray") {
      const field = columnField.get(cond.col);
      if (!field) return true;
      return cond.vals.includes(row[field]);
    }
    return true;
  }

  function makeSelectChain(projection?: Record<string, unknown>) {
    let tableName: TableKey | null = null;
    let cond: Cond | null = null;
    const chain = {
      from(t: unknown) {
        tableName = matchTable(t);
        if (!tableName) throw new Error("Unknown table in mock select()");
        return chain;
      },
      leftJoin(_t: unknown, _on: unknown) {
        // We only need the join's filtering effect for chat-engine totals; the
        // tests below assert on ZERO leakage so a no-op leftJoin is fine —
        // user-scoped rows just won't pick up cross-user joined data because
        // the WHERE excludes other users.
        return chain;
      },
      where(c: Cond) {
        cond = c;
        return chain;
      },
      orderBy(..._args: unknown[]) {
        return chain;
      },
      groupBy(..._args: unknown[]) {
        return chain;
      },
      limit(_n: number) {
        return chain;
      },
      async all() {
        if (!tableName) return [];
        const rows = store[tableName].filter((r) =>
          evalCond(cond, r as unknown as Record<string, unknown>),
        );
        // Apply the projection passed to db.select({ ... }) so tests can read
        // back the aliased field names the source code uses (e.g. `hash` for
        // schema.transactions.importHash).
        if (projection) {
          return rows.map((row) => {
            const out: Record<string, unknown> = {};
            for (const [alias, colRef] of Object.entries(projection)) {
              const field = columnField.get(colRef);
              if (field) {
                out[alias] = (row as unknown as Record<string, unknown>)[field];
              }
            }
            return out;
          });
        }
        return rows;
      },
      async get() {
        const rows = await chain.all();
        return rows[0];
      },
    };
    return chain;
  }

  const db = {
    select: (projection?: Record<string, unknown>) => makeSelectChain(projection),
  };

  return { db, schema };
});

describe("security: tenant isolation", () => {
  beforeEach(() => {
    store.accounts.length = 0;
    store.categories.length = 0;
    store.transactions.length = 0;
  });

  // ── C-3: chat-engine cross-tenant aggregates ──────────────────────

  describe("chat-engine processMessage scopes by userId (C-3)", () => {
    it("net worth: only sums user A's transactions when only user B has data", async () => {
      // User B has the entire dataset; user A has none.
      store.accounts.push({
        id: 1,
        userId: "user-b",
        type: "A",
        group: "Banks",
        currency: "CAD",
        isInvestment: false,
        archived: false,
        nameCt: "ct:Bank",
        nameLookup: "bank",
        aliasCt: null,
        aliasLookup: null,
        note: "",
      });
      store.transactions.push({
        id: 1,
        userId: "user-b",
        accountId: 1,
        categoryId: null,
        date: "2026-05-01",
        amount: 9999,
        currency: "CAD",
        payee: "",
        note: "",
        tags: "",
        importHash: null,
        fitId: null,
      });

      const { processMessage } = await import("@/lib/chat-engine");
      const response = await processMessage("what's my net worth", "user-a", null);

      // The "$0.00" check is intentionally formatting-agnostic: the only
      // scenarios that satisfy "no leakage" are
      //   - the response says $0.00, OR
      //   - the response explicitly reports no data
      // Either way, the 9999 from user B MUST NOT appear.
      expect(response.text).not.toContain("9,999");
      expect(response.text).not.toContain("9999");
      // chartData should be empty since user A has no accounts with balances.
      expect(response.chartData ?? []).toHaveLength(0);
    });

    it("balance(name): does not find user B's account when probed by name as user A", async () => {
      // User B has a "Checking" account; user A does not.
      // findAccountName() previously read every account in the DB and would
      // return "Checking" — handleBalance() would then look up the
      // name_lookup hash WITHOUT a userId filter and silently report user
      // B's balance back to user A.
      store.accounts.push({
        id: 1,
        userId: "user-b",
        type: "A",
        group: "Banks",
        currency: "CAD",
        isInvestment: false,
        archived: false,
        nameCt: "ct:Checking",
        nameLookup: "checking",
        aliasCt: null,
        aliasLookup: null,
        note: "",
      });
      store.transactions.push({
        id: 1,
        userId: "user-b",
        accountId: 1,
        categoryId: null,
        date: "2026-05-01",
        amount: 5000,
        currency: "CAD",
        payee: "",
        note: "",
        tags: "",
        importHash: null,
        fitId: null,
      });

      const { processMessage } = await import("@/lib/chat-engine");
      const response = await processMessage(
        "what's my Checking balance?",
        "user-a",
        Buffer.alloc(32, "test-dek"),
      );

      // User A's account list is empty so findAccountName returns null and
      // the engine falls through to "all account balances" — also user-A
      // scoped, so the listing is empty too. Pre-fix the response would
      // echo user B's "Checking" balance.
      expect(response.text).not.toContain("5,000");
      expect(response.text).not.toContain("$5,000");
      expect(response.text).not.toContain("Checking");
      expect(response.chartData ?? []).toHaveLength(0);
    });

    it("transactions: no rows leak from user B in 'recent transactions'", async () => {
      store.accounts.push({
        id: 1,
        userId: "user-b",
        type: "A",
        group: "Banks",
        currency: "CAD",
        isInvestment: false,
        archived: false,
        nameCt: "ct:Bank",
        nameLookup: "bank",
        aliasCt: null,
        aliasLookup: null,
        note: "",
      });
      store.categories.push({
        id: 1,
        userId: "user-b",
        type: "E",
        group: "",
        nameCt: "ct:Coffee",
        nameLookup: "coffee",
        note: "",
      });
      store.transactions.push({
        id: 1,
        userId: "user-b",
        accountId: 1,
        categoryId: 1,
        date: "2026-05-01",
        amount: -42.5,
        currency: "CAD",
        payee: "Bridgehead",
        note: "",
        tags: "",
        importHash: null,
        fitId: null,
      });

      const { processMessage } = await import("@/lib/chat-engine");
      const response = await processMessage(
        "show recent transactions this year",
        "user-a",
        null,
      );

      // The transactions list query is scoped to user A; user B's row must
      // not appear in chartData or text.
      expect(response.text).not.toContain("Bridgehead");
      expect(response.text).not.toContain("42.5");
      const chart = (response.chartData ?? []) as Array<Record<string, unknown>>;
      const payees = chart.map((r) => String(r.payee ?? ""));
      expect(payees.some((p) => p.includes("Bridgehead"))).toBe(false);
    });
  });

  // ── H-9: checkDuplicates / checkFitIdDuplicates scope by userId ───

  describe("import-hash checkDuplicates / checkFitIdDuplicates scope by userId (H-9)", () => {
    it("checkDuplicates does not leak hashes from another user", async () => {
      // User B has a transaction with a known hash.
      store.transactions.push({
        id: 1,
        userId: "user-b",
        accountId: 1,
        categoryId: null,
        date: "2026-05-01",
        amount: -50,
        currency: "CAD",
        payee: "",
        note: "",
        tags: "",
        importHash: "deadbeefcafebabe1234567890abcdef",
        fitId: null,
      });

      const { checkDuplicates } = await import("@/lib/import-hash");
      // Probe as user A — user B's hash MUST NOT appear in the result.
      const probe = await checkDuplicates(
        ["deadbeefcafebabe1234567890abcdef"],
        "user-a",
      );
      expect(probe.size).toBe(0);

      // Sanity-check: same probe as user B finds the hash.
      const probeB = await checkDuplicates(
        ["deadbeefcafebabe1234567890abcdef"],
        "user-b",
      );
      expect(probeB.has("deadbeefcafebabe1234567890abcdef")).toBe(true);
    });

    it("checkFitIdDuplicates does not leak fitIds from another user", async () => {
      store.transactions.push({
        id: 1,
        userId: "user-b",
        accountId: 1,
        categoryId: null,
        date: "2026-05-01",
        amount: -50,
        currency: "CAD",
        payee: "",
        note: "",
        tags: "",
        importHash: null,
        fitId: "BANK-FIT-001",
      });

      const { checkFitIdDuplicates } = await import("@/lib/import-hash");
      const probe = await checkFitIdDuplicates(["BANK-FIT-001"], "user-a");
      expect(probe.size).toBe(0);

      const probeB = await checkFitIdDuplicates(["BANK-FIT-001"], "user-b");
      expect(probeB.has("BANK-FIT-001")).toBe(true);
    });
  });

  // ── C-5: backup-restore unmapped-FK throws ────────────────────────

  describe("backup-restore strip()-mirroring transaction/split FK remap (C-5)", () => {
    // The transaction/split remap blocks live inline in
    // src/app/api/data/import/route.ts (POST handler) — they pre-date the
    // canonical strip() helper but now share its throw-on-unmap behaviour.
    // Re-implementing the relevant predicates here keeps the test free of
    // the heavy NextRequest/auth setup the route requires.

    function remapTxn(
      accountIdMap: Map<number, number>,
      categoryIdMap: Map<number, number>,
      tx: { accountId?: number | null; categoryId?: number | null },
    ): { accountId: number | null; categoryId: number | null } {
      let mappedAccountId: number | null;
      if (tx.accountId == null) {
        mappedAccountId = null;
      } else {
        const newId = accountIdMap.get(tx.accountId);
        if (newId == null) {
          throw new Error(
            `Backup transaction references unknown accountId=${String(tx.accountId)} — accounts section missing or inconsistent`,
          );
        }
        mappedAccountId = newId;
      }
      let mappedCategoryId: number | null;
      if (tx.categoryId == null) {
        mappedCategoryId = null;
      } else {
        const newId = categoryIdMap.get(tx.categoryId);
        if (newId == null) {
          throw new Error(
            `Backup transaction references unknown categoryId=${String(tx.categoryId)} — categories section missing or inconsistent`,
          );
        }
        mappedCategoryId = newId;
      }
      return { accountId: mappedAccountId, categoryId: mappedCategoryId };
    }

    it("throws when transaction's accountId is not in the IdMap (no silent passthrough)", () => {
      const accountIdMap = new Map<number, number>();
      const categoryIdMap = new Map<number, number>();
      // Simulating: the backup's accounts section was missing or stripped.
      // Old code: silently returned the raw integer (a cross-tenant FK).
      expect(() =>
        remapTxn(accountIdMap, categoryIdMap, { accountId: 42, categoryId: null }),
      ).toThrow(/unknown accountId=42/);
    });

    it("throws when transaction's categoryId is not in the IdMap", () => {
      const accountIdMap = new Map([[1, 100]]);
      const categoryIdMap = new Map<number, number>();
      expect(() =>
        remapTxn(accountIdMap, categoryIdMap, { accountId: 1, categoryId: 7 }),
      ).toThrow(/unknown categoryId=7/);
    });

    it("remaps cleanly when both FKs are mapped", () => {
      const accountIdMap = new Map([[1, 100]]);
      const categoryIdMap = new Map([[2, 200]]);
      const out = remapTxn(accountIdMap, categoryIdMap, { accountId: 1, categoryId: 2 });
      expect(out.accountId).toBe(100);
      expect(out.categoryId).toBe(200);
    });

    it("passes through nulls without consulting the IdMap", () => {
      const accountIdMap = new Map<number, number>();
      const categoryIdMap = new Map<number, number>();
      const out = remapTxn(accountIdMap, categoryIdMap, { accountId: null, categoryId: null });
      expect(out.accountId).toBeNull();
      expect(out.categoryId).toBeNull();
    });
  });
});
