/**
 * FINLYNQ-216 — `linkTransactionsToBank` bulk reconcile-link helper.
 *
 * Wraps the per-pair `linkTransactionToBankCore` (the transactional core of
 * `linkTransactionToBank`) in a loop, each pair in its OWN db.transaction =
 * a natural per-pair "savepoint": a failed pair rolls back only its own tx,
 * the rest still commit (partial commit). Results are POSITIONAL with the
 * input. `invalidateUser(userId)` fires EXACTLY ONCE after the batch.
 *
 * Covers test-plan:
 *   tc-1-ten-positional   — 10 valid pairs → 10 positional results w/ linkId.
 *   tc-2-partial-commit   — 1 invalid id among 10 → 9 land, 1 carries error.
 *   tc-3-idempotent       — re-submit already-linked pair → alreadyLinked, no dup.
 *   tc-4-invalidate-once  — invalidateUser called exactly once after the batch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER =
  process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY =
  process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// Per-transaction id → ownership row + existing-link map, keyed by
// bankTransactionId so the mock can model distinct pairs in one batch.
const state = vi.hoisted(() => ({
  // bankTransactionId -> ownership SELECT row (null = tx not found for user)
  owns: new Map<string, Record<string, unknown> | null>(),
  // bankTransactionId -> existing link row (null = no existing link)
  existing: new Map<string, { id: number } | null>(),
  // running counter for fresh inserted link ids
  nextInsertId: 1000,
  // number of INSERTs actually performed (to assert "no duplicate link")
  inserts: 0,
  // bank id of the core call currently in flight (set per-pair, FIFO order)
  __currentBank: undefined as string | undefined,
}));

vi.mock("@/db", () => {
  return {
    // db.transaction is re-implemented per test via primePairs() so it can pop
    // the next bank id (FIFO, input order — exactly how linkTransactionsToBank
    // loops). The default impl here is a placeholder that primePairs overrides.
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({}),
      ),
    },
    schema: new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => ({}) }) },
    ),
  };
});

vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: vi.fn() }));

import {
  linkTransactionsToBank,
  type BulkLinkPair,
} from "../src/lib/reconcile/links";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";

const USER = "user-216";

// linkTransactionsToBank processes pairs sequentially, calling db.transaction
// once per pair (FIFO, input order). The core reads input.bankTransactionId
// but the mock can't see it directly — so primePairs() drives a FIFO queue of
// bank ids in input order; each db.transaction invocation pops the next one and
// builds a tx mock that returns that bank's ownership / existing-link state.
import * as dbmod from "@/db";

function primePairs(pairs: BulkLinkPair[]) {
  const queue = pairs.map((p) => p.bankTransactionId);
  (dbmod.db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (cb: (tx: unknown) => unknown) => {
      state.__currentBank = queue.shift();
      return cb(makeTxFor(state.__currentBank as string));
    },
  );
}

// Rebuild the same tx mock the module factory uses, but accessible here.
function makeTxFor(bankId: string) {
  let selectCall = 0;
  const tx: Record<string, unknown> = {};
  tx.select = vi.fn(() => {
    const which = selectCall++;
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(() => {
      if (which === 0) {
        const r = state.owns.get(bankId) ?? null;
        return r ? [r] : [];
      }
      const e = state.existing.get(bankId) ?? null;
      return e ? [e] : [];
    });
    return chain;
  });
  tx.insert = vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => {
        state.inserts++;
        return [{ id: state.nextInsertId++ }];
      }),
    })),
  }));
  tx.update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => []) })),
    })),
  }));
  return tx;
}

beforeEach(() => {
  state.owns = new Map();
  state.existing = new Map();
  state.nextInsertId = 1000;
  state.inserts = 0;
  state.__currentBank = undefined;
  vi.mocked(invalidateUser).mockClear();
});

function bankId(n: number): string {
  // deterministic uuid-ish key (not validated by the helper)
  return `bank-${String(n).padStart(4, "0")}`;
}

describe("linkTransactionsToBank (FINLYNQ-216)", () => {
  it("tc-1: 10 valid pairs → 10 positional results, each with a linkId", async () => {
    const pairs: BulkLinkPair[] = [];
    for (let i = 0; i < 10; i++) {
      const b = bankId(i);
      state.owns.set(b, {
        txId: 100 + i,
        txAccountId: 7,
        currentFk: null,
        bankId: b,
        bankAccountId: 7,
      });
      pairs.push({ transactionId: 100 + i, bankTransactionId: b, linkType: "primary" });
    }
    primePairs(pairs);

    const res = await linkTransactionsToBank(USER, pairs, "manual");

    expect(res).toHaveLength(10);
    res.forEach((r, i) => {
      // positional: result[i] matches pairs[i]
      expect(r.transactionId).toBe(pairs[i].transactionId);
      expect(r.bankTransactionId).toBe(pairs[i].bankTransactionId);
      expect(r.error).toBeUndefined();
      expect(typeof r.linkId).toBe("number");
      expect(r.linkId).not.toBeNull();
      expect(r.setPrimaryFk).toBe(true);
      expect(r.alreadyLinked).toBe(false);
    });
    expect(state.inserts).toBe(10);
  });

  it("tc-2: 1 invalid id among 10 → 9 commit, only the failed element carries error", async () => {
    const pairs: BulkLinkPair[] = [];
    for (let i = 0; i < 10; i++) {
      const b = bankId(i);
      if (i === 4) {
        // tx not found for user → ownership SELECT empty → LinkError('not_found')
        state.owns.set(b, null);
      } else {
        state.owns.set(b, {
          txId: 100 + i,
          txAccountId: 7,
          currentFk: null,
          bankId: b,
          bankAccountId: 7,
        });
      }
      pairs.push({ transactionId: 100 + i, bankTransactionId: b, linkType: "primary" });
    }
    primePairs(pairs);

    const res = await linkTransactionsToBank(USER, pairs, "manual");

    expect(res).toHaveLength(10);
    const failed = res.filter((r) => r.error != null);
    expect(failed).toHaveLength(1);
    expect(failed[0].transactionId).toBe(104);
    expect(failed[0].linkId).toBeNull();
    // The other 9 committed.
    const ok = res.filter((r) => r.error == null);
    expect(ok).toHaveLength(9);
    ok.forEach((r) => expect(typeof r.linkId).toBe("number"));
    expect(state.inserts).toBe(9);
    // Positional integrity preserved.
    expect(res[4].error).toBeTruthy();
    expect(res[3].error).toBeUndefined();
    expect(res[5].error).toBeUndefined();
  });

  it("tc-2b: a cross-account pair carries the cross_account error, batch still commits", async () => {
    const pairs: BulkLinkPair[] = [];
    for (let i = 0; i < 3; i++) {
      const b = bankId(i);
      state.owns.set(b, {
        txId: 200 + i,
        txAccountId: 7,
        currentFk: null,
        bankId: b,
        bankAccountId: i === 1 ? 8 : 7, // pair #1 is cross-account
      });
      pairs.push({ transactionId: 200 + i, bankTransactionId: b, linkType: "primary" });
    }
    primePairs(pairs);

    const res = await linkTransactionsToBank(USER, pairs, "manual");
    expect(res[1].error).toMatch(/different accounts/i);
    expect(res[0].error).toBeUndefined();
    expect(res[2].error).toBeUndefined();
    expect(state.inserts).toBe(2);
  });

  it("tc-3: re-submitting an already-linked pair → alreadyLinked:true, no error, no duplicate insert", async () => {
    const b = bankId(0);
    state.owns.set(b, {
      txId: 300,
      txAccountId: 7,
      currentFk: "bank-existing",
      bankId: b,
      bankAccountId: 7,
    });
    // Existing link row found → core returns alreadyLinked without inserting.
    state.existing.set(b, { id: 777 });
    const pairs: BulkLinkPair[] = [
      { transactionId: 300, bankTransactionId: b, linkType: "primary" },
    ];
    primePairs(pairs);

    const res = await linkTransactionsToBank(USER, pairs, "manual");
    expect(res).toHaveLength(1);
    expect(res[0].alreadyLinked).toBe(true);
    expect(res[0].error).toBeUndefined();
    expect(res[0].linkId).toBe(777);
    expect(res[0].setPrimaryFk).toBe(false);
    // No duplicate link inserted.
    expect(state.inserts).toBe(0);
  });

  it("tc-4: invalidateUser is invoked exactly once after the batch", async () => {
    const pairs: BulkLinkPair[] = [];
    for (let i = 0; i < 5; i++) {
      const b = bankId(i);
      state.owns.set(b, {
        txId: 400 + i,
        txAccountId: 7,
        currentFk: null,
        bankId: b,
        bankAccountId: 7,
      });
      pairs.push({ transactionId: 400 + i, bankTransactionId: b, linkType: "primary" });
    }
    primePairs(pairs);

    await linkTransactionsToBank(USER, pairs, "manual");
    expect(vi.mocked(invalidateUser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateUser)).toHaveBeenCalledWith(USER);
  });
});
