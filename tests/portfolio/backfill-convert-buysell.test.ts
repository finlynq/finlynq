/**
 * Phase 1 of the backfill paired kind-override feature:
 * `convertExistingToBuySellPair` converts a refused orphan stock-leg row into
 * a canonical Buy/Sell pair (synth_new counterpart).
 *
 * These tests are DB-free:
 *   - `normalizeBuySellLegs` is pure (the sign-convention core).
 *   - The converter's early validation throws BEFORE any DB call, so the
 *     refusal codes can be asserted with a dummy tx handle.
 * Full pair-write + lot-replay + undo round-trip is covered by the on-dev
 * end-to-end verification in the plan.
 */

import { describe, it, expect } from "vitest";

// Stable env so the crypto/auth modules in the import chain don't throw at load.
process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import {
  normalizeBuySellLegs,
  convertExistingToBuySellPair,
  convertExistingToBrokeragePair,
  convertExistingToFxPair,
  convertExistingToInKindTransferPair,
  type OrphanRowForConvert,
  type CounterpartRowForConvert,
} from "@/lib/portfolio/operations";

describe("normalizeBuySellLegs", () => {
  it("buy: stock +amount/+qty, cash -amount/-qty, sum = 0", () => {
    const r = normalizeBuySellLegs("buy", -2000, 10); // legacy input sign irrelevant
    expect(r.stockAmount).toBe(2000);
    expect(r.stockQty).toBe(10);
    expect(r.cashAmount).toBe(-2000);
    expect(r.cashQty).toBe(-2000);
    expect(r.stockAmount + r.cashAmount).toBe(0);
  });

  it("sell: stock -amount/-qty, cash +amount/+qty, sum = 0", () => {
    const r = normalizeBuySellLegs("sell", 900, -4);
    expect(r.stockAmount).toBe(-900);
    expect(r.stockQty).toBe(-4);
    expect(r.cashAmount).toBe(900);
    expect(r.cashQty).toBe(900);
    expect(r.stockAmount + r.cashAmount).toBe(0);
  });

  it("normalizes regardless of the orphan row's input signs", () => {
    expect(normalizeBuySellLegs("buy", 2000, -10)).toEqual({
      stockAmount: 2000,
      stockQty: 10,
      cashAmount: -2000,
      cashQty: -2000,
    });
  });
});

const dummyTx = {} as never;

function orphan(partial: Partial<OrphanRowForConvert>): OrphanRowForConvert {
  return {
    id: 1,
    date: "2025-01-01",
    accountId: 42,
    portfolioHoldingId: 100,
    currency: "USD",
    amount: -1000,
    quantity: 5,
    categoryId: null,
    payee: null,
    note: null,
    tags: null,
    ...partial,
  };
}

describe("convertExistingToBuySellPair — early validation (no DB)", () => {
  it("refuses an orphan with no account", async () => {
    await expect(
      convertExistingToBuySellPair({ tx: dummyTx, userId: "u", orphan: orphan({ accountId: null }), direction: "buy", mode: "synth_new" }),
    ).rejects.toMatchObject({ code: "orphan_no_account" });
  });

  it("refuses an orphan with no holding (can't be a stock leg)", async () => {
    await expect(
      convertExistingToBuySellPair({ tx: dummyTx, userId: "u", orphan: orphan({ portfolioHoldingId: null }), direction: "buy", mode: "synth_new" }),
    ).rejects.toMatchObject({ code: "orphan_not_stock_leg" });
  });

  it("refuses an orphan with zero quantity", async () => {
    await expect(
      convertExistingToBuySellPair({ tx: dummyTx, userId: "u", orphan: orphan({ quantity: 0 }), direction: "sell", mode: "synth_new" }),
    ).rejects.toMatchObject({ code: "orphan_zero_qty" });
  });
});

function cp(partial: Partial<CounterpartRowForConvert>): CounterpartRowForConvert {
  return {
    id: 2,
    accountId: 99,
    currency: "USD",
    amount: 1000,
    quantity: 1000,
    portfolioHoldingId: null,
    kind: null,
    tradeLinkId: null,
    linkId: null,
    ...partial,
  };
}

describe("cross-account converters — early validation (no DB)", () => {
  it("brokerage refuses a null-holding orphan (not a cash-sleeve leg)", async () => {
    await expect(
      convertExistingToBrokeragePair({
        tx: dummyTx,
        userId: "u",
        orphan: orphan({ portfolioHoldingId: null }),
        counterpart: cp({}),
        orphanLeg: "brokerage_deposit_in",
      }),
    ).rejects.toMatchObject({ code: "orphan_not_cash_sleeve_leg" });
  });

  it("fx refuses an already-linked counterpart", async () => {
    await expect(
      convertExistingToFxPair({
        tx: dummyTx,
        userId: "u",
        orphan: orphan({ accountId: 42, currency: "USD" }),
        counterpart: cp({ accountId: 42, currency: "EUR", linkId: "x" }),
        orphanLeg: "fx_from",
      }),
    ).rejects.toMatchObject({ code: "counterpart_already_linked" });
  });

  it("fx refuses a counterpart in a different account", async () => {
    await expect(
      convertExistingToFxPair({
        tx: dummyTx,
        userId: "u",
        orphan: orphan({ accountId: 42, currency: "USD" }),
        counterpart: cp({ accountId: 99, currency: "EUR" }),
        orphanLeg: "fx_from",
      }),
    ).rejects.toMatchObject({ code: "counterpart_account_mismatch" });
  });

  it("fx refuses a same-currency counterpart", async () => {
    await expect(
      convertExistingToFxPair({
        tx: dummyTx,
        userId: "u",
        orphan: orphan({ accountId: 42, currency: "USD" }),
        counterpart: cp({ accountId: 42, currency: "USD" }),
        orphanLeg: "fx_from",
      }),
    ).rejects.toMatchObject({ code: "counterpart_currency_mismatch" });
  });

  it("transfer refuses a counterpart referencing a different holding", async () => {
    // accountId differs + holding differs; the same-account guard fires first,
    // so use a different account with a mismatched holding to reach the holding
    // check. (Same-account would throw counterpart_same_account first.)
    await expect(
      convertExistingToInKindTransferPair({
        tx: dummyTx,
        userId: "u",
        orphan: orphan({ accountId: 42, portfolioHoldingId: 100 }),
        counterpart: cp({ accountId: 99, portfolioHoldingId: 200 }),
        orphanLeg: "in_kind_transfer_out",
      }),
    ).rejects.toMatchObject({ code: "counterpart_holding_mismatch" });
  });

  it("transfer refuses a null-holding orphan", async () => {
    await expect(
      convertExistingToInKindTransferPair({
        tx: dummyTx,
        userId: "u",
        orphan: orphan({ portfolioHoldingId: null }),
        counterpart: cp({}),
        orphanLeg: "in_kind_transfer_out",
      }),
    ).rejects.toMatchObject({ code: "orphan_not_stock_leg" });
  });
});
