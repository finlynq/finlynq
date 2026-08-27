/**
 * GH #341 follow-up — MCP rule UPDATES must verify FK OWNERSHIP, not just shape.
 *
 * The #341 fix gave `manage_rules(op:update)` / stdio `update_rule` the real
 * ConditionGroup/Action Zod schemas, which validate STRUCTURE only. REST
 * POST/PUT /api/rules additionally runs `collectActionFKs` + a `verifyOwnership`
 * batch, because Postgres FKs are satisfied by global serial PKs: a rule saved
 * with another user's category/account/holding id succeeds at the SQL layer and
 * later FIRES against this user's transactions — an IDOR-shaped write. The MCP
 * paths skipped that guard entirely.
 *
 * WHY STATIC — same reasoning as tests/mcp-transactions-write-integrity.test.ts:
 * these handlers register against a live MCP server and talk to Postgres
 * through a DbLike / the pg-compat shim; exercising them needs a seeded DB the
 * non-quarantined suite runs without. The defect is a MISSING CALL, which is
 * exactly the shape a source gate catches — and (import-resolution-wiring
 * precedent) a guard's own unit tests pass whether or not anything calls it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

/**
 * Strip comments — the files document the very identifiers we assert on.
 * Whole-line `//` comments go FIRST: register-core-tools.ts has a line comment
 * containing a literal `/*` (e.g. "name/*_lookup"), which would otherwise open
 * a phantom block comment swallowing ~63KB of real code.
 */
function codeOnly(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Slice one function/handler body out of a source file by two anchors. */
function slice(code: string, startAnchor: string, endAnchor: string): string {
  const start = code.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
  const end = code.indexOf(endAnchor, start);
  expect(end, `anchor not found after start: ${endAnchor}`).toBeGreaterThan(start);
  return code.slice(start, end);
}

const httpCode = codeOnly(
  readFileSync(path.join(ROOT, "mcp-server/tools/rules.ts"), "utf8"),
);
const stdioCode = codeOnly(
  readFileSync(path.join(ROOT, "mcp-server/register-core-tools.ts"), "utf8"),
);

describe("HTTP manage_rules(op:update) — cross-tenant FK guard", () => {
  const opUpdate = slice(httpCode, "async function opUpdate", "async function opDelete");

  it("collects every action FK via the shared collectActionFKs", () => {
    expect(opUpdate).toContain("collectActionFKs(");
  });

  it("verifies ownership through the shared verifyOwnership helper", () => {
    // ctx.db IS the `@/db` proxy on the HTTP surface (route.ts passes it in),
    // so the shared helper hits the same database as the tool's own queries.
    expect(opUpdate).toContain("await verifyOwnership(userId, fks)");
  });

  it("also guards account ids referenced inside v2 CONDITIONS", () => {
    // REST PUT verifies `field: "account"` conditions too — a condition FK is
    // less dangerous than an action FK but still a cross-tenant reference.
    expect(opUpdate).toContain('c.field === "account"');
    expect(opUpdate).toContain("fks.accountIds.push(c.accountId)");
  });

  it("re-validates a filled record_investment_op action (FINLYNQ-208)", () => {
    expect(opUpdate).toContain("validateInvestmentOpAction(");
  });

  it("runs the guard BEFORE encryption and BEFORE the UPDATE", () => {
    // encryptRuleFields must see already-validated plaintext ids; the guard
    // after the write would be no guard at all.
    const guardAt = opUpdate.indexOf("await verifyOwnership(");
    const encAt = opUpdate.indexOf("encryptRuleFields(");
    const writeAt = opUpdate.indexOf("UPDATE transaction_rules");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(encAt);
    expect(guardAt).toBeLessThan(writeAt);
  });

  it("maps OwnershipError to a refusal instead of leaking a raw throw", () => {
    expect(opUpdate).toContain("OwnershipError");
    // Anti-enumeration: the refusal reads "not found", never "belongs to
    // someone else" — the same shape REST maps to a 404.
    expect(opUpdate).toContain("not found");
  });
});

describe("stdio update_rule — cross-tenant FK guard", () => {
  const handler = slice(stdioCode, '"update_rule"', '"delete_rule"');

  it("collects every action FK via the shared collectActionFKs", () => {
    expect(handler).toContain("collectActionFKs(");
  });

  it("checks ownership of categories, accounts AND holdings via the shim", () => {
    // Deliberately the pg-compat shim, NOT @/db verifyOwnership — the stdio
    // shared-adapter bootstrap is non-fatal on failure, and the guard must
    // still hold in that state.
    expect(handler).toContain('notOwned("categories", "category"');
    expect(handler).toContain('notOwned("accounts", "account"');
    expect(handler).toContain('notOwned("portfolio_holdings", "holding"');
    expect(handler).toContain("WHERE user_id = ? AND id IN");
  });

  it("also guards account ids referenced inside v2 CONDITIONS", () => {
    expect(handler).toContain('c.field === "account"');
    expect(handler).toContain("fks.accountIds.push(c.accountId)");
  });

  it("re-validates a filled record_investment_op action (FINLYNQ-208)", () => {
    expect(handler).toContain("validateInvestmentOpAction(");
  });

  it("runs the guard BEFORE the UPDATE", () => {
    const guardAt = handler.indexOf("collectActionFKs(");
    const writeAt = handler.indexOf("UPDATE transaction_rules");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(writeAt);
  });
});

describe("REST parity — the guard helpers stay shared, not forked", () => {
  it("REST PUT /api/rules still runs the same collectActionFKs + verifyOwnership pair", () => {
    // If the REST route ever renames or restructures its guard, this file's
    // "mirror REST" claim needs re-checking — fail loud here.
    const rest = codeOnly(
      readFileSync(path.join(ROOT, "src/app/api/rules/route.ts"), "utf8"),
    );
    expect(rest).toContain("collectActionFKs(");
    expect(rest).toContain("verifyOwnership(");
    expect(rest).toContain("validateInvestmentOpAction");
  });
});
