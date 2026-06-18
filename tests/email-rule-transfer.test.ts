/**
 * FINLYNQ-189 — email-import rules can record a TRANSFER (not just a
 * category/expense). These tests pin the record-path transfer logic in
 * `recordEmailInboxRow` (src/lib/email-import/process-pending-inbox.ts):
 *
 *   tc-2 — cross-currency source/dest is REFUSED at record time with a typed
 *          `{ status:"invalid", reason:"transfer_currency_mismatch" }`, and NO
 *          transaction rows are written (createTransferPair + the bank-ledger
 *          upsert are never reached). Mirrors the web cross-currency refusal.
 *
 *   tc-3 — the record path REUSES the canonical web transfer write path
 *          (createTransferPair) — never a hand-rolled INSERT — so both legs land
 *          on the canonical "Transfer" category via resolveTransferCategoryId
 *          (FINLYNQ-131). It is called with the rule's account as the SOURCE
 *          (outflow) leg and the destination as the inflow, and the source-leg
 *          bank-ledger lineage is stamped on the outflow.
 *
 * The canonical-category resolution itself (resolveTransferCategoryId) is
 * exercised directly in tests/transfer-category-canonical.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_DEK = Buffer.alloc(32, 0xaa);

// Hoisted Drizzle mock — a queue of result arrays dequeued by any terminal
// (await / .limit() chain / .all() / .get() / .returning()).
const dbHolder = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock("@/db", () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const passthrough = [
      "select", "from", "where", "leftJoin", "orderBy", "groupBy",
      "values", "set", "insert", "update", "delete", "limit",
    ];
    for (const m of passthrough) chain[m] = vi.fn(() => chain);
    const resolve = () => (dbHolder.results.length ? dbHolder.results.shift()! : []);
    chain.returning = vi.fn(() => resolve());
    chain.all = vi.fn(() => resolve());
    chain.get = vi.fn(() => resolve()[0]);
    chain.then = (r: (v: unknown) => unknown) => r(resolve());
    return chain;
  }
  const db = makeChain();
  return {
    db,
    schema: {
      emailInbox: { id: {}, userId: {}, action: {}, sourceKind: {}, stagedImportId: {}, receivedAt: {}, matchedRuleId: {}, recordedTransactionId: {} },
      stagedTransactions: { id: {}, stagedImportId: {}, date: {}, amount: {}, currency: {}, payee: {}, encryptionTier: {}, rowStatus: {} },
      stagedImports: { id: {}, status: {} },
      accounts: { id: {}, userId: {}, isInvestment: {}, currency: {} },
      categories: { id: {}, userId: {} },
      transactions: { id: {}, userId: {}, accountId: {}, date: {}, amount: {} },
    },
  };
});

// Spy on the canonical write path + bank-ledger upsert (the "no rows written"
// proof for tc-2, and the "reuse" proof for tc-3).
const createTransferPair = vi.fn();
vi.mock("@/lib/transfer", () => ({ createTransferPair: (...a: unknown[]) => createTransferPair(...a) }));

const upsertBankTransaction = vi.fn();
vi.mock("@/lib/bank-ledger", () => ({ upsertBankTransaction: (...a: unknown[]) => upsertBankTransaction(...a) }));

// Dedup helpers — DB-touching; stub to "no duplicate" so the record path
// proceeds to the write.
vi.mock("@/lib/import-hash", () => ({
  generateImportHash: () => "hash-1",
  checkDuplicates: vi.fn(async () => new Set<string>()),
}));

// Tier-aware decrypt: staged rows are 'service' tier → decryptStaged. Identity.
vi.mock("@/lib/crypto/staging-envelope", () => ({ decryptStaged: (v: string | null) => v }));
vi.mock("@/lib/crypto/envelope", () => ({
  encryptField: (_dek: Buffer, v: string) => v,
  tryDecryptField: (_dek: Buffer, v: string) => v,
}));
vi.mock("@/lib/transactions/sign-category-invariant", () => ({ validateSignVsCategoryById: vi.fn(async () => null) }));
vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: vi.fn() }));

import { recordEmailInboxRow } from "@/lib/email-import/process-pending-inbox";

const RECEIVED_AT = new Date("2026-06-17T12:00:00Z");

/** Common DB queue prefix: inbox row → staged candidate → source-account guard. */
function queuePrefix(sourceCurrency: string) {
  dbHolder.results = [
    // 1. inbox SELECT .limit(1)
    [{ id: "inbox-1", sourceKind: "body", stagedImportId: "staged-1", action: "needs_review", receivedAt: RECEIVED_AT }],
    // 2. staged candidate SELECT .limit(1)
    [{ id: "stx-1", date: "2026-06-17", amount: -100, currency: sourceCurrency, payee: "Transfer to Savings", encryptionTier: "service" }],
    // 3. checkGuards: source account SELECT .limit(1)
    [{ isInvestment: false, currency: sourceCurrency }],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.results = [];
});

describe("FINLYNQ-189 — recordEmailInboxRow transfer mode", () => {
  it("tc-2 — refuses a cross-currency transfer and writes NO rows", async () => {
    queuePrefix("USD");
    // 4. checkTransferGuards: destination account SELECT .limit(1) — CAD ≠ USD.
    dbHolder.results.push([{ isInvestment: false, currency: "CAD" }]);

    const result = await recordEmailInboxRow("user-1", TEST_DEK, "inbox-1", {
      accountId: 1,
      categoryId: null,
      transferDestAccountId: 2,
      finalAction: "manually_recorded",
    });

    expect(result.status).toBe("invalid");
    expect((result as { reason?: string }).reason).toBe("transfer_currency_mismatch");
    // No write reached: neither the bank-ledger upsert nor the transfer pair ran.
    expect(upsertBankTransaction).not.toHaveBeenCalled();
    expect(createTransferPair).not.toHaveBeenCalled();
  });

  it("tc-3 — same-currency transfer delegates to the canonical createTransferPair (source=outflow, dest=inflow)", async () => {
    queuePrefix("USD");
    // 4. checkTransferGuards: destination account SELECT .limit(1) — USD === USD.
    dbHolder.results.push([{ isInvestment: false, currency: "USD" }]);
    // 5. dedup2 findExistingLedgerDuplicate SELECT .all() — none.
    dbHolder.results.push([]);
    // 6. inbox UPDATE (action/recordedTransactionId) — no result needed.
    // 7. markStagedImported: 2 UPDATEs — no result needed.

    upsertBankTransaction.mockResolvedValue({ id: "bank-1" });
    createTransferPair.mockResolvedValue({
      ok: true,
      linkId: "link-1",
      fromTransactionId: 501,
      toTransactionId: 502,
    });

    const result = await recordEmailInboxRow("user-1", TEST_DEK, "inbox-1", {
      accountId: 1,
      categoryId: null,
      transferDestAccountId: 2,
      finalAction: "manually_recorded",
    });

    expect(result.status).toBe("recorded");
    // The recorded id is the SOURCE/outflow leg.
    expect((result as { transactionId?: number }).transactionId).toBe(501);

    // Reuse proof: the canonical write path ran with the rule's account as the
    // source (outflow) and the destination as the inflow, positive magnitude,
    // and source-leg bank lineage stamped.
    expect(createTransferPair).toHaveBeenCalledTimes(1);
    const arg = createTransferPair.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.fromAccountId).toBe(1);
    expect(arg.toAccountId).toBe(2);
    expect(arg.enteredAmount).toBe(100);
    expect(arg.fromLegBankTransactionId).toBe("bank-1");
    expect(arg.txSource).toBe("import");

    // The bank-ledger row is the OUTFLOW (negative) on the source account.
    expect(upsertBankTransaction).toHaveBeenCalledTimes(1);
    const bankArg = upsertBankTransaction.mock.calls[0][1] as Record<string, unknown>;
    expect(bankArg.accountId).toBe(1);
    expect(bankArg.amount).toBe(-100);
  });
});
