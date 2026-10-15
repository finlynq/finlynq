/**
 * The public demo carries a car loan (2026-10-14).
 *
 * The Loans page left dev mode on 2026-10-12, so demo visitors could open it,
 * but the nightly reseed had no loan: the page, its schedule and its interest
 * entries were all empty. The seed now books one the way the app does
 * (opening balance on a liability account, each payment a transfer pair from
 * Chequing, each payment's interest a separate expense on the loan account)
 * and links the loan to that account and its interest category. Verified
 * end-to-end against a scratch database built with `npm run db:migrate`.
 *
 * Static gate over the seed source: these are the pieces whose absence would
 * silently leave a loan the app can't read (no linked account → a projected
 * balance only; no interest category → nothing counts as booked; payments
 * without a link id → reports read them as spending).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SEED = readFileSync(path.resolve(__dirname, "../scripts/seed-demo.ts"), "utf8");

describe("demo seed: car loan", () => {
  it("has a liability account for the loan and the categories it books under", () => {
    expect(SEED).toMatch(/\{ type: "L", group: "Loans", name: "Car Loan" \}/);
    expect(SEED).toMatch(/\{ type: "E", group: "Financial", name: "Loan interest" \}/);
    // The canonical names the app resolves transfers and opening balances by.
    expect(SEED).toMatch(/\{ type: "R", group: "Transfer", name: "Transfer" \}/);
    expect(SEED).toMatch(/\{ type: "R", group: "Adjustments", name: "Opening Balance" \}/);
  });

  it("builds the payments from the app's own schedule", () => {
    expect(SEED).toContain('import { buildLoanSchedule } from "../src/lib/loan-calculator";');
    expect(SEED).toMatch(/plan\.schedule\.filter\(\(r\) => r\.date <= todayIso\)/);
  });

  it("books each payment as a transfer pair sharing one link id", () => {
    expect(SEED).toMatch(/insertTx\(row\.date, chequingId, categoryIds\["Transfer"\], -row\.payment, "Car loan payment", \{ linkId \}\)/);
    expect(SEED).toMatch(/insertTx\(row\.date, carAccountId, categoryIds\["Transfer"\], row\.payment, "Car loan payment", \{ linkId \}\)/);
  });

  it("books the opening balance with the kind the app recognises", () => {
    expect(SEED).toMatch(/-CAR_LOAN\.principal, "Opening balance", \{\s*kind: "opening_balance",\s*\}/);
  });

  it("links the loan to its account and its interest category", () => {
    const insert = SEED.slice(SEED.indexOf("INSERT INTO loans"));
    expect(insert).toContain("interest_category_id");
    expect(insert).toContain('categoryIds["Loan interest"]');
    expect(insert).toContain("carAccountId");
  });

  // The wipe must remove the loan before the accounts it points at, or the
  // nightly reseed stops half-way on the foreign key.
  it("wipes loans before accounts", () => {
    const wipe = SEED.slice(SEED.indexOf("Wiping existing demo data"));
    expect(wipe.indexOf('"loans"')).toBeGreaterThan(-1);
    expect(wipe.indexOf('"loans"')).toBeLessThan(wipe.indexOf("DELETE FROM accounts"));
  });
});
