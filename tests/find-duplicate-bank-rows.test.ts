/**
 * FINLYNQ-213 (R-06) — pure grouping core for the find_duplicate_bank_rows
 * read-only MCP tool.
 *
 * The tool loads + tier-decrypts bank_transactions rows; this helper groups
 * DISTINCT ids that share the same economic event (date, amount, payee).
 * Load-bearing correction: seen_count is NOT the duplicate signal.
 */

import { describe, it, expect } from "vitest";
import {
  findDuplicateBankRows,
  type DuplicateBankInputRow,
} from "../src/lib/reconcile/find-duplicate-bank-rows";

function row(
  over: Partial<DuplicateBankInputRow> & { id: string },
): DuplicateBankInputRow {
  return {
    date: "2026-06-01",
    amount: -42.5,
    payeePlain: "Tim Hortons",
    importHash: `hash-${over.id}`,
    seenCount: 1,
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    linkedTransactionId: null,
    ...over,
  };
}

describe("findDuplicateBankRows", () => {
  it("tc-1: three distinct rows for one event collapse into one group", () => {
    const rows = [
      row({ id: "a", firstSeenAt: "2026-06-03T10:00:00.000Z" }),
      row({ id: "b", firstSeenAt: "2026-06-01T08:00:00.000Z" }), // oldest
      row({ id: "c", firstSeenAt: "2026-06-05T12:00:00.000Z" }),
    ];
    const groups = findDuplicateBankRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe("b"); // oldest by first_seen_at
    expect(groups[0].duplicateIds.sort()).toEqual(["a", "c"]);
    expect(groups[0].duplicateIds).toHaveLength(2);
    expect(groups[0].linkedTransactionId).toBeUndefined();
  });

  it("tc-2: a group with one linked row populates linkedTransactionId", () => {
    const rows = [
      row({ id: "a", firstSeenAt: "2026-06-01T00:00:00.000Z" }),
      row({
        id: "b",
        firstSeenAt: "2026-06-02T00:00:00.000Z",
        linkedTransactionId: 7777,
      }),
    ];
    const groups = findDuplicateBankRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].linkedTransactionId).toBe(7777);
  });

  it("tc-3: an account with no duplicates returns []", () => {
    const rows = [
      row({ id: "a", payeePlain: "Tim Hortons" }),
      row({ id: "b", payeePlain: "Starbucks", amount: -9.99 }),
      row({ id: "c", payeePlain: "Loblaws", amount: -120 }),
    ];
    expect(findDuplicateBankRows(rows)).toEqual([]);
  });

  it("tc-4: seen_count > 1 on a single row is NOT a duplicate", () => {
    // Re-importing the same row bumps seen_count on the existing single row;
    // a single id can never be a duplicate group.
    const rows = [row({ id: "only", seenCount: 5 })];
    expect(findDuplicateBankRows(rows)).toEqual([]);
  });

  it("payee normalization groups whitespace/case variants of the same event", () => {
    const rows = [
      row({ id: "a", payeePlain: "TIM  HORTONS " }),
      row({ id: "b", payeePlain: "tim hortons" }),
    ];
    const groups = findDuplicateBankRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].duplicateIds).toHaveLength(1);
  });

  it("different import_hash but matching date/amount/payee still groups (distinct ids)", () => {
    const rows = [
      row({ id: "a", importHash: "hashX" }),
      row({ id: "b", importHash: "hashY" }),
    ];
    const groups = findDuplicateBankRows(rows);
    expect(groups).toHaveLength(1);
  });

  it("ties on first_seen_at break deterministically on id", () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const groups = findDuplicateBankRows([
      row({ id: "z", firstSeenAt: ts }),
      row({ id: "a", firstSeenAt: ts }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe("a");
  });
});
