/**
 * Static wiring gate for the "imported but never recorded" surfaces (GH #332).
 *
 * WHY THIS EXISTS
 * ---------------
 * In `auto` mode a sync promotes rows into `bank_transactions` and fires the
 * rules engine; rows matching NO rule stay there with nothing to retry or
 * announce them. Reported as 17 rows / ~$654 accumulating silently across two
 * syncs, noticed only because a trip-spend report came up short.
 *
 * The count already existed — `pendingCount` on the /import reconcile panel —
 * so the fix is a second surface (the dashboard Action Center card) reading the
 * SAME predicate. Two surfaces asserting the same thing is precisely the setup
 * where drift is invisible and damaging: the card deep-links to the panel, so a
 * card reading "9 rows" beside a panel reading something else is worse than no
 * card. This gate fails if either surface grows its own copy of the predicate.
 *
 * The predicate itself was WRONG on first ship: it anti-joined
 * `transactions.bank_transaction_id`, a pointer `linkTransactionToBank` sets
 * only for a `primary` link onto a transaction whose FK is still NULL. Since
 * `POST /api/reconcile/links` defaults `linkType` to `'extra'`, most reconciled
 * rows never got one and the card over-counted by 59% on real data. "Recorded"
 * means a `transaction_bank_links` row exists — the same thing the reconcile UI
 * has always read. Both directions are pinned below so neither the old FK
 * anti-join nor a hand-rolled copy can come back.
 *
 * PURE source reads — they pin the wiring, not the runtime behaviour.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Strip comments — these files document the identifiers some assertions forbid. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const predicateSrc = codeOnly(read("src/lib/reconcile/unrecorded-rows.ts"));
const summarySrc = codeOnly(read("src/lib/reconcile/summary.ts"));
const spotlightSrc = codeOnly(read("src/lib/spotlight.ts"));

/** The correct anti-join: no row in the link table references this bank row. */
const LINK_ANTIJOIN =
  /NOT EXISTS\s*\(\s*SELECT 1 FROM transaction_bank_links/;
/** Any anti-join at all — used to catch a consumer growing its own copy. */
const HANDROLLED = /NOT EXISTS\s*\(\s*SELECT 1 FROM transaction/;
/** The pre-fix predicate. `bank_transaction_id` is the transactions-side FK;
 *  the link table's column is `l.bank_transaction_id`, so anchor on the FROM. */
const FK_ANTIJOIN = /NOT EXISTS\s*\(\s*SELECT 1 FROM transactions/;

function builderBody(src: string): string {
  return src.slice(
    src.indexOf("async function getUnrecordedBankRows"),
    src.indexOf("export async function getSpotlightItems"),
  );
}

describe("shared unrecorded-row predicate (GH #332)", () => {
  it("is defined exactly once, in the leaf module", () => {
    expect(predicateSrc).toMatch(HANDROLLED);
    expect(predicateSrc).toContain("export function unrecordedBankRowSql()");
  });

  it("asks the link table, NOT the legacy transactions.bank_transaction_id FK", () => {
    // The FK is set only for a `primary` link onto a transaction whose FK was
    // still NULL (links.ts). `extra` links — the DEFAULT of POST
    // /api/reconcile/links — never set it, so an FK anti-join reports rows the
    // reconcile UI badges `linked_extra` as unrecorded. Reverting this is a
    // silent 59%-over-count, not a visible failure, which is why it is pinned.
    expect(predicateSrc).toMatch(LINK_ANTIJOIN);
    expect(predicateSrc).not.toMatch(FK_ANTIJOIN);
  });

  it("summary.ts consumes it instead of hand-rolling the anti-join", () => {
    expect(summarySrc).toContain('from "./unrecorded-rows"');
    expect(summarySrc).toContain("unrecordedBankRowSql()");
    expect(summarySrc).not.toMatch(HANDROLLED);
  });

  it("spotlight.ts consumes it instead of hand-rolling the anti-join", () => {
    expect(spotlightSrc).toContain('from "@/lib/reconcile/unrecorded-rows"');
    expect(spotlightSrc).toContain("unrecordedBankRowSql()");
    expect(spotlightSrc).not.toMatch(HANDROLLED);
  });

  it("the leaf module stays a leaf — importing it must not drag in the match-engine", () => {
    // summary.ts imports computeReconcileForAccount + balance-summary +
    // holdings-value. The Action Center is on the dashboard's hot path, which
    // is the whole reason this predicate does not live in summary.ts.
    expect(predicateSrc).not.toContain("match-engine");
    expect(predicateSrc).not.toContain("holdings-value");
    expect(predicateSrc).not.toContain("balance-summary");
  });
});

describe("Action Center card (GH #332)", () => {
  it("is registered in the spotlight assembly, not just defined", () => {
    // A builder nobody calls is the failure mode that shipped once already
    // (the staged-import resolution predicate, 2026-07-31).
    expect(spotlightSrc).toContain("getUnrecordedBankRows(userId, dek, fx)");
    expect(spotlightSrc).toContain("...unrecordedBankRows,");
  });

  it("deep-links to the reconcile tab on the all-time window", () => {
    // The count is all-time; the Reconcile tab defaults to a 60-day lookback.
    // Without both params the card opens a screen that renders none of the rows
    // it just counted — the phantom-alert report.
    const body = builderBody(spotlightSrc);
    expect(body).toContain("tab=reconcile");
    expect(body).toContain("window=all");
  });

  it("converts to the display currency before emitting (FINLYNQ-123)", () => {
    const body = builderBody(spotlightSrc);
    expect(body).toContain("convertWithRateMap(");
    expect(body).toContain("currency: fx.displayCurrency");
  });

  it("respects hidden accounts and skips archived ones", () => {
    const body = builderBody(spotlightSrc);
    expect(body).toContain("getReconcileHiddenAccountIds(userId)");
    expect(body).toContain("eq(accounts.archived, false)");
  });
});
