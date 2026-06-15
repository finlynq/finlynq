/**
 * FINLYNQ-159 — reject non-finite / out-of-range numeric amounts at import
 * preview.
 *
 * Covers the two pure cores that gate the preview boundary:
 *  - `isReasonableAmount` / `MAX_REASONABLE_AMOUNT` (the bound itself).
 *  - `findUnreasonableAmountError` (the scanner the OFX/QFX/IBKR preview
 *    branches run over already-parsed rows that skip `previewImport`).
 *
 * The `1e29` value from the audit is the headline case; we also assert the
 * exact boundary (1e12 in, 1e12+1 out), non-finite values, and that the
 * scanner inspects amount, entered amount, and quantity.
 */
import { describe, it, expect } from "vitest";
import {
  isReasonableAmount,
  MAX_REASONABLE_AMOUNT,
} from "@/lib/utils/number";
import { findUnreasonableAmountError } from "@/lib/import-pipeline";

describe("isReasonableAmount", () => {
  it("accepts ordinary in-range values", () => {
    expect(isReasonableAmount(0)).toBe(true);
    expect(isReasonableAmount(-12.34)).toBe(true);
    expect(isReasonableAmount(999_999.99)).toBe(true);
    expect(isReasonableAmount(1_000_000_000)).toBe(true);
  });

  it("accepts exactly the bound and rejects just past it", () => {
    expect(isReasonableAmount(MAX_REASONABLE_AMOUNT)).toBe(true);
    expect(isReasonableAmount(-MAX_REASONABLE_AMOUNT)).toBe(true);
    expect(isReasonableAmount(MAX_REASONABLE_AMOUNT + 1)).toBe(false);
    expect(isReasonableAmount(-(MAX_REASONABLE_AMOUNT + 1))).toBe(false);
  });

  it("rejects the audit's absurd value (1e29) in both signs", () => {
    expect(isReasonableAmount(1e29)).toBe(false);
    expect(isReasonableAmount(-1e29)).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(isReasonableAmount(NaN)).toBe(false);
    expect(isReasonableAmount(Infinity)).toBe(false);
    expect(isReasonableAmount(-Infinity)).toBe(false);
  });
});

describe("findUnreasonableAmountError", () => {
  it("returns null when every row is in range", () => {
    const rows = [
      { amount: 100 },
      { amount: -50.25, enteredAmount: -55, quantity: 3 },
    ];
    expect(findUnreasonableAmountError(rows)).toBeNull();
  });

  it("flags an out-of-range amount and names the row + field", () => {
    const rows = [{ amount: 12 }, { amount: 1e29 }];
    const err = findUnreasonableAmountError(rows);
    expect(err).not.toBeNull();
    expect(err).toContain("Row 2");
    expect(err).toContain("amount");
    expect(err).toContain("out of range");
  });

  it("flags a non-finite amount", () => {
    expect(findUnreasonableAmountError([{ amount: Infinity }])).not.toBeNull();
    expect(findUnreasonableAmountError([{ amount: NaN }])).not.toBeNull();
  });

  it("inspects entered amount and quantity, not just amount", () => {
    expect(
      findUnreasonableAmountError([{ amount: 1, enteredAmount: 1e29 }]),
    ).toContain("entered amount");
    expect(
      findUnreasonableAmountError([{ amount: 1, quantity: 1e29 }]),
    ).toContain("quantity");
  });

  it("ignores absent optional numeric fields", () => {
    expect(
      findUnreasonableAmountError([{ amount: 1, enteredAmount: undefined, quantity: null }]),
    ).toBeNull();
  });
});
