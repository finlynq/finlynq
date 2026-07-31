/**
 * Static wiring gate for staged-import resolution.
 *
 * WHY THIS EXISTS
 * ---------------
 * The resolution rule is a predicate, and a predicate's own unit tests pass
 * whether or not anything ever CALLS it. That gap has already shipped once: the
 * rule was wired into the post-promote path only, while
 * `sendStagedRowsToBankLedger` has a SECOND exit — the
 * `allSelected.length === 0 && !anchorsOnlyApprove` guard — that returns long
 * before it.
 *
 * That second exit is exactly the duplicates-only re-sync the fix was for.
 * Verified live on dev 2026-07-31 with two identical 3-row duplicates-only CSV
 * uploads into the same auto-mode account:
 *
 *   with a statement balance (→ anchorsOnlyApprove true)  → status 'approved'
 *   without one            (→ takes the early return)     → status 'pending'
 *
 * A SimpleFIN sync always carries a balance snapshot, which is why the feed
 * path looked fixed while a plain re-upload was still stuck.
 *
 * These are PURE source reads. They cannot prove runtime behaviour (the live
 * upload pair and the two-statement integration test do that); they catch the
 * regression that actually bit us: an exit path that forgets to resolve, or a
 * second place that closes a statement without filing it into Processed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const PROMOTE_SRC = path.join(ROOT, "src/lib/import/send-to-bank-ledger.ts");
const RESOLUTION_SRC = path.join(ROOT, "src/lib/import/statement-resolution.ts");
const promoteSource = readFileSync(PROMOTE_SRC, "utf8");
const resolutionSource = readFileSync(RESOLUTION_SRC, "utf8");

/**
 * Strip block and line comments. These files document the very identifiers
 * some assertions forbid, so a raw substring match would trip on prose.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Body of `sendStagedRowsToBankLedger`, from its signature to end of file. */
function promoteFnBody(): string {
  const start = promoteSource.indexOf("export async function sendStagedRowsToBankLedger");
  expect(start, "sendStagedRowsToBankLedger not found — did it get renamed?").toBeGreaterThan(-1);
  return promoteSource.slice(start);
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
        "duplicates-only import with no balance anchor parks in /import/pending forever",
    ).toContain("markImportResolvedIfDone(");
  });

  it("still resolves the import after a promote pass", () => {
    const body = promoteFnBody();
    const promoted = body.indexOf('rowStatus: "approved" })');
    expect(promoted).toBeGreaterThan(-1);
    expect(body.slice(promoted)).toContain("markImportResolvedIfDone(");
  });

  it("sweeps sibling statements for the account after a successful promote", () => {
    const body = promoteFnBody();
    expect(
      body,
      "processing a statement must re-probe the account's other pending statements — " +
        "a sibling staged before this one has frozen 'new' stamps and can never " +
        "resolve itself",
    ).toContain("sweepPendingStatementsForAccount(");

    // Must run after the promote writes, not before them.
    const promoted = body.indexOf('rowStatus: "approved" })');
    expect(body.indexOf("sweepPendingStatementsForAccount(")).toBeGreaterThan(promoted);
  });

  it("closes a statement in exactly one place, and that place also files it into Processed", () => {
    // A second hand-rolled `status: 'approved'` update would be a place the rule
    // can be bypassed — and, worse, a place a statement gets closed WITHOUT a
    // bank_upload_batches row, which makes it vanish from both lists.
    const promoteWrites = promoteSource.match(/status:\s*"approved"/g) ?? [];
    expect(
      promoteWrites.length,
      "send-to-bank-ledger.ts must not close statements itself — go through finishStatement",
    ).toBe(0);

    const resolutionWrites = resolutionSource.match(/status:\s*"approved"/g) ?? [];
    expect(resolutionWrites.length).toBe(1);

    const helperStart = resolutionSource.indexOf("export async function finishStatement");
    expect(helperStart).toBeGreaterThan(-1);
    expect(resolutionSource.indexOf('status: "approved"')).toBeGreaterThan(helperStart);
  });

  it("files the statement into Processed and closes it in ONE transaction", () => {
    const start = resolutionSource.indexOf("export async function finishStatement");
    const body = resolutionSource.slice(start);
    const txAt = body.indexOf("withDbTransaction");
    const batchAt = body.indexOf("insert(schema.bankUploadBatches)");
    const statusAt = body.indexOf('status: "approved"');
    expect(txAt, "finishStatement must wrap its writes in withDbTransaction").toBeGreaterThan(-1);
    expect(
      batchAt,
      "closing a statement without a batch row makes it invisible in BOTH lists — " +
        "the Processed panel is built from bank_upload_batches, not from status",
    ).toBeGreaterThan(txAt);
    expect(statusAt).toBeGreaterThan(txAt);
  });

  it("never re-runs fuzzy matching during the sweep", () => {
    // Fuzzy (same amount within N days) is fine at ingest because the row stays
    // visible for review. In a silent sweep a false match would close a
    // statement holding a genuinely new transaction. Rows already fuzzy-flagged
    // at ingest still qualify via reconcile_state, so nothing regresses.
    const code = codeOnly(resolutionSource);
    expect(code.toLowerCase()).not.toContain("fuzzy");
    expect(code).toContain("checkDuplicates(");
    expect(code).toContain("checkFitIdDuplicatesForAccount(");
  });

  it("does not re-enter the promote path from the sweep (no recursion)", () => {
    expect(
      codeOnly(resolutionSource),
      "sweepPendingStatementsForAccount must call finishStatement directly; calling " +
        "sendStagedRowsToBankLedger would make it recursive",
    ).not.toContain("sendStagedRowsToBankLedger");
  });
});
