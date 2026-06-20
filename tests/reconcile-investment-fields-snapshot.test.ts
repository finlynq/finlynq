/**
 * FINLYNQ-207 — `computeReconcileForAccount` attaches the investment-import
 * capture fields (ticker / securityName / quantity) to each bank-row snapshot
 * for an INVESTMENT account, and OMITS the three keys for a CASH account so the
 * cash reconcile view + `GET /api/reconcile/suggestions` shape stay
 * byte-identical to today (tc-3).
 *
 * The match-engine reads several tables; we drive it with a tag-aware Drizzle
 * mock that returns a queued result per table. Crypto is mocked to a reversible
 * identity so we assert on plaintext.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER =
  process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY =
  process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// ─── Hoisted per-table result queues ───────────────────────────────────────
const state = vi.hoisted(() => ({
  // FIFO of result arrays, dequeued by `.all()` in query order.
  results: [] as unknown[][],
}));

vi.mock("@/db", () => {
  function selectChain() {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "from", "where", "leftJoin", "innerJoin", "orderBy"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.all = vi.fn(() => (state.results.length ? state.results.shift()! : []));
    return chain;
  }
  return {
    db: { select: vi.fn(() => (selectChain().select as () => unknown)()) },
    schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
  };
});

// Reversible identity crypto so the snapshot reads plaintext.
vi.mock("@/lib/crypto/envelope", () => ({
  encryptField: (_dek: Buffer, v: string | null) => v,
  tryDecryptField: (_dek: Buffer, v: string) => v,
}));
vi.mock("@/lib/crypto/staging-envelope", () => ({
  decryptStaged: (v: string) => v,
}));
// Rule loading + matching are out of scope; stub to "no rules / no match".
vi.mock("@/lib/auto-categorize", () => ({ applyRules: () => null }));
vi.mock("@/lib/rules/crypto", () => ({
  decryptRuleFields: (_dek: unknown, r: unknown) => r,
}));

import { computeReconcileForAccount } from "../src/lib/reconcile/match-engine";

const USER = "user-207";
const DEK = Buffer.alloc(32, 0x7a);
const ACCT = 9;

/**
 * Queue the five reads `computeReconcileForAccount` performs, in order:
 *   1. bank candidate pool   (buildBankLedgerCandidatePool)
 *   2. transactions          (loadTxRows)
 *   3. transaction_bank_links(loadJoinRows)
 *   4. transaction_rules     (loadActiveRulesForReconcile)
 *   5. bank_transactions meta(seenCount/firstSeen/lastSeen)
 */
function queue(bankPoolRows: unknown[], metaRows: unknown[]) {
  state.results = [
    bankPoolRows, // 1
    [], // 2 transactions
    [], // 3 links
    [], // 4 rules
    metaRows, // 5 meta
  ];
}

function poolRow(over: Record<string, unknown>) {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    accountId: ACCT,
    date: "2026-06-10",
    amount: 1234.56,
    currency: "USD",
    payee: "Vanguard",
    importHash: "h1",
    fitId: null,
    ticker: null,
    securityName: null,
    quantity: null,
    encryptionTier: "user",
    ...over,
  };
}

function metaRow(id: string) {
  return { id, seenCount: 1, firstSeenAt: null, lastSeenAt: null };
}

beforeEach(() => {
  state.results = [];
});

describe("computeReconcileForAccount — investment field snapshot shape", () => {
  it("attaches ticker/securityName/quantity for an investment-captured bank row", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    queue(
      [
        poolRow({
          id,
          ticker: "AAPL",
          securityName: "Apple Inc.",
          quantity: 10.5,
        }),
      ],
      [metaRow(id)],
    );
    const res = await computeReconcileForAccount({ userId: USER, dek: DEK, accountId: ACCT });
    const snap = res.bankTransactions[id];
    expect(snap.ticker).toBe("AAPL");
    expect(snap.securityName).toBe("Apple Inc.");
    expect(snap.quantity).toBe(10.5);
  });

  it("OMITS the three keys for a cash row (nothing captured)", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    queue([poolRow({ id })], [metaRow(id)]);
    const res = await computeReconcileForAccount({ userId: USER, dek: DEK, accountId: ACCT });
    const snap = res.bankTransactions[id];
    // tc-3: cash snapshot is byte-identical — the keys are ABSENT, not null.
    expect("ticker" in snap).toBe(false);
    expect("securityName" in snap).toBe(false);
    expect("quantity" in snap).toBe(false);
  });

  it("attaches the keys when ONLY quantity is captured (partial investment row)", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    queue([poolRow({ id, quantity: 4 })], [metaRow(id)]);
    const res = await computeReconcileForAccount({ userId: USER, dek: DEK, accountId: ACCT });
    const snap = res.bankTransactions[id];
    expect(snap.quantity).toBe(4);
    expect(snap.ticker).toBeNull();
    expect(snap.securityName).toBeNull();
  });
});
