/**
 * DTI numerator gate (GH #333).
 *
 * WHY THIS EXISTS
 * ---------------
 * The debt-service numerator is a raw-SQL predicate, so there is no pure
 * function to unit-test and no cheap way to exercise it without a seeded
 * Postgres. What actually bit us was a MISSING CLAUSE, and a missing clause is
 * exactly what a source-level gate can catch.
 *
 * The bug: an account seeded with an opening balance writes ONE large negative
 * row on the liability (kind='opening_balance', neutral type-'R' category, no
 * link ids). That satisfied `a.type='L' AND amount<0 AND <no links>`, so it was
 * counted as trailing-12m debt service — reported as ~$7,870 of phantom
 * payments across three seeded accounts, pushing DTI to 300% when income was
 * briefly mis-categorized. The FINLYNQ-255 anomaly backstop
 * (numerator > 1.2x liabilities) does not catch it: a user carrying a mortgage
 * has liabilities large enough that the threshold never trips.
 *
 * These are PURE source reads. They cannot prove runtime behaviour — they pin
 * the rule's shape and the one SQL subtlety that would silently undo it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { NON_DEBT_SERVICE_KINDS } from "@/lib/financial-health";

const ROOT = path.resolve(__dirname, "..");
const source = readFileSync(path.join(ROOT, "src/lib/financial-health.ts"), "utf8");

/** Strip comments — the file documents the very identifiers we assert on. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const code = codeOnly(source);

describe("DTI non-debt-service kinds (GH #333)", () => {
  it("excludes the two bookkeeping kinds that state a balance rather than pay one", () => {
    expect([...NON_DEBT_SERVICE_KINDS]).toEqual(["opening_balance", "balance_adjustment"]);
  });

  it("every excluded kind is a real value of transactions_kind_check", () => {
    // A typo here would silently exclude nothing at all.
    const baseline = readFileSync(
      path.join(ROOT, "scripts/baseline/0001_schema_baseline.sql"),
      "utf8",
    );
    const at = baseline.indexOf("transactions_kind_check");
    const check = baseline.slice(at, at + 2000);
    for (const kind of NON_DEBT_SERVICE_KINDS) {
      expect(check).toContain(`'${kind}'::text`);
    }
  });
});

describe("DTI numerator predicate (GH #333)", () => {
  it("filters the numerator by the shared const, not a hand-rolled kind list", () => {
    expect(code).toContain("NON_DEBT_SERVICE_KINDS.map((k) => sql");
    expect(code).toContain("t.kind NOT IN (${nonDebtServiceKinds})");
  });

  it("spells out the NULL guard so ordinary un-kinded rows survive", () => {
    // `NULL NOT IN (...)` evaluates to NULL, not true. Without the explicit
    // `t.kind IS NULL OR`, this clause would drop EVERY ordinary transaction
    // (kind is null on all non-portfolio rows) and zero the numerator outright
    // — a far bigger error than the one being fixed, and one that reads as a
    // healthy 100 DTI score rather than a crash.
    expect(code).toContain("(t.kind IS NULL OR t.kind NOT IN (");
  });

  it("still excludes linked pairs (FINLYNQ-255 must not regress)", () => {
    expect(code).toContain(
      "AND t.link_id IS NULL AND t.trade_link_id IS NULL AND t.swap_link_id IS NULL",
    );
  });

  it("keeps the 1.2x anomaly backstop", () => {
    expect(code).toContain("DTI_ANOMALY_MULTIPLE");
  });
});
