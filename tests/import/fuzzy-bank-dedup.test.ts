/**
 * Payee-agnostic duplicate net for staged statement rows (planFuzzyBankSkips).
 *
 * Reported 2026-11-23: hand-typed transfers with no bank row had their
 * statement lines marked "already imported" because the net also matched
 * ledger transactions.
 * The lines never reached the bank ledger and the statement balance check was
 * off by their sum. These cases pin the two rules: bank-ledger rows only, and
 * one bank row per file row.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planFuzzyBankSkips,
  type FuzzyBankRow,
  type FuzzyFileRow,
} from "@/lib/import/fuzzy-bank-dedup";

const file = (o: Partial<FuzzyFileRow> & { rowIndex: number }): FuzzyFileRow => ({
  date: "2026-11-12",
  amount: 250,
  hash: `h${o.rowIndex}`,
  fitId: null,
  exact: false,
  ...o,
});
const bank = (o: Partial<FuzzyBankRow> & { id: string }): FuzzyBankRow => ({
  date: "2026-11-12",
  amount: 250,
  importHash: null,
  fitId: null,
  ...o,
});

describe("planFuzzyBankSkips", () => {
  it("skips a row whose amount is in the bank ledger within the window under another payee", () => {
    const skips = planFuzzyBankSkips(
      [file({ rowIndex: 0, date: "2026-11-12" })],
      [bank({ id: "b1", date: "2026-11-10" })],
      3,
    );
    expect([...skips]).toEqual([0]);
  });

  it("loads a row when the bank ledger has nothing of that amount (a ledger transaction alone never counts)", () => {
    // The caller passes bank rows only; with none of that amount the row loads.
    const skips = planFuzzyBankSkips(
      [file({ rowIndex: 0, amount: 250 })],
      [bank({ id: "b1", amount: -75 })],
      3,
    );
    expect(skips.size).toBe(0);
  });

  it("does not match outside the window", () => {
    const skips = planFuzzyBankSkips(
      [file({ rowIndex: 0, date: "2026-11-12" })],
      [bank({ id: "b1", date: "2026-11-08" })],
      3,
    );
    expect(skips.size).toBe(0);
  });

  it("lets one bank row cover only one file row", () => {
    // Two real payments of the same amount a day apart; the bank ledger holds one of them.
    const skips = planFuzzyBankSkips(
      [
        file({ rowIndex: 0, date: "2026-11-15", amount: -40 }),
        file({ rowIndex: 1, date: "2026-11-16", amount: -40 }),
      ],
      [bank({ id: "b1", date: "2026-11-16", amount: -40 })],
      3,
    );
    expect(skips.size).toBe(1);
  });

  it("gives an exactly matched bank row to its exact file row first", () => {
    // Row 1 is the exact match for b1; row 0 (same amount, a day earlier, new)
    // must not borrow it.
    const skips = planFuzzyBankSkips(
      [
        file({ rowIndex: 0, date: "2026-11-15", amount: -40 }),
        file({ rowIndex: 1, date: "2026-11-16", amount: -40, hash: "x", exact: true }),
      ],
      [bank({ id: "b1", date: "2026-11-16", amount: -40, importHash: "x" })],
      3,
    );
    expect(skips.size).toBe(0);
  });

  it("matches an exact row by bank id too", () => {
    const skips = planFuzzyBankSkips(
      [
        file({ rowIndex: 0, date: "2026-11-15", amount: -40 }),
        file({ rowIndex: 1, date: "2026-11-16", amount: -40, fitId: "F1", exact: true }),
      ],
      [bank({ id: "b1", date: "2026-11-16", amount: -40, fitId: "F1" })],
      3,
    );
    expect(skips.size).toBe(0);
  });

  it("takes the nearest bank row, leaving the other for the next file row", () => {
    const skips = planFuzzyBankSkips(
      [
        file({ rowIndex: 0, date: "2026-11-10" }),
        file({ rowIndex: 1, date: "2026-11-13" }),
      ],
      [bank({ id: "b1", date: "2026-11-10" }), bank({ id: "b2", date: "2026-11-14" })],
      3,
    );
    expect([...skips].sort()).toEqual([0, 1]);
  });

  it("never skips an exact row itself (the caller already marked it)", () => {
    const skips = planFuzzyBankSkips(
      [file({ rowIndex: 0, exact: true, hash: "x" })],
      [bank({ id: "b1", importHash: "x" })],
      3,
    );
    expect(skips.size).toBe(0);
  });
});

describe("writeStagedImport wiring", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "src", "lib", "import", "stage-statement-file.ts"),
    "utf8",
  );
  const start = src.indexOf("// ─── Feed fuzzy dedup");
  const end = src.indexOf("// ─── Already-imported probe");
  const block = src.slice(start, end);

  it("runs the fuzzy pass through planFuzzyBankSkips", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain("planFuzzyBankSkips(");
  });

  it("never reads ledger transactions in the fuzzy pass", () => {
    expect(block).not.toMatch(/schema\.transactions\b/);
    expect(block).toContain("schema.bankTransactions");
  });
});
