/**
 * FINLYNQ-150 — unit spec for the extracted shared materialize chokepoint
 * `materializeBankRowAsTransaction`.
 *
 * The web route `/api/reconcile/materialize` and the `materialize_bank_row` MCP
 * tool both delegate here, so this spec pins the six load-bearing invariants in
 * one place:
 *   - tx + 'primary' link INSERTed in a SINGLE db.transaction()
 *   - `source = 'reconcile_link'` on both the tx row and the link row
 *   - `import_hash` copied VERBATIM from the bank row (never recomputed)
 *   - payee/note/tags re-encrypted under the user DEK (transactions is user-tier)
 *   - investment-account materialize refused with `investment_account_unsupported`
 *   - sign-vs-category mismatch refused with `sign_category_mismatch`
 *   - `invalidateUser(userId)` called after a successful commit
 *
 * No live DB — a programmable Drizzle mock dequeues per-test result arrays and
 * captures the INSERT .values() payloads so the assertions read the exact rows
 * the lib would have written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER =
  process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY =
  process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// ─── Hoisted state shared by the mocks ──────────────────────────────────────
const state = vi.hoisted(() => ({
  // FIFO queue of result arrays returned by terminal selects (.limit()).
  selectResults: [] as unknown[][],
  // Captured INSERT payloads, in call order: [tableTag, valuesObject].
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  // Whether db.transaction() ran its callback.
  txRan: false,
}));

const invalidateUser = vi.hoisted(() => vi.fn());

// Tag each schema table object so the insert mock can name what was inserted.
vi.mock("@/db", () => {
  const transactionsTbl = { __tag: "transactions" };
  const transactionBankLinksTbl = { __tag: "transactionBankLinks" };

  function selectChain() {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "from", "where", "leftJoin", "innerJoin"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(() =>
      state.selectResults.length ? state.selectResults.shift()! : [],
    );
    return chain;
  }

  function insertChain(table: { __tag: string }) {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((vals: Record<string, unknown>) => {
      state.inserts.push({ table: table.__tag, values: vals });
      const c2: Record<string, unknown> = {};
      // The tx INSERT calls .returning(); the link INSERT awaits directly.
      c2.returning = vi.fn(() => [{ id: 9001 }]);
      // Make the chain itself awaitable for the link insert (no .returning()).
      (c2 as { then?: unknown }).then = (r: (v: unknown) => unknown) =>
        r(undefined);
      return c2;
    });
    return chain;
  }

  const db = {
    // db.select() must START a fresh chain each call.
    select: vi.fn(() => selectChain().select as unknown),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      state.txRan = true;
      const tx = {
        insert: vi.fn((table: { __tag: string }) => insertChain(table)),
      };
      return cb(tx);
    }),
  };
  // Replace select so it returns a fresh chain whose builder methods are live.
  (db as { select: unknown }).select = vi.fn(() => {
    const c = selectChain();
    return (c.select as () => unknown)();
  });

  return {
    db,
    schema: {
      bankTransactions: {
        id: {}, accountId: {}, date: {}, amount: {}, currency: {},
        enteredAmount: {}, enteredCurrency: {}, enteredFxRate: {}, quantity: {},
        payee: {}, note: {}, tags: {}, encryptionTier: {}, importHash: {},
        fitId: {}, userId: {},
      },
      accounts: { id: {}, isInvestment: {}, userId: {} },
      categories: { id: {}, userId: {} },
      transactions: transactionsTbl,
      transactionBankLinks: transactionBankLinksTbl,
    },
  };
});

vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser }));

vi.mock("@/lib/crypto/envelope", () => ({
  // Deterministic, reversible "encryption" so assertions can read the payload.
  encryptField: (_dek: Buffer, v: string | null) =>
    v == null ? null : `enc(${v})`,
  tryDecryptField: (_dek: Buffer, v: string) => v, // bank row stored plaintext in-test
}));

vi.mock("@/lib/crypto/staging-envelope", () => ({
  decryptStaged: (v: string) => v,
}));

const validateSignVsCategoryById = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ message: string } | null> => null,
  ),
);
vi.mock("@/lib/transactions/sign-category-invariant", () => ({
  validateSignVsCategoryById,
}));

import { materializeBankRowAsTransaction } from "@/lib/reconcile/materialize-transaction";

const USER = "user-1";
const DEK = Buffer.alloc(32, 0xaa);
const BANK_ID = "11111111-1111-1111-1111-111111111111";

function bankRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BANK_ID,
    accountId: 5,
    date: "2026-06-01",
    amount: -42.5,
    currency: "USD",
    enteredAmount: null,
    enteredCurrency: null,
    enteredFxRate: null,
    quantity: null,
    payee: "Coffee Shop",
    note: "morning",
    tags: "food",
    encryptionTier: "user",
    importHash: "HASH-VERBATIM-ABC",
    fitId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.selectResults = [];
  state.inserts = [];
  state.txRan = false;
  validateSignVsCategoryById.mockResolvedValue(null);
});

describe("materializeBankRowAsTransaction", () => {
  it("writes tx + primary link in one transaction with reconcile_link source + verbatim import_hash", async () => {
    state.selectResults.push([bankRow()]); // bank lookup
    state.selectResults.push([{ id: 5, isInvestment: false }]); // account lookup
    state.selectResults.push([{ id: 7 }]); // category FK guard

    const res = await materializeBankRowAsTransaction({
      userId: USER,
      dek: DEK,
      bankTransactionId: BANK_ID,
      categoryId: 7,
    });

    expect(res).toEqual({ ok: true, transactionId: 9001 });
    expect(state.txRan).toBe(true);

    const txInsert = state.inserts.find((i) => i.table === "transactions");
    const linkInsert = state.inserts.find(
      (i) => i.table === "transactionBankLinks",
    );
    expect(txInsert).toBeDefined();
    expect(linkInsert).toBeDefined();

    // Verbatim import_hash — never recomputed.
    expect(txInsert!.values.importHash).toBe("HASH-VERBATIM-ABC");
    // Distinct writer attribution on both rows.
    expect(txInsert!.values.source).toBe("reconcile_link");
    expect(linkInsert!.values.source).toBe("reconcile_link");
    expect(linkInsert!.values.linkType).toBe("primary");
    // Re-encrypted under the user DEK.
    expect(txInsert!.values.payee).toBe("enc(Coffee Shop)");
    expect(txInsert!.values.note).toBe("enc(morning)");
    expect(txInsert!.values.tags).toBe("enc(food)");
    expect(txInsert!.values.categoryId).toBe(7);
    expect(txInsert!.values.bankTransactionId).toBe(BANK_ID);

    // Cache invalidated after commit.
    expect(invalidateUser).toHaveBeenCalledWith(USER);
  });

  it("refuses materialize into an investment account", async () => {
    state.selectResults.push([bankRow()]); // bank lookup
    state.selectResults.push([{ id: 5, isInvestment: true }]); // investment account

    const res = await materializeBankRowAsTransaction({
      userId: USER,
      dek: DEK,
      bankTransactionId: BANK_ID,
      categoryId: 7,
    });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("investment_account_unsupported");
    expect(state.txRan).toBe(false);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  it("refuses on a sign-vs-category mismatch (no INSERT)", async () => {
    state.selectResults.push([bankRow()]); // bank lookup
    state.selectResults.push([{ id: 5, isInvestment: false }]); // account lookup
    validateSignVsCategoryById.mockResolvedValueOnce({
      message: "Income category on an outflow row",
    });

    const res = await materializeBankRowAsTransaction({
      userId: USER,
      dek: DEK,
      bankTransactionId: BANK_ID,
      categoryId: 7,
    });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("sign_category_mismatch");
    expect(state.txRan).toBe(false);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  it("returns bank_not_found for a cross-tenant / missing bank id", async () => {
    state.selectResults.push([]); // bank lookup miss

    const res = await materializeBankRowAsTransaction({
      userId: USER,
      dek: DEK,
      bankTransactionId: BANK_ID,
    });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("bank_not_found");
    expect(state.txRan).toBe(false);
  });

  it("returns category_not_found when the category FK isn't owned", async () => {
    state.selectResults.push([bankRow()]); // bank lookup
    state.selectResults.push([{ id: 5, isInvestment: false }]); // account lookup
    state.selectResults.push([]); // category FK guard miss

    const res = await materializeBankRowAsTransaction({
      userId: USER,
      dek: DEK,
      bankTransactionId: BANK_ID,
      categoryId: 999,
    });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("category_not_found");
    expect(state.txRan).toBe(false);
  });
});
