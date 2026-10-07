/**
 * PUT /api/transactions must not rewrite one leg of a transfer pair's money
 * fields on its own (found reviewing the mobile app, 2026-10-07: its generic
 * Edit saved a single leg here, leaving the partner leg out of step).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { transferLegChanges, type TransferLegSnapshot } from "@/lib/transactions/transfer-leg-guard";

const leg: TransferLegSnapshot = {
  amount: -500,
  accountId: 7,
  date: "2026-10-01",
  currency: "USD",
  enteredAmount: -500,
  enteredCurrency: "USD",
};

describe("transferLegChanges", () => {
  it("flags every money-moving field the patch changes", () => {
    expect(
      transferLegChanges(leg, {
        amount: -450,
        accountId: 9,
        date: "2026-10-02",
        currency: "EUR",
        enteredAmount: -400,
        enteredCurrency: "EUR",
      }),
    ).toEqual(["amount", "account", "date", "currency", "entered amount", "entered currency"]);
  });

  it("lets a full-form save through when the values are unchanged", () => {
    expect(
      transferLegChanges(leg, {
        amount: -500.001, // sub-cent float noise
        accountId: 7,
        date: "2026-10-01",
        currency: "usd",
        enteredAmount: -500,
        enteredCurrency: "USD",
      }),
    ).toEqual([]);
  });

  it("ignores fields the patch doesn't touch", () => {
    expect(transferLegChanges(leg, {})).toEqual([]);
  });

  it("treats setting or clearing an entered amount as a change", () => {
    expect(transferLegChanges({ ...leg, enteredAmount: null }, { enteredAmount: -500 })).toEqual(["entered amount"]);
    expect(transferLegChanges(leg, { enteredAmount: null })).toEqual(["entered amount"]);
  });
});

describe("PUT /api/transactions wiring", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/app/api/transactions/route.ts"), "utf8");
  const put = src.slice(src.indexOf("export async function PUT"));

  it("checks the transfer-leg guard before the row is written", () => {
    const guardAt = put.indexOf("transferLegChanges(leg, data)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(put.indexOf("updateTransaction("));
  });

  it("only refuses while a partner leg exists, and says which fields", () => {
    expect(put).toMatch(/ne\(schema\.transactions\.id, id\)/);
    expect(put).toMatch(/if \(partner\)/);
    expect(put).toMatch(/code: "transfer_leg_edit_refused"/);
    expect(put).toMatch(/status: 409/);
  });
});
