/**
 * FINLYNQ-211 — `linkTransactionToBank` must reject a cross-account link.
 *
 * Root cause of the reported bug: the reconcile link write verified user
 * ownership of both the transaction and the bank row, but NOT that they
 * belong to the same account. A transfer leg in account A linked to a bank
 * row in account B then rendered "linked" in A's reconcile view even though
 * A's own statement never matched it — so a half-reconciled transfer read as
 * already-done.
 *
 * The match engine only ever SUGGESTS same-account pairs, so this guard is
 * purely a defense against the raw API / bulk / MCP accept paths. This test
 * drives the guard directly with a Drizzle-transaction mock:
 *   - same-account (tx.account_id === bank.account_id) → link succeeds.
 *   - cross-account (different account ids)            → LinkError('cross_account').
 *
 * Covers test-plan tc-1 (single-side link / no cross-account leak) at the
 * write boundary that produces the bug.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER =
  process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY =
  process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// Per-test knobs for what the ownership SELECT returns + whether an existing
// link row is found.
const state = vi.hoisted(() => ({
  ownsRow: null as Record<string, unknown> | null,
  existingLink: null as { id: number } | null,
  insertedId: 4242,
}));

vi.mock("@/db", () => {
  // The ownership SELECT is the FIRST select() inside the tx; the existing-link
  // SELECT is the SECOND. We track call order on the tx handle.
  function makeTx() {
    let selectCall = 0;
    const tx: Record<string, unknown> = {};
    tx.select = vi.fn(() => {
      const which = selectCall++;
      const chain: Record<string, unknown> = {};
      for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy"]) {
        chain[m] = vi.fn(() => chain);
      }
      chain.limit = vi.fn(() =>
        which === 0
          ? state.ownsRow
            ? [state.ownsRow]
            : []
          : state.existingLink
            ? [state.existingLink]
            : [],
      );
      return chain;
    });
    tx.insert = vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => [{ id: state.insertedId }]),
      })),
    }));
    tx.update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => []) })) })),
    }));
    return tx;
  }
  return {
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(makeTx())),
    },
    schema: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
  };
});

vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: vi.fn() }));

import { linkTransactionToBank, LinkError } from "../src/lib/reconcile/links";

const USER = "user-211";

beforeEach(() => {
  state.ownsRow = null;
  state.existingLink = null;
});

describe("linkTransactionToBank — same-account guard (FINLYNQ-211)", () => {
  it("links a same-account (tx, bank) pair", async () => {
    state.ownsRow = {
      txId: 100,
      txAccountId: 7,
      currentFk: null,
      bankId: "bank-uuid-1",
      bankAccountId: 7,
    };
    const res = await linkTransactionToBank({
      userId: USER,
      transactionId: 100,
      bankTransactionId: "bank-uuid-1",
      linkType: "primary",
      source: "manual",
    });
    expect(res.alreadyLinked).toBe(false);
    expect(res.linkId).toBe(state.insertedId);
    expect(res.setPrimaryFk).toBe(true);
  });

  it("rejects a cross-account link with LinkError('cross_account')", async () => {
    // Transfer leg in account 7 (tx) ↔ bank row in account 8: the exact shape
    // that made a transfer's peer leg read as linked.
    state.ownsRow = {
      txId: 100,
      txAccountId: 7,
      currentFk: null,
      bankId: "bank-uuid-2",
      bankAccountId: 8,
    };
    await expect(
      linkTransactionToBank({
        userId: USER,
        transactionId: 100,
        bankTransactionId: "bank-uuid-2",
        linkType: "primary",
        source: "manual",
      }),
    ).rejects.toMatchObject({ name: "LinkError", code: "cross_account" });
  });

  it("still 404s (not_found) when the bank row is missing for the user", async () => {
    state.ownsRow = {
      txId: 100,
      txAccountId: 7,
      currentFk: null,
      bankId: null, // leftJoin produced no bank row
      bankAccountId: null,
    };
    await expect(
      linkTransactionToBank({
        userId: USER,
        transactionId: 100,
        bankTransactionId: "missing",
        linkType: "primary",
        source: "manual",
      }),
    ).rejects.toMatchObject({ name: "LinkError", code: "not_found" });
  });

  it("LinkError carries the documented union codes", () => {
    expect(new LinkError("not_found", "x").code).toBe("not_found");
    expect(new LinkError("cross_account", "y").code).toBe("cross_account");
  });
});
