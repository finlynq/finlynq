/**
 * FINLYNQ — dupe-only re-syncs must leave /import/pending.
 *
 * Regression for the SimpleFIN "import hell" bug: an auto-mode account's
 * re-sync re-stages its whole history, dedup marks nearly every row
 * `skipped_duplicate`, and `sendStagedRowsToBankLedger` correctly promotes
 * only the genuinely-new rows. The staged import should then be marked
 * `approved` and disappear from the pending list — but the old
 * "any row with row_status != 'approved'" check counted the intentionally-
 * skipped duplicate rows as still-needing-action, so the import stayed
 * `pending` forever.
 *
 * `importFullyResolved` is the pure predicate behind that decision. A
 * `skipped_duplicate` row is resolved by construction (it was never meant to
 * promote); any other row is resolved only once its rowStatus is 'approved'.
 */

import { describe, it, expect } from "vitest";
import {
  importFullyResolved,
  type ResolutionRow,
} from "@/lib/import/send-to-bank-ledger";

function row(overrides: Partial<ResolutionRow> = {}): ResolutionRow {
  return {
    reconcileState: "unmatched",
    rowStatus: "pending",
    ...overrides,
  };
}

describe("importFullyResolved", () => {
  it("returns true for a dupe-only re-sync (every row skipped_duplicate, still pending)", () => {
    const rows = [
      row({ reconcileState: "skipped_duplicate", rowStatus: "pending" }),
      row({ reconcileState: "skipped_duplicate", rowStatus: "pending" }),
    ];
    expect(importFullyResolved(rows)).toBe(true);
  });

  it("returns true when new rows are approved and the rest are skipped duplicates", () => {
    const rows = [
      row({ reconcileState: "unmatched", rowStatus: "approved" }),
      row({ reconcileState: "skipped_duplicate", rowStatus: "pending" }),
      row({ reconcileState: "skipped_duplicate", rowStatus: "pending" }),
    ];
    expect(importFullyResolved(rows)).toBe(true);
  });

  it("returns false when a non-duplicate row is still pending (real work remains)", () => {
    const rows = [
      row({ reconcileState: "unmatched", rowStatus: "approved" }),
      row({ reconcileState: "unmatched", rowStatus: "pending" }),
    ];
    expect(importFullyResolved(rows)).toBe(false);
  });

  it("returns true for an empty row set", () => {
    expect(importFullyResolved([])).toBe(true);
  });
});
