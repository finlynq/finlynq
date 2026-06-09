/**
 * FINLYNQ-124 — unit tests for the pure bank-ledger staging projection helpers
 * behind the reframed /import Staging banner.
 */

import { describe, it, expect } from "vitest";
import type { DbTransactionRow } from "@/components/import/reconcile/db-pane";
import {
  latestBankLedgerBalance,
  sendableDelta,
  type SendableStagedRow,
} from "@/lib/import/bank-ledger-projection";

/** Minimal DbTransactionRow factory — only the fields the helper reads matter. */
function dbRow(
  date: string,
  runningBalance: number | null | undefined,
): DbTransactionRow {
  return {
    id: `bt-${date}-${Math.random()}`,
    bankTransactionId: `bt-${date}`,
    linkedTransactionId: null,
    date,
    amount: 0,
    currency: "USD",
    payee: null,
    category: null,
    note: null,
    txType: null,
    linkedStagedRowId: null,
    reconciliationFlag: null,
    runningBalance,
  };
}

function stagedRow(
  id: string,
  amount: number,
  opts: Partial<Pick<SendableStagedRow, "dedupStatus" | "reconcileState">> = {},
): SendableStagedRow {
  return { id, amount, ...opts };
}

describe("latestBankLedgerBalance", () => {
  it("returns the runningBalance of the latest-DATED row, even when input is out of order", () => {
    const rows = [
      dbRow("2026-01-10", 1000),
      dbRow("2026-03-05", 1500), // latest date — winner
      dbRow("2026-02-01", 1200),
    ];
    expect(latestBankLedgerBalance(rows)).toBe(1500);
  });

  it("ignores rows with null runningBalance when picking the latest dated row", () => {
    const rows = [
      dbRow("2026-01-10", 1000),
      dbRow("2026-03-05", null), // latest date but no balance → skipped
      dbRow("2026-02-01", 1200), // latest WITH a balance → winner
    ];
    expect(latestBankLedgerBalance(rows)).toBe(1200);
  });

  it("returns null when every row has a null/undefined runningBalance", () => {
    const rows = [
      dbRow("2026-01-10", null),
      dbRow("2026-02-01", undefined),
    ];
    expect(latestBankLedgerBalance(rows)).toBeNull();
  });

  it("returns null for an empty ledger", () => {
    expect(latestBankLedgerBalance([])).toBeNull();
  });

  it("preserves negative running balances (overdrawn account)", () => {
    const rows = [dbRow("2026-01-10", 100), dbRow("2026-02-01", -50)];
    expect(latestBankLedgerBalance(rows)).toBe(-50);
  });
});

describe("sendableDelta", () => {
  const rows: SendableStagedRow[] = [
    stagedRow("a", 100, { dedupStatus: "new" }),
    stagedRow("b", 200, { dedupStatus: "probable_duplicate" }),
    stagedRow("c", 300, { dedupStatus: "existing" }), // excluded: existing
    stagedRow("d", 400, { reconcileState: "skipped_duplicate" }), // excluded
    stagedRow("e", 500, { reconcileState: "linked" }), // excluded: linked
    stagedRow("f", -50, { reconcileState: "unmatched" }),
  ];

  it("counts/sums ONLY selected rows that pass the eligibility filter", () => {
    // Select every row; only a, b, f are eligible (c/d/e excluded by filter).
    const selected = new Set(["a", "b", "c", "d", "e", "f"]);
    expect(sendableDelta(rows, selected)).toEqual({
      count: 3,
      delta: 100 + 200 - 50, // 250
    });
  });

  it("excludes rows that are not selected", () => {
    const selected = new Set(["a"]); // only a selected
    expect(sendableDelta(rows, selected)).toEqual({ count: 1, delta: 100 });
  });

  it("excludes dedupStatus==='existing' even when selected", () => {
    const selected = new Set(["c"]);
    expect(sendableDelta(rows, selected)).toEqual({ count: 0, delta: 0 });
  });

  it("excludes reconcileState==='skipped_duplicate' even when selected", () => {
    const selected = new Set(["d"]);
    expect(sendableDelta(rows, selected)).toEqual({ count: 0, delta: 0 });
  });

  it("excludes reconcileState==='linked' even when selected", () => {
    const selected = new Set(["e"]);
    expect(sendableDelta(rows, selected)).toEqual({ count: 0, delta: 0 });
  });

  it("returns {count:0, delta:0} for an empty selection", () => {
    expect(sendableDelta(rows, new Set())).toEqual({ count: 0, delta: 0 });
  });
});
