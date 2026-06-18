/**
 * FINLYNQ-189 tc-3 (canonical-category core) — locks the FINLYNQ-131 invariant
 * for the transfer write path that email-import transfer rules reuse:
 * `createTransferPair` resolves the canonical "Transfer" category via
 * `resolveTransferCategoryId` (name_lookup HMAC match on a `type='R'` row), and
 * BOTH legs are written with that single category id — NEVER an arbitrary
 * `type='R'` row (e.g. a "Balance Adjustment" left over from the T→R migration).
 *
 * Two cases:
 *   - an existing "Transfer" category is REUSED (its id stamped on both legs);
 *   - when none matches the "Transfer" HMAC, a NEW one is INSERTed (not the
 *     lowest-id type='R' fallback) and its id stamped on both legs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_DEK = Buffer.alloc(32, 0xaa);

// Capture every transactions INSERT so we can assert the category id on each leg.
const insertedTx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
// Capture category INSERTs (the auto-create branch).
const insertedCat = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

const dbHolder = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock("@/db", () => {
  // A tagged chain remembers which table an insert targets so we can route the
  // captured values + dequeue the right `.returning()` result.
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = { __table: null as unknown };
    const passthrough = ["select", "from", "where", "leftJoin", "orderBy", "groupBy", "set", "update", "delete", "limit"];
    for (const m of passthrough) chain[m] = vi.fn(() => chain);
    chain.insert = vi.fn((tbl: { __name?: string }) => {
      chain.__table = tbl?.__name ?? null;
      return chain;
    });
    chain.values = vi.fn((v: Record<string, unknown>) => {
      if (chain.__table === "transactions") insertedTx.rows.push(v);
      if (chain.__table === "categories") insertedCat.rows.push(v);
      return chain;
    });
    const resolve = () => (dbHolder.results.length ? dbHolder.results.shift()! : []);
    chain.returning = vi.fn(() => resolve());
    chain.all = vi.fn(() => resolve());
    chain.get = vi.fn(() => resolve()[0]);
    chain.then = (r: (v: unknown) => unknown) => r(resolve());
    chain.transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));
    chain.onConflictDoNothing = vi.fn(() => chain);
    return chain;
  }
  const db = makeChain();
  const tbl = (name: string) => ({ __name: name, id: {}, userId: {}, type: {}, group: {}, nameLookup: {}, nameCt: {}, currency: {} });
  return {
    db,
    schema: {
      accounts: tbl("accounts"),
      categories: tbl("categories"),
      transactions: tbl("transactions"),
      transactionBankLinks: tbl("transactionBankLinks"),
      portfolioHoldings: tbl("portfolioHoldings"),
    },
  };
});

// Deterministic crypto: nameLookup("Transfer") is a fixed token; buildNameFields
// returns plaintext fields; encryptTxWrite/decryptName identity.
vi.mock("@/lib/crypto/encrypted-columns", () => ({
  nameLookup: (_dek: Buffer, name: string) => `lookup:${name}`,
  buildNameFields: (_dek: Buffer, { name }: { name: string }) => ({ nameCt: `ct:${name}`, nameLookup: `lookup:${name}` }),
  encryptTxWrite: (_dek: Buffer, row: Record<string, unknown>) => row,
  decryptTxRows: (_dek: Buffer, rows: unknown[]) => rows,
  decryptName: (_ct: string, _dek: Buffer, fallback: string | null) => fallback ?? "Acct",
}));
vi.mock("@/lib/crypto/envelope", () => ({
  encryptField: (_dek: Buffer, v: string) => v,
  decryptField: (_dek: Buffer, v: string) => v,
}));
// Same-currency path never converts, but stub to be safe.
vi.mock("@/lib/currency-conversion", () => ({ resolveTxAmountsCore: vi.fn(async () => ({ ok: true, amount: 0, enteredFxRate: 1 })) }));
// Non-investment accounts — skip the holding-required path entirely.
vi.mock("@/lib/investment-account", () => ({
  isInvestmentAccount: vi.fn(async () => false),
  InvestmentHoldingRequiredError: class extends Error {},
}));
vi.mock("@/lib/portfolio/lots/write-hooks", () => ({ transferLotHook: vi.fn(async () => undefined) }));
vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: vi.fn() }));
vi.mock("@/lib/external-import/portfolio-holding-resolver", () => ({ buildHoldingResolver: vi.fn() }));

import { createTransferPair } from "@/lib/transfer";

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.results = [];
  insertedTx.rows = [];
  insertedCat.rows = [];
});

/** Queue the two-account pre-resolve (both USD, non-investment). */
function queueAccounts() {
  dbHolder.results.push([
    { id: 1, nameCt: "ct:Checking", currency: "USD" },
    { id: 2, nameCt: "ct:Savings", currency: "USD" },
  ]);
}

describe("FINLYNQ-189 tc-3 — createTransferPair lands both legs on the canonical Transfer category", () => {
  it("reuses an existing 'Transfer' (type='R') category matched by name_lookup HMAC", async () => {
    queueAccounts();
    // resolveTransferCategoryId: SELECT existing Transfer → id 99 (the name_lookup
    // HMAC match). A non-"Transfer" type='R' row would NOT be returned by this
    // WHERE (it filters on nameLookup === lookup:Transfer), so id 99 IS Transfer.
    dbHolder.results.push([{ id: 99 }]);
    // Two leg INSERT .returning()
    dbHolder.results.push([{ id: 501 }]);
    dbHolder.results.push([{ id: 502 }]);

    const res = await createTransferPair({
      userId: "user-1",
      dek: TEST_DEK,
      fromAccountId: 1,
      toAccountId: 2,
      enteredAmount: 100,
      date: "2026-06-17",
      txSource: "import",
    });

    expect(res.ok).toBe(true);
    // No new category was created — the existing Transfer was reused.
    expect(insertedCat.rows).toHaveLength(0);
    // Both legs carry the SAME canonical category id.
    expect(insertedTx.rows).toHaveLength(2);
    expect(insertedTx.rows[0].categoryId).toBe(99);
    expect(insertedTx.rows[1].categoryId).toBe(99);
  });

  it("auto-creates a 'Transfer' category (never an arbitrary type='R' row) when none matches", async () => {
    queueAccounts();
    // resolveTransferCategoryId: no name_lookup match → empty → auto-create path.
    dbHolder.results.push([]);
    // INSERT new category .returning() → id 77.
    dbHolder.results.push([{ id: 77 }]);
    // Two leg INSERT .returning()
    dbHolder.results.push([{ id: 601 }]);
    dbHolder.results.push([{ id: 602 }]);

    const res = await createTransferPair({
      userId: "user-1",
      dek: TEST_DEK,
      fromAccountId: 1,
      toAccountId: 2,
      enteredAmount: 50,
      date: "2026-06-17",
      txSource: "import",
    });

    expect(res.ok).toBe(true);
    // A new canonical "Transfer" category was created: type 'R', name_lookup
    // pinned to the "Transfer" HMAC (NOT a reuse of some other type='R' row).
    expect(insertedCat.rows).toHaveLength(1);
    expect(insertedCat.rows[0].type).toBe("R");
    expect(insertedCat.rows[0].nameLookup).toBe("lookup:Transfer");
    // Both legs carry the freshly-created canonical category id.
    expect(insertedTx.rows).toHaveLength(2);
    expect(insertedTx.rows[0].categoryId).toBe(77);
    expect(insertedTx.rows[1].categoryId).toBe(77);
  });
});
