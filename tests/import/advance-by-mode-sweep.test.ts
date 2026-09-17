/**
 * `advanceStagedImportByMode` — the auto-mode retroactive catch-up sweep
 * (GH #349, contributed by @amityweb; GH #332 is the same rows seen from the
 * Action Center's end).
 *
 * Two layers, deliberately:
 *
 *   1. BEHAVIOURAL, with `@/db` and the two write chokepoints stubbed. These
 *      pin the things that are easy to get subtly wrong and impossible to see
 *      in a diff: which rows reach `applyRulesToBankRows`, which of them are
 *      marked categorize-only, that the batch's own counters never absorb a
 *      stale row, and that the keyset cursor advances and wraps so a rule
 *      added later eventually reaches EVERY old row rather than the first page
 *      forever.
 *
 *   2. STATIC, following `tests/import/import-resolution-wiring.test.ts`. The
 *      sweep's value depends on it being REACHED on the `!promote.ok` path —
 *      the duplicates-only re-sync that is the whole point — and a behavioural
 *      test can only prove that for the mocked shape it was given. The source
 *      assertions catch the regression that actually ships: someone restoring
 *      the old `if (!promote.ok) return base;` early return, or dropping the
 *      `ORDER BY`/cursor and reintroducing starvation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// ─── db stub ───────────────────────────────────────────────────────────────
//
// The function issues its SELECTs in a fixed order, so the stub answers from a
// queue rather than trying to interpret the query AST:
//
//   [batch bank rows (only when promote.ok)] → settings cursor → stale page
//
// Anything left in the queue at the end of a case is a query that did not
// happen, and `expect(selectQueue).toHaveLength(0)` catches that.

const selectQueue: unknown[][] = [];
const settingsWrites: { value: unknown }[] = [];

function chain(rows: unknown[]): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "leftJoin", "orderBy", "limit", "offset", "groupBy"]) {
    c[m] = () => c;
  }
  c.all = () => rows;
  c.get = () => rows[0];
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
  return c;
}

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db/schema-pg")>("@/db/schema-pg");
  return {
    schema: actual,
    db: {
      select: () => {
        const rows = selectQueue.shift();
        if (rows === undefined) {
          throw new Error("db.select() called more times than the test queued results");
        }
        return chain(rows);
      },
      insert: () => ({
        values: (v: { value: unknown }) => ({
          onConflictDoUpdate: async () => {
            settingsWrites.push(v);
          },
        }),
      }),
    },
  };
});

const sendStagedRowsToBankLedger = vi.fn();
vi.mock("@/lib/import/send-to-bank-ledger", () => ({
  sendStagedRowsToBankLedger: (...a: unknown[]) => sendStagedRowsToBankLedger(...a),
}));

const applyRulesToBankRows = vi.fn();
vi.mock("@/lib/reconcile/match-engine", () => ({
  applyRulesToBankRows: (...a: unknown[]) => applyRulesToBankRows(...a),
}));

import { advanceStagedImportByMode } from "@/lib/import/advance-by-mode";

const USER = "user-1";
const DEK = Buffer.alloc(32, 7);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Per-row result shapes `applyRulesToBankRows` returns. */
const recordedRow = (id: string, txId: number) => ({
  bankRowId: id,
  matched: true,
  transactionId: txId,
});
const unmatchedRow = (id: string) => ({ bankRowId: id, matched: false });
const dupRow = (id: string) => ({
  bankRowId: id,
  matched: false,
  skipReason: "possible_ledger_duplicate",
});

function queueSelects(opts: { batch?: string[]; cursor?: string; stale: string[] }) {
  if (opts.batch) selectQueue.push(opts.batch.map((id) => ({ id })));
  selectQueue.push(opts.cursor ? [{ value: opts.cursor }] : []);
  selectQueue.push(opts.stale.map((id) => ({ id })));
}

function run() {
  return advanceStagedImportByMode({
    userId: USER,
    dek: DEK,
    stagedImportId: "staged-1",
    accountId: 42,
    mode: "auto",
  });
}

beforeEach(() => {
  selectQueue.length = 0;
  settingsWrites.length = 0;
  sendStagedRowsToBankLedger.mockReset();
  applyRulesToBankRows.mockReset();
  applyRulesToBankRows.mockResolvedValue({
    materialized: 0,
    rulesFired: 0,
    possibleDuplicates: 0,
    perRow: [],
  });
});

describe("advanceStagedImportByMode — stale-row sweep", () => {
  it("sweeps when the batch promoted NOTHING (the duplicates-only re-sync)", async () => {
    // The regression this whole change exists for: a bank feed re-pulling only
    // already-known rows used to return before the rule pass ever ran, so an
    // old unlinked row was never retried no matter how many times you synced.
    sendStagedRowsToBankLedger.mockResolvedValue({ ok: false });
    queueSelects({ stale: [uuid(1), uuid(2)] });
    applyRulesToBankRows.mockResolvedValue({
      materialized: 1,
      rulesFired: 1,
      possibleDuplicates: 0,
      perRow: [recordedRow(uuid(1), 501), unmatchedRow(uuid(2))],
    });

    const res = await run();

    expect(applyRulesToBankRows).toHaveBeenCalledTimes(1);
    expect(applyRulesToBankRows.mock.calls[0][1]).toEqual([uuid(1), uuid(2)]);
    expect(res.sweptStaleRows).toBe(1);
    // The BATCH's own reporting must be untouched — `reachedLedger` in the
    // upload route is `stage !== "pending"`, and a batch that promoted nothing
    // still belongs in /import/pending.
    expect(res.stage).toBe("pending");
    expect(res.bankBatchId).toBeNull();
    expect(res.promoted).toBe(0);
    expect(res.recorded).toBe(0);
    expect(selectQueue).toHaveLength(0);
  });

  it("keeps the batch counters free of stale rows, and vice versa", async () => {
    sendStagedRowsToBankLedger.mockResolvedValue({ ok: true, batchId: "batch-9", approved: 3 });
    const batch = [uuid(10), uuid(11), uuid(12)];
    const stale = [uuid(1), uuid(2)];
    queueSelects({ batch, stale });
    applyRulesToBankRows.mockResolvedValue({
      // Deliberately wrong roll-ups: the function must derive the batch's
      // numbers from `perRow`, never from these, or stale rows leak in.
      materialized: 99,
      rulesFired: 99,
      possibleDuplicates: 99,
      perRow: [
        recordedRow(uuid(10), 1),
        dupRow(uuid(11)),
        unmatchedRow(uuid(12)),
        recordedRow(uuid(1), 2),
        recordedRow(uuid(2), 3),
      ],
    });

    const res = await run();

    expect(res.recorded).toBe(1);
    expect(res.rulesFired).toBe(1);
    expect(res.possibleDuplicates).toBe(1);
    expect(res.sweptStaleRows).toBe(2);
    expect(res.promoted).toBe(3);
    expect(res.bankBatchId).toBe("batch-9");
    expect(res.stage).toBe("recorded");
  });

  it("marks ONLY the stale rows categorize-only, in a single rules call", async () => {
    // One call, not two: `computeReconcileForAccount` runs once per account
    // per call, so two calls would double the pass's dominant cost.
    sendStagedRowsToBankLedger.mockResolvedValue({ ok: true, batchId: "batch-9", approved: 1 });
    queueSelects({ batch: [uuid(10)], stale: [uuid(1), uuid(2)] });

    await run();

    expect(applyRulesToBankRows).toHaveBeenCalledTimes(1);
    const opts = applyRulesToBankRows.mock.calls[0][3] as {
      autoMaterialize: boolean;
      categorizeOnly: Set<string>;
    };
    expect(opts.autoMaterialize).toBe(true);
    expect([...opts.categorizeOnly].sort()).toEqual([uuid(1), uuid(2)]);
    expect(opts.categorizeOnly.has(uuid(10))).toBe(false);
  });

  it("advances the cursor past a FULL page so the next sync sees new rows", async () => {
    // Starvation guard: without this the same page comes back every sync and
    // a rule added later can never reach row 501.
    sendStagedRowsToBankLedger.mockResolvedValue({ ok: false });
    const page = Array.from({ length: 500 }, (_, i) => uuid(i + 1));
    queueSelects({ stale: page });

    await run();

    expect(settingsWrites).toHaveLength(1);
    expect(settingsWrites[0].value).toBe(page[page.length - 1]);
  });

  it("wraps the cursor when a page comes back SHORT, so the walk restarts", async () => {
    // The other half of the guarantee: once the walk reaches the end it must
    // return to the beginning, or rows before the cursor are never revisited.
    sendStagedRowsToBankLedger.mockResolvedValue({ ok: false });
    queueSelects({ cursor: uuid(900), stale: [uuid(901), uuid(902)] });

    await run();

    expect(settingsWrites).toHaveLength(1);
    expect(settingsWrites[0].value).toBe("");
  });

  it("still writes the cursor when the page is empty", async () => {
    // An account with nothing stale must not leave a stale cursor parked
    // mid-account, or newly-arriving rows below it would be skipped forever.
    sendStagedRowsToBankLedger.mockResolvedValue({ ok: false });
    queueSelects({ cursor: uuid(900), stale: [] });

    const res = await run();

    expect(settingsWrites[0].value).toBe("");
    expect(applyRulesToBankRows).not.toHaveBeenCalled();
    expect(res.sweptStaleRows).toBe(0);
  });

  it("does not sweep in approve or manual mode", async () => {
    sendStagedRowsToBankLedger.mockResolvedValue({ ok: true, batchId: "batch-9", approved: 2 });
    const approve = await advanceStagedImportByMode({
      userId: USER,
      dek: DEK,
      stagedImportId: "staged-1",
      accountId: 42,
      mode: "approve",
    });
    expect(approve.stage).toBe("loaded");
    expect(approve.sweptStaleRows).toBe(0);
    expect(applyRulesToBankRows).not.toHaveBeenCalled();
    expect(settingsWrites).toHaveLength(0);

    const manual = await advanceStagedImportByMode({
      userId: USER,
      dek: DEK,
      stagedImportId: "staged-1",
      accountId: 42,
      mode: "manual",
    });
    expect(manual.stage).toBe("pending");
    expect(manual.sweptStaleRows).toBe(0);
  });
});

// ─── static wiring gate ────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "../..");
const src = readFileSync(path.join(ROOT, "src/lib/import/advance-by-mode.ts"), "utf8");
const engine = readFileSync(path.join(ROOT, "src/lib/reconcile/match-engine.ts"), "utf8");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("advance-by-mode sweep wiring (static)", () => {
  const code = codeOnly(src);

  it("does not return early on !promote.ok in auto mode", () => {
    // The pre-#349 line was `if (!promote.ok) return base;`. Restoring it
    // silently deletes the sweep on exactly the path it was written for, and
    // every behavioural test above would still pass if the mocks were rebuilt
    // around the new shape.
    expect(code).not.toMatch(/if\s*\(\s*!promote\.ok\s*\)\s*return\s+base\s*;/);
    expect(code).toMatch(/if\s*\(\s*!promote\.ok\s*&&\s*mode\s*!==\s*"auto"\s*\)/);
  });

  it("orders the stale page and pages it with a persisted cursor", () => {
    // A LIMIT with no ORDER BY lets the planner hand back the same page every
    // sync — bounded, but permanently starving everything past the cap.
    expect(code).toContain("orderBy(asc(schema.bankTransactions.id))");
    expect(code).toContain("SWEEP_PAGE_SIZE");
    expect(code).toContain("readSweepCursor(");
    expect(code).toContain("writeSweepCursor(");
  });

  it("excludes the current batch by batch id, not by an id array", () => {
    // `upload_batch_id` is nullable and never rewritten on a re-seen row, so
    // the batch-id predicate is equivalent — and does not bind one parameter
    // per batch row. The NULL branch is load-bearing: a plain `<>` drops every
    // legacy row with no batch id, which is most of the backlog.
    expect(code).not.toContain("notInArray");
    expect(code).toContain("isNull(schema.bankTransactions.uploadBatchId)");
    expect(code).toContain("ne(schema.bankTransactions.uploadBatchId, promote.batchId)");
  });

  it("keeps the user_id filter on both bank_transactions reads", () => {
    const reads = code.split("schema.bankTransactions)").length - 1;
    expect(reads).toBe(2);
    expect(
      code.match(/eq\(schema\.bankTransactions\.userId, userId\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it("gates both retroactive side effects behind categorizeOnly", () => {
    // `record_investment_op` and `create_transfer` write outside the bank
    // row's own account, which the possible-duplicate guard never scans.
    const e = codeOnly(engine);
    expect(e).toContain("isCategorizeOnly");
    const skips = e.match(/skipReason: "sweep_side_effect_skipped"/g) ?? [];
    expect(skips.length, "one guard for invOps, one for the transfer branch").toBe(2);
  });
});
