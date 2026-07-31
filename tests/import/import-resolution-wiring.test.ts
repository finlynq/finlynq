/**
 * Static wiring gate for `markImportResolvedIfDone` (src/lib/import/send-to-bank-ledger.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * `importFullyResolved` is a pure predicate and its own unit tests pass whether
 * or not anything ever CALLS it. That gap shipped: the predicate was wired into
 * the post-promote path only, while `sendStagedRowsToBankLedger` has a SECOND
 * exit — the `allSelected.length === 0 && !anchorsOnlyApprove` guard — that
 * returns long before it.
 *
 * That second exit is exactly the dupe-only re-sync the fix was for. Every row
 * is `skipped_duplicate`, every row is excluded from promotion, so ZERO rows are
 * selected and the function bails. Verified live on dev 2026-07-31 with two
 * identical 3-row dupe-only CSV uploads into the same auto-mode account:
 *
 *   with a statement balance (→ anchorsOnlyApprove true)  → status 'approved'
 *   without one            (→ takes the early return)     → status 'pending'
 *
 * A SimpleFIN sync always carries a balance snapshot, which is why the feed
 * path looked fixed while a plain re-upload was still stuck.
 *
 * This test is PURE — it reads the module as text. It cannot prove the runtime
 * outcome (the live upload pair above did that); it catches the regression that
 * actually bit us: an exit path that forgets to resolve the import.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../../src/lib/import/send-to-bank-ledger.ts");
const source = readFileSync(SRC, "utf8");

/** Body of `sendStagedRowsToBankLedger`, from its signature to end of file. */
function promoteFnBody(): string {
  const start = source.indexOf("export async function sendStagedRowsToBankLedger");
  expect(start, "sendStagedRowsToBankLedger not found — did it get renamed?").toBeGreaterThan(-1);
  return source.slice(start);
}

describe("staged-import resolution wiring", () => {
  it("resolves the import on the nothing-eligible early return, not just after promoting", () => {
    const body = promoteFnBody();
    const guard = body.indexOf('code: "not_found", message: "No rows selected"');
    expect(guard, "the empty-selection guard moved — re-point this test").toBeGreaterThan(-1);

    // The resolver must run BEFORE that return, inside the same block.
    const blockStart = body.lastIndexOf("if (allSelected.length === 0", guard);
    expect(blockStart).toBeGreaterThan(-1);
    const block = body.slice(blockStart, guard);
    expect(
      block,
      "the empty-selection exit must call markImportResolvedIfDone — otherwise a " +
        "dupe-only import with no balance anchor parks in /import/pending forever",
    ).toContain("markImportResolvedIfDone(");
  });

  it("still resolves the import after a promote pass", () => {
    const body = promoteFnBody();
    const promoted = body.indexOf('rowStatus: "approved" })');
    expect(promoted).toBeGreaterThan(-1);
    expect(body.slice(promoted)).toContain("markImportResolvedIfDone(");
  });

  it("routes every 'mark the import approved' write through the resolver", () => {
    // A second hand-rolled `status: 'approved'` update would be a place the
    // predicate can be bypassed again. The only one should be inside the helper.
    const writes = source.match(/status:\s*"approved"/g) ?? [];
    expect(writes.length).toBe(1);
    const helperStart = source.indexOf("async function markImportResolvedIfDone");
    expect(helperStart).toBeGreaterThan(-1);
    expect(source.indexOf('status: "approved"')).toBeGreaterThan(helperStart);
  });
});
