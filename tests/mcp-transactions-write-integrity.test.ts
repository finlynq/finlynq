/**
 * Static wiring gates for the two MCP transaction write-path defects
 * (GH #334, GH #335).
 *
 * WHY STATIC
 * ----------
 * These handlers are registered against a live MCP server and talk to Postgres
 * through a `DbLike`; exercising them needs a seeded database, which the
 * non-quarantined suite deliberately runs without. Both defects were, at root,
 * a MISSING LINE — a schema field that was never declared, and a column that
 * was never written. That is the shape a source gate catches well.
 *
 * Both bugs silently corrupted stored data while reporting success, which is
 * why they get a gate at all rather than being left to review.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const source = readFileSync(path.join(ROOT, "mcp-server/tools/transactions.ts"), "utf8");

/** Strip comments — the file documents the very identifiers we assert on. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const code = codeOnly(source);

/** The per-row object inside the bulk `transactions[]` zod array. */
function bulkRowSchema(): string {
  const at = code.indexOf("transactions: z.array(z.object({");
  expect(at).toBeGreaterThan(-1);
  return code.slice(at, code.indexOf("})).optional()", at));
}

describe("GH #335 — batch record must not drop category_id", () => {
  it("declares category_id on the PER-ROW schema, not just at the top level", () => {
    // zod strips undeclared keys silently, so a per-row `category_id` never
    // reached the handler and the row was written with category_id = NULL
    // while the call reported success.
    expect(bulkRowSchema()).toContain("category_id:");
  });

  it("keeps account_id and category_id symmetric per row", () => {
    // The asymmetry IS the bug: account_id existed per row, category_id did
    // not, so a caller reasonably passing both had one silently dropped.
    const row = bulkRowSchema();
    expect(row).toContain("account_id:");
    expect(row).toContain("category_id:");
  });

  it("resolves the FK before the fuzzy name (FINLYNQ-267)", () => {
    expect(code).toContain("if (t.category_id != null)");
    const at = code.indexOf("if (t.category_id != null)");
    const nameBranch = code.indexOf("} else if (t.category)", at);
    expect(nameBranch).toBeGreaterThan(at);
  });

  it("fails the row loudly when the FK does not resolve", () => {
    // Issue #203 established that an unresolvable category must fail the row
    // rather than coerce to NULL and report success. The FK path must not
    // reintroduce that hole.
    const at = code.indexOf("if (t.category_id != null)");
    const branch = code.slice(at, at + 700);
    expect(branch).toContain("success: false");
    expect(branch).toContain("continue;");
  });
});

describe("GH #334 — op:update must refresh the stored reporting amount", () => {
  it("writes reporting_amount after an amount-changing update", () => {
    // Flow reports SUM `reporting_amount`, not `amount`. Updating one without
    // the other leaves the row internally inconsistent and the dashboard wrong.
    expect(code).toContain("reporting_amount = ");
    expect(code).toContain("computeReportingFields({");
  });

  it("recomputes for the entered-side branch AND the amount-only branch", () => {
    // Both branches change `amount`; wiring only one leaves the other corrupt.
    expect(code).toContain("if (preResolvedEntered || amount !== undefined || date !== undefined)");
  });

  it("also refreshes on a date change", () => {
    // The stored reporting amount is fixed at the transaction's DATE rate, so
    // moving the date invalidates it just as surely as changing the amount.
    const at = code.indexOf("if (preResolvedEntered || amount !== undefined");
    expect(code.slice(at, at + 120)).toContain("date !== undefined");
  });

  it("does not rely on the self-heal, which structurally cannot fix it", () => {
    // selfHealReportingAmounts probes
    //   (reporting_currency IS DISTINCT FROM target OR reporting_amount IS NULL)
    // so a non-null value in the right currency that is merely numerically
    // stale reads as healthy. Assert the probe still has that shape, so this
    // reasoning is re-checked if it ever changes.
    const heal = readFileSync(path.join(ROOT, "src/lib/fx/reporting-amount.ts"), "utf8");
    expect(heal).toContain("IS DISTINCT FROM");
    expect(heal).toContain("IS NULL");
  });

  it("keeps the recompute best-effort so a failed FX lookup cannot fail the edit", () => {
    const at = code.indexOf("if (preResolvedEntered || amount !== undefined || date !== undefined)");
    const block = code.slice(at, at + 1400);
    expect(block).toContain("try {");
    expect(block).toContain("} catch {");
  });
});
