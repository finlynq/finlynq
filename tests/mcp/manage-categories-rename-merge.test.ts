/**
 * FINLYNQ-275 — manage_categories `rename` + `merge` ops.
 *
 * Two new ops on the consolidated `manage_categories` discriminated union:
 *   - `rename`  — pure metadata write (id fast-path over fuzzy name); a
 *                 duplicate name is refused with a clear error, not a DB 500.
 *   - `merge`   — TWO-STEP via withConfirmation: preview returns per-type
 *                 dependent counts + a token; commit atomically repoints EVERY
 *                 dependent (transactions / splits / subscriptions / budgets /
 *                 budget_templates / recurring / email rules / rule JSONB /
 *                 loans.interest_category_id / budget_line_settings /
 *                 budget_carryover_sets / backfill_proposals) into the target,
 *                 then deletes the source.
 *
 * 2026-10-31 (Budget v2 follow-up): `budgets`, `budget_line_settings` and
 * `budget_carryover_sets` are unique per category (+ month), so a blind
 * repoint tripped 23505 whenever the target already had a row for the same
 * key and the WHOLE merge rolled back with a raw constraint message. The
 * merge now FOLDS those keys — the target's row is kept, the source's is
 * dropped and reported (`willFold` on preview, `folded` on commit) — and
 * repoints everything else. `loans.interest_category_id` (ON DELETE SET
 * NULL) and `backfill_proposals.chosen_category_id` are repointed BEFORE
 * the source delete so nothing is silently nulled.
 *
 * Structure mirrors the FINLYNQ-260 readonly-contract pattern:
 *   - Registration/enumeration assertions run DB-FREE (always in CI).
 *   - Behavioural assertions run against a seeded `finlynq_test` Postgres and
 *     SKIP when no `*_test` DB is configured (DATABASE_URL not naming `_test`).
 *
 * Run: DATABASE_URL=postgres://…/finlynq_test npx vitest run \
 *        tests/mcp/manage-categories-rename-merge.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { CONSOLIDATED_JSON_SCHEMAS } from "../../mcp-server/tools/_consolidate";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
  createCategory,
  recordTransaction,
} from "../helpers/portfolio-fixtures";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type ToolResponse = { content: Array<{ type: string; text: string }> };
type Handler = (args: unknown, extra: unknown) => Promise<ToolResponse>;

/** Success responses carry a JSON `{ success, data }` envelope. */
function parse(res: ToolResponse): Record<string, unknown> {
  expect(Array.isArray(res.content)).toBe(true);
  expect(res.content[0]?.type).toBe("text");
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

/** err() returns plain text `Error: <msg>` (NOT JSON). Return the raw text. */
function errText(res: ToolResponse): string {
  return res.content[0]?.text ?? "";
}

// ─── DB-free: op enum advertises rename + merge ──────────────────────────────
describe("manage_categories ops (registration, no DB)", () => {
  it("registers the manage_categories tool with create/rename/merge/delete ops", () => {
    const server = new McpServer({ name: "mc-enum", version: "0.0.0" });
    registerPgTools(server, { execute: async () => ({ rows: [], rowCount: 0 }) }, "u", TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    expect(tools.manage_categories).toBeTruthy();
    // The advertised oneOf schema enumerates every op literal.
    const schema = CONSOLIDATED_JSON_SCHEMAS.get("manage_categories") as {
      oneOf?: Array<{ properties?: { op?: { const?: string } } }>;
    };
    const ops = (schema.oneOf ?? []).map((b) => b.properties?.op?.const).sort();
    expect(ops).toEqual(["create", "delete", "merge", "rename"]);
  });
});

// ─── DB-backed behaviour ─────────────────────────────────────────────────────
describeDb("manage_categories rename + merge (seeded DB)", () => {
  let userId: string;
  let accountId: number;
  let handler: Handler;

  beforeAll(async () => {
    await bootstrapTestDb();
  }, 60_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  async function freshWorld() {
    await resetTestDb();
    userId = await createTestUser();
    accountId = await createAccount({ userId, name: "Chequing", currency: "USD", isInvestment: false });
    const { db } = await import("@/db");
    const server = new McpServer({ name: "mc-db", version: "0.0.0" });
    registerPgTools(server, db as never, userId, TEST_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler = (server as any)._registeredTools.manage_categories.handler as Handler;
  }

  it("rename: happy path changes the name; the FK stays put", async () => {
    await freshWorld();
    const catId = await createCategory({ userId, name: "Dining", type: "E" });
    const txId = await recordTransaction({ userId, accountId, categoryId: catId, currency: "USD", amount: -10 });

    const res = parse(await handler({ op: "rename", id: catId, new_name: "Restaurants" }, { requestId: 1 }));
    expect(res.success).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data.newName).toBe("Restaurants");

    const { db } = await import("@/db");
    // The tx still references the SAME category id (only the label changed).
    const rows = (await db.execute(
      sql`SELECT category_id FROM transactions WHERE id = ${txId}`,
    )) as unknown as { rows: Array<{ category_id: number }> };
    expect(Number(rows.rows[0].category_id)).toBe(catId);
  });

  it("rename: duplicate name → clear conflict error, no change", async () => {
    await freshWorld();
    const a = await createCategory({ userId, name: "Groceries", type: "E" });
    await createCategory({ userId, name: "Utilities", type: "E" });

    const res = await handler({ op: "rename", id: a, new_name: "Utilities" }, { requestId: 1 });
    expect(errText(res)).toMatch(/^Error:/);
    expect(errText(res)).toMatch(/already exists/i);
  });

  it("merge: preview reports per-type counts + token; commit repoints all + deletes source", async () => {
    await freshWorld();
    const src = await createCategory({ userId, name: "Dining", type: "E" });
    const tgt = await createCategory({ userId, name: "Food & drink", type: "E" });
    // Dependents across ≥2 types: two transactions + a subscription + a budget.
    await recordTransaction({ userId, accountId, categoryId: src, currency: "USD", amount: -10 });
    await recordTransaction({ userId, accountId, categoryId: src, currency: "USD", amount: -20 });
    const { db } = await import("@/db");
    await db.execute(sql`INSERT INTO subscriptions (user_id, amount, currency, frequency, category_id) VALUES (${userId}, 30, 'USD', 'monthly', ${src})`);
    await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${src}, '2026-07', 100, 'USD')`);

    // Preview (no token) — writes nothing.
    const previewData = (parse(await handler({ op: "merge", source: src, target: tgt }, { requestId: 1 })).data) as Record<string, unknown>;
    expect(previewData.preview).toBe(true);
    const token = (previewData as { confirmationToken?: string }).confirmationToken;
    expect(typeof token).toBe("string");
    const summary = previewData.summary as { dependents: Record<string, number>; totalDependents: number };
    expect(summary.dependents.transactions).toBe(2);
    expect(summary.dependents.subscriptions).toBe(1);
    expect(summary.dependents.budgets).toBe(1);
    expect(summary.totalDependents).toBe(4);
    // Source still exists after preview (no writes).
    const stillThere = (await db.execute(sql`SELECT id FROM categories WHERE id = ${src}`)) as unknown as { rows: unknown[] };
    expect(stillThere.rows.length).toBe(1);

    // Commit with the token.
    const commitData = (parse(await handler({ op: "merge", source: src, target: tgt, confirmation_token: token }, { requestId: 2 })).data) as Record<string, unknown>;
    expect(commitData.merged).toBe(true);
    expect((commitData.repointed as Record<string, number>).transactions).toBe(2);

    // Source gone; every dependent now on target; nothing left on source.
    const gone = (await db.execute(sql`SELECT id FROM categories WHERE id = ${src}`)) as unknown as { rows: unknown[] };
    expect(gone.rows.length).toBe(0);
    const onTgt = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = ${userId} AND category_id = ${tgt}`)) as unknown as { rows: Array<{ c: number }> };
    expect(onTgt.rows[0].c).toBe(2);
    const onSrc = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM transactions WHERE user_id = ${userId} AND category_id = ${src}`)) as unknown as { rows: Array<{ c: number }> };
    expect(onSrc.rows[0].c).toBe(0);
    const subOnTgt = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM subscriptions WHERE user_id = ${userId} AND category_id = ${tgt}`)) as unknown as { rows: Array<{ c: number }> };
    expect(subOnTgt.rows[0].c).toBe(1);
    const budOnTgt = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM budgets WHERE user_id = ${userId} AND category_id = ${tgt}`)) as unknown as { rows: Array<{ c: number }> };
    expect(budOnTgt.rows[0].c).toBe(1);
  });

  it("merge: same source & target is refused (no token)", async () => {
    await freshWorld();
    const c = await createCategory({ userId, name: "Solo", type: "E" });
    const res = await handler({ op: "merge", source: c, target: c }, { requestId: 1 });
    expect(errText(res)).toMatch(/same category/i);
  });

  it("merge: unmatched name → not-found; id fast-path resolves", async () => {
    await freshWorld();
    const tgt = await createCategory({ userId, name: "Keeper", type: "E" });
    // Unknown source name → clean not-found err (no token).
    const nf = await handler({ op: "merge", source: "Nonexistent", target: tgt }, { requestId: 1 });
    // FINLYNQ-273 unified refusal envelope: not-found renders "matched no <label>. Did you mean: …".
    expect(errText(nf)).toMatch(/matched no category/i);
  });

  it("merge: ambiguous source name → ambiguous candidate list (no token)", async () => {
    await freshWorld();
    // Two categories sharing a startsWith prefix → substring match is ambiguous.
    await createCategory({ userId, name: "Travel Air", type: "E" });
    await createCategory({ userId, name: "Travel Rail", type: "E" });
    const tgt = await createCategory({ userId, name: "Trips", type: "E" });
    const res = await handler({ op: "merge", source: "Travel", target: tgt }, { requestId: 1 });
    expect(errText(res)).toMatch(/ambiguous/i);
  });

  // ── 2026-10-31: Budget v2 collisions + the ON DELETE SET NULL / CASCADE FKs ──

  it("merge: a budget month BOTH categories plan keeps the target's amount, folds the source's, repoints the rest (no 23505)", async () => {
    await freshWorld();
    const src = await createCategory({ userId, name: "Dining", type: "E" });
    const tgt = await createCategory({ userId, name: "Food & drink", type: "E" });
    const { db } = await import("@/db");
    // Source plans two months; the target already plans ONE of them (2026-07).
    await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${src}, '2026-07', 100, 'USD')`);
    await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${src}, '2026-08', 50, 'USD')`);
    await db.execute(sql`INSERT INTO budgets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${tgt}, '2026-07', 200, 'USD')`);

    // Preview names the collision: 2 source budget rows, 1 of them folded.
    const previewData = (parse(await handler({ op: "merge", source: src, target: tgt }, { requestId: 1 })).data) as Record<string, unknown>;
    const summary = previewData.summary as {
      dependents: Record<string, number>;
      totalDependents: number;
      willFold: { budgets: { count: number; months: string[] }; budgetLineSettings: boolean; budgetCarryoverSets: { count: number; months: string[] } };
      action: string;
    };
    expect(summary.dependents.budgets).toBe(2);
    expect(summary.totalDependents).toBe(2);
    expect(summary.willFold.budgets).toEqual({ count: 1, months: ["2026-07"] });
    expect(summary.willFold.budgetLineSettings).toBe(false);
    expect(summary.willFold.budgetCarryoverSets.count).toBe(0);
    expect(summary.action).toMatch(/Both have a budget for 1 month\(s\) \(2026-07\)/);
    expect(summary.action).toMatch(/"Food & drink"'s amount is kept and "Dining"'s is dropped/);
    const token = (previewData as { confirmationToken?: string }).confirmationToken;
    expect(typeof token).toBe("string");

    // Commit succeeds (the old blind UPDATE rolled back here with a raw 23505).
    const res = await handler({ op: "merge", source: src, target: tgt, confirmation_token: token }, { requestId: 2 });
    expect(errText(res)).not.toMatch(/^Error:/);
    const commitData = parse(res).data as Record<string, unknown>;
    expect(commitData.merged).toBe(true);
    expect((commitData.repointed as Record<string, number>).budgets).toBe(1);
    expect((commitData.folded as { budgets: { count: number; months: string[] } }).budgets).toEqual({ count: 1, months: ["2026-07"] });
    expect(String(commitData.message)).toMatch(/Both have a budget for 1 month\(s\)/);

    // The target's July plan survived at ITS amount; August moved over; the
    // source is gone and owns nothing.
    const tgtRows = (await db.execute(
      sql`SELECT month, amount FROM budgets WHERE user_id = ${userId} AND category_id = ${tgt} ORDER BY month`,
    )) as unknown as { rows: Array<{ month: string; amount: number }> };
    expect(tgtRows.rows.map((r) => [r.month, Number(r.amount)])).toEqual([["2026-07", 200], ["2026-08", 50]]);
    const srcRows = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM budgets WHERE user_id = ${userId} AND category_id = ${src}`)) as unknown as { rows: Array<{ c: number }> };
    expect(srcRows.rows[0].c).toBe(0);
    const gone = (await db.execute(sql`SELECT id FROM categories WHERE id = ${src}`)) as unknown as { rows: unknown[] };
    expect(gone.rows.length).toBe(0);
  });

  it("merge: a loan's interest category and a backfill proposal's chosen category follow the merge (not SET NULL)", async () => {
    await freshWorld();
    const src = await createCategory({ userId, name: "Loan interest (old)", type: "E" });
    const tgt = await createCategory({ userId, name: "Loan interest", type: "E" });
    const { db } = await import("@/db");
    const loanAccount = await createAccount({ userId, name: "Car Loan", currency: "USD", type: "L", isInvestment: false });
    const loanRows = (await db.execute(sql`
      INSERT INTO loans (user_id, type, account_id, currency, principal, annual_rate, term_months, start_date, payment_frequency, interest_category_id)
      VALUES (${userId}, 'loan', ${loanAccount}, 'USD', 30000, 3.48, 60, '2026-01-01', 'monthly', ${src})
      RETURNING id
    `)) as unknown as { rows: Array<{ id: number }> };
    const loanId = Number(loanRows.rows[0].id);
    const runRows = (await db.execute(sql`
      INSERT INTO backfill_runs (user_id, mode) VALUES (${userId}, 'refuse_orphans') RETURNING id
    `)) as unknown as { rows: Array<{ id: string }> };
    const proposalRows = (await db.execute(sql`
      INSERT INTO backfill_proposals (run_id, user_id, proposal_kind, confidence, summary, existing_row_ids, replacement_rows_json, deltas_json, chosen_category_id)
      VALUES (${runRows.rows[0].id}, ${userId}, 'classify_only', 'high', 'income override', ARRAY[]::integer[], '[]'::jsonb, '{}'::jsonb, ${src})
      RETURNING id
    `)) as unknown as { rows: Array<{ id: number }> };
    const proposalId = Number(proposalRows.rows[0].id);

    const previewData = (parse(await handler({ op: "merge", source: src, target: tgt }, { requestId: 1 })).data) as Record<string, unknown>;
    const summary = previewData.summary as { dependents: Record<string, number>; totalDependents: number };
    expect(summary.dependents.loans).toBe(1);
    expect(summary.dependents.backfillProposals).toBe(1);
    expect(summary.totalDependents).toBe(2);
    const token = (previewData as { confirmationToken?: string }).confirmationToken;

    const commitData = (parse(await handler({ op: "merge", source: src, target: tgt, confirmation_token: token }, { requestId: 2 })).data) as Record<string, unknown>;
    expect((commitData.repointed as Record<string, number>).loans).toBe(1);
    expect((commitData.repointed as Record<string, number>).backfillProposals).toBe(1);

    // Before the fix the source DELETE's ON DELETE SET NULL cleared both.
    const loan = (await db.execute(sql`SELECT interest_category_id FROM loans WHERE id = ${loanId}`)) as unknown as { rows: Array<{ interest_category_id: number | null }> };
    expect(Number(loan.rows[0].interest_category_id)).toBe(tgt);
    const proposal = (await db.execute(sql`SELECT chosen_category_id FROM backfill_proposals WHERE id = ${proposalId}`)) as unknown as { rows: Array<{ chosen_category_id: number | null }> };
    expect(Number(proposal.rows[0].chosen_category_id)).toBe(tgt);
  });

  it("merge: budget line settings + carryover sets — carried over when the target has none, the target's kept otherwise (not CASCADE-dropped)", async () => {
    await freshWorld();
    const { db } = await import("@/db");

    // (a) Target has NO settings and NO carryover sets → the source's are carried over.
    const srcA = await createCategory({ userId, name: "Coffee", type: "E" });
    const tgtA = await createCategory({ userId, name: "Groceries", type: "E" });
    await db.execute(sql`INSERT INTO budget_line_settings (user_id, category_id, excluded, rollover, rollover_negative) VALUES (${userId}, ${srcA}, false, true, 'reset')`);
    await db.execute(sql`INSERT INTO budget_carryover_sets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${srcA}, '2026-07', 25, 'USD')`);
    const previewA = (parse(await handler({ op: "merge", source: srcA, target: tgtA }, { requestId: 1 })).data) as Record<string, unknown>;
    const summaryA = previewA.summary as { dependents: Record<string, number>; willFold: { budgetLineSettings: boolean; budgetCarryoverSets: { count: number } } };
    expect(summaryA.dependents.budgetLineSettings).toBe(1);
    expect(summaryA.dependents.budgetCarryoverSets).toBe(1);
    expect(summaryA.willFold.budgetLineSettings).toBe(false);
    expect(summaryA.willFold.budgetCarryoverSets.count).toBe(0);
    const commitA = (parse(await handler({ op: "merge", source: srcA, target: tgtA, confirmation_token: (previewA as { confirmationToken?: string }).confirmationToken }, { requestId: 2 })).data) as Record<string, unknown>;
    expect((commitA.repointed as Record<string, number>).budgetLineSettings).toBe(1);
    expect((commitA.repointed as Record<string, number>).budgetCarryoverSets).toBe(1);
    expect((commitA.folded as { budgetLineSettings: boolean }).budgetLineSettings).toBe(false);
    const settingsA = (await db.execute(sql`SELECT rollover, rollover_negative FROM budget_line_settings WHERE user_id = ${userId} AND category_id = ${tgtA}`)) as unknown as { rows: Array<{ rollover: boolean; rollover_negative: string }> };
    expect(settingsA.rows).toEqual([{ rollover: true, rollover_negative: "reset" }]);
    const carryA = (await db.execute(sql`SELECT month, amount FROM budget_carryover_sets WHERE user_id = ${userId} AND category_id = ${tgtA}`)) as unknown as { rows: Array<{ month: string; amount: number }> };
    expect(carryA.rows.map((r) => [r.month, Number(r.amount)])).toEqual([["2026-07", 25]]);

    // (b) Target ALREADY has settings + a carryover set for one of the months
    //     → the target's win; the source's row for that key is folded; the
    //     source's other month is carried over. (The partial unique indexes
    //     made the old blind UPDATE fail here too.)
    const srcB = await createCategory({ userId, name: "Takeout", type: "E" });
    const tgtB = await createCategory({ userId, name: "Restaurants", type: "E" });
    await db.execute(sql`INSERT INTO budget_line_settings (user_id, category_id, excluded, rollover) VALUES (${userId}, ${srcB}, true, false)`);
    await db.execute(sql`INSERT INTO budget_line_settings (user_id, category_id, excluded, rollover) VALUES (${userId}, ${tgtB}, false, true)`);
    await db.execute(sql`INSERT INTO budget_carryover_sets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${srcB}, '2026-07', 10, 'USD')`);
    await db.execute(sql`INSERT INTO budget_carryover_sets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${srcB}, '2026-08', 15, 'USD')`);
    await db.execute(sql`INSERT INTO budget_carryover_sets (user_id, category_id, month, amount, currency) VALUES (${userId}, ${tgtB}, '2026-07', 40, 'USD')`);
    const previewB = (parse(await handler({ op: "merge", source: srcB, target: tgtB }, { requestId: 3 })).data) as Record<string, unknown>;
    const summaryB = previewB.summary as { willFold: { budgetLineSettings: boolean; budgetCarryoverSets: { count: number; months: string[] } }; action: string };
    expect(summaryB.willFold.budgetLineSettings).toBe(true);
    expect(summaryB.willFold.budgetCarryoverSets).toEqual({ count: 1, months: ["2026-07"] });
    expect(summaryB.action).toMatch(/Both have budget line settings/);
    expect(summaryB.action).toMatch(/carried-in amount set for 1 month\(s\) \(2026-07\)/);
    const resB = await handler({ op: "merge", source: srcB, target: tgtB, confirmation_token: (previewB as { confirmationToken?: string }).confirmationToken }, { requestId: 4 });
    expect(errText(resB)).not.toMatch(/^Error:/);
    const commitB = parse(resB).data as Record<string, unknown>;
    expect((commitB.folded as { budgetLineSettings: boolean }).budgetLineSettings).toBe(true);
    expect((commitB.folded as { budgetCarryoverSets: { count: number; months: string[] } }).budgetCarryoverSets).toEqual({ count: 1, months: ["2026-07"] });
    expect((commitB.repointed as Record<string, number>).budgetLineSettings).toBe(0);
    expect((commitB.repointed as Record<string, number>).budgetCarryoverSets).toBe(1);
    const settingsB = (await db.execute(sql`SELECT excluded, rollover FROM budget_line_settings WHERE user_id = ${userId} AND category_id = ${tgtB}`)) as unknown as { rows: Array<{ excluded: boolean; rollover: boolean }> };
    expect(settingsB.rows).toEqual([{ excluded: false, rollover: true }]);
    const carryB = (await db.execute(sql`SELECT month, amount FROM budget_carryover_sets WHERE user_id = ${userId} AND category_id = ${tgtB} ORDER BY month`)) as unknown as { rows: Array<{ month: string; amount: number }> };
    expect(carryB.rows.map((r) => [r.month, Number(r.amount)])).toEqual([["2026-07", 40], ["2026-08", 15]]);
    // Nothing of the source survives anywhere (the CASCADE never had to fire).
    const leftover = (await db.execute(sql`
      SELECT (SELECT COUNT(*) FROM budget_line_settings WHERE category_id = ${srcB})::int
           + (SELECT COUNT(*) FROM budget_carryover_sets WHERE category_id = ${srcB})::int
           + (SELECT COUNT(*) FROM categories WHERE id = ${srcB})::int AS c
    `)) as unknown as { rows: Array<{ c: number }> };
    expect(leftover.rows[0].c).toBe(0);
  });
});
