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

const HANDROLLED = /NOT EXISTS\s*\(\s*SELECT 1 FROM transactions/;

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
