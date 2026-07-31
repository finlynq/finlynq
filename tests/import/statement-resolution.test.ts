/**
 * The stamp half of the statement-resolution rule.
 *
 * `rowResolvedByStamp` / `importFullyResolved` answer "is this row already
 * accounted for WITHOUT asking the ledger" — the cheap pre-filter that decides
 * which rows need a live probe. The ledger half (condition 3) is exercised by
 * the dev integration test, since it is a database round-trip by definition.
 *
 * Regression context: a duplicates-only re-sync marks nearly every row
 * `skipped_duplicate`, and those rows are DELIBERATELY excluded from promotion,
 * so they never receive a `row_status`. Counting them as outstanding is what
 * parked every dupe-heavy statement in /import/pending forever.
 */

import { describe, it, expect } from "vitest";
import {
  importFullyResolved,
  rowResolvedByStamp,
  type ResolutionRow,
} from "@/lib/import/statement-resolution";

function row(overrides: Partial<ResolutionRow> = {}): ResolutionRow {
  return { reconcileState: "unmatched", rowStatus: "pending", ...overrides };
}

describe("rowResolvedByStamp", () => {
  it("accepts a promoted row", () => {
    expect(rowResolvedByStamp(row({ rowStatus: "approved" }))).toBe(true);
  });

  it("accepts a duplicate flagged at ingest, even though it never promoted", () => {
    expect(
      rowResolvedByStamp(row({ reconcileState: "skipped_duplicate", rowStatus: "pending" })),
    ).toBe(true);
  });

  it("rejects a row that is still outstanding", () => {
    expect(rowResolvedByStamp(row())).toBe(false);
  });

  it("rejects a rejected row (the user's decision is not the ledger's)", () => {
    // Deliberate: `rejected` keeps the statement pending, unchanged from before.
    expect(rowResolvedByStamp(row({ rowStatus: "rejected" }))).toBe(false);
  });
});

describe("importFullyResolved", () => {
  it("is true for a duplicates-only re-sync", () => {
    expect(
      importFullyResolved([
        row({ reconcileState: "skipped_duplicate" }),
        row({ reconcileState: "skipped_duplicate" }),
      ]),
    ).toBe(true);
  });

  it("is true when the new rows promoted and the rest are duplicates", () => {
    expect(
      importFullyResolved([
        row({ rowStatus: "approved" }),
        row({ reconcileState: "skipped_duplicate" }),
        row({ reconcileState: "skipped_duplicate" }),
      ]),
    ).toBe(true);
  });

  it("is false when any row still needs action — all-or-nothing", () => {
    expect(importFullyResolved([row({ rowStatus: "approved" }), row()])).toBe(false);
  });

  it("is vacuously true for an empty set (callers must guard zero-row statements)", () => {
    // statementsFullyInLedger never returns a zero-row statement as finished;
    // an empty statement is an anchor-only sync, closed by the anchor branch.
    expect(importFullyResolved([])).toBe(true);
  });
});
