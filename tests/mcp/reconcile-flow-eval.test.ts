/**
 * FINLYNQ-271 phase 5 — end-to-end AI-native reconciliation eval.
 *
 * Drives the REGISTERED MCP tool handlers through the full phase 1-5 flow for a
 * 200-row statement and asserts the efficiency + correctness bar from the item:
 *   - total handler invocations ≤ 12 (batched — no per-row commit), AND
 *   - the final get_reconciliation_summary row has bankOnly === 0 AND
 *     balanceDelta === 0.
 *
 * Flow exercised (8 tool calls): upload_statement → find_duplicate_bank_rows →
 * send_to_bank_ledger → get_reconcile_suggestions (buckets) →
 * apply_rules_to_bank_rows (preview → commit, ONE token for the whole batch) →
 * upsert_balance_anchor → get_reconciliation_summary.
 *
 * Deterministic: a fixed 200-row CSV (no Math.random), a fresh empty account,
 * and a single catch-all rule (payee contains "Merchant" → an expense category)
 * so apply_rules_to_bank_rows auto-materializes all 200 no-match bank rows into
 * linked ledger transactions in one batched commit. The anchor is set to the
 * exact ledger sum, so balanceDelta reconciles to 0.
 *
 * DB-gated exactly like readonly-contract.test.ts — reuses the
 * `readonly-contract-seed` PostgresAdapter harness (refuses any non-`*_test` DB)
 * and SKIPS entirely when no `finlynq_test` DATABASE_URL is configured. Run with:
 *   DATABASE_URL=postgres://…/finlynq_test npx vitest run tests/mcp/reconcile-flow-eval.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import {
  CONTRACT_DEK,
  seedContractWorld,
  type SeededWorld,
} from "./readonly-contract-seed";
import {
  createAccount,
  createCategory,
  shutdownTestDb,
} from "../helpers/portfolio-fixtures";
import { encryptRuleFields } from "../../src/lib/rules/crypto";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

type ToolResponse = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: unknown, extra: unknown) => Promise<ToolResponse>;

function env<T = Record<string, unknown>>(res: ToolResponse): { success?: boolean; data: T } {
  expect(Array.isArray(res.content)).toBe(true);
  const text = res.content[0]?.text ?? "";
  // A tool ERROR is `err(msg)` → `{ content: [{ text: "Error: <msg>" }] }`, which
  // is NOT valid JSON. Surface it verbatim instead of letting JSON.parse throw a
  // useless SyntaxError that hides the real message (FINLYNQ-271 cycle 3).
  let parsed: { success?: boolean; data: T; error?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`MCP tool returned a non-JSON error: ${text}`);
  }
  if (parsed && parsed.success === false) {
    throw new Error(`MCP tool returned an error: ${JSON.stringify(parsed.error ?? parsed)}`);
  }
  return parsed;
}

const ROW_COUNT = 200;

/** Deterministic 200-row CSV — whole-dollar negative amounts so the ledger sum
 *  is exact and the anchor reconciles to delta 0. Dates within the last 80 days
 *  so they fall inside the 90-day reconcile window; anchor date = today (≥ all
 *  row dates) so no bank amount lands "after" the anchor. */
function buildFixture(): { csv: string; sum: number; anchorDate: string } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const lines = ["Date,Payee,Amount"];
  let sum = 0;
  for (let i = 0; i < ROW_COUNT; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (1 + (i % 80)));
    const amount = -(10 + i); // distinct whole-dollar expenses: -10 … -209
    sum += amount;
    lines.push(`${iso(d)},Merchant ${String(i).padStart(3, "0")},${amount}.00`);
  }
  return { csv: lines.join("\n") + "\n", sum, anchorDate: iso(today) };
}

describeDb("AI-native reconciliation e2e eval (FINLYNQ-271)", () => {
  let world: SeededWorld;
  let accountId: number;
  let handlers: Record<string, ToolHandler>;
  let calls = 0;

  const fixture = buildFixture();

  async function call<T = Record<string, unknown>>(
    name: string,
    args: unknown,
  ): Promise<{ success?: boolean; data: T }> {
    calls += 1;
    return env<T>(await handlers[name](args, {}));
  }

  beforeAll(async () => {
    world = await seedContractWorld();
    const { db, schema } = await import("@/db");

    // A FRESH empty account for the eval (seedContractWorld's cash/investment
    // accounts already carry transactions; we need a clean ledger so the
    // materialized rows are the ONLY transactions and the sum is predictable).
    accountId = await createAccount({
      userId: world.userId,
      name: "Reconcile Eval Chequing",
      currency: "USD",
      type: "A",
      group: "Banks",
      isInvestment: false,
    });
    const expenseCategoryId = await createCategory({
      userId: world.userId,
      name: "Eval Expenses",
      type: "E",
    });

    // A single catch-all rule: payee contains "Merchant" → set the expense
    // category. apply_rules_to_bank_rows auto-materializes every matched bank
    // row into a linked expense transaction (negative amounts + expense
    // category = sign-consistent, so no sign-vs-category skip).
    const rule = {
      name: "Eval catch-all",
      conditions: { all: [{ field: "payee", op: "contains", value: "Merchant" }] },
      actions: [{ kind: "set_category", categoryId: expenseCategoryId }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enc = encryptRuleFields(CONTRACT_DEK, rule as any);
    await db.insert(schema.transactionRules).values({
      userId: world.userId,
      name: enc.name,
      conditions: enc.conditions,
      actions: enc.actions,
      isActive: true,
      priority: 100,
      createdAt: new Date().toISOString(),
    });

    // Defensive: confirm the eval account exists AND is owned by world.userId
    // before any tool runs. upload_statement is owner-scoped, so a missing /
    // mis-owned account surfaces as "Account #N not found" (the cycle-3
    // symptom, caused by a cross-file TRUNCATE race now fixed via
    // fileParallelism:false). Fail here with a clear message if it recurs.
    const { eq, and } = await import("drizzle-orm");
    const owned = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, world.userId)))
      .get();
    expect(owned?.id, "eval account must be owned by world.userId before the flow runs").toBe(accountId);

    const server = new McpServer({ name: "reconcile-eval", version: "0.0.0" });
    registerPgTools(server, db as never, world.userId, CONTRACT_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, { handler: ToolHandler }>;
    handlers = Object.fromEntries(
      Object.entries(tools).map(([k, v]) => [k, v.handler]),
    );
  }, 120_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  it("reconciles a 200-row statement in ≤12 tool calls with bankOnly 0 and delta 0", async () => {
    const fileContent = Buffer.from(fixture.csv, "utf8").toString("base64");

    // ─── Phase 1: ingest (ONE upload call) ─────────────────────────────────
    const up = await call<{ stagedImportId: string; rowCount: number }>(
      "upload_statement",
      { fileContent, fileName: "reconcile-eval.csv", accountId },
    );
    expect(up.success).toBe(true);
    expect(up.data.rowCount).toBe(ROW_COUNT);
    const stagedImportId = up.data.stagedImportId;

    // ─── Phase 2: stage + dedup (find_duplicate_bank_rows finds no dup GROUPS —
    //     the 200 rows are all distinct) ─────────────────────────────────────
    const dup = await call<unknown[]>("find_duplicate_bank_rows", { accountId });
    expect(Array.isArray(dup.data)).toBe(true);
    expect(dup.data.length).toBe(0);

    // Trace the real row lifecycle (test-harness DB reads — NOT counted tool
    // calls). The unified staging pipeline is subtle: confirm the staged import
    // is bound to our account, and grab the staged row ids so Phase 4a can
    // force-load EVERY row regardless of any dedup flag (the no-rowIds
    // send_to_bank_ledger path excludes reconcileState='skipped_duplicate' rows
    // AND the default skipExistingMatches drops dedup_status='existing' rows —
    // both would silently promote 0 rows, the cycle-1 failure).
    const { db, schema } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    const importRow = await db
      .select({ boundAccountId: schema.stagedImports.boundAccountId })
      .from(schema.stagedImports)
      .where(eq(schema.stagedImports.id, stagedImportId))
      .get();
    expect(importRow?.boundAccountId).toBe(accountId);
    const stagedRows = await db
      .select({ id: schema.stagedTransactions.id })
      .from(schema.stagedTransactions)
      .where(eq(schema.stagedTransactions.stagedImportId, stagedImportId))
      .all();
    const stagedRowIds = stagedRows.map((r) => r.id);
    expect(stagedRowIds.length).toBe(ROW_COUNT);

    // ─── Phase 4a: load the bank side (explicit rowIds + skipExistingMatches
    //     false bypass BOTH staging filters). loaded may be 0 if the rows were
    //     already promoted elsewhere — the authoritative check is that the bank
    //     rows EXIST + are unmatched, asserted via get_reconcile_suggestions. ─
    await call("send_to_bank_ledger", {
      stagedImportId,
      rowIds: stagedRowIds,
      skipExistingMatches: false,
    });

    // ─── Phase 3: match → buckets. Every bank row is no-match against the empty
    //     ledger, so noMatch carries all 200 — the real "bank rows exist" check. ─
    const sug = await call<{ buckets: { noMatch: { bankTransactionIds: string[] } } }>(
      "get_reconcile_suggestions",
      { accountId },
    );
    const bankRowIds = sug.data.buckets.noMatch.bankTransactionIds;
    expect(bankRowIds.length).toBe(ROW_COUNT);

    // ─── Phase 4b: batched commit — ONE confirmation token for the batch ───
    const preview = await call<{ confirmationToken: string }>(
      "apply_rules_to_bank_rows",
      { bankRowIds },
    );
    const token = preview.data.confirmationToken;
    expect(typeof token).toBe("string");
    const commit = await call<{ materialized: number }>("apply_rules_to_bank_rows", {
      bankRowIds,
      confirmation_token: token,
      autoMaterialize: true,
    });
    expect(commit.data.materialized).toBe(ROW_COUNT);

    // ─── Phase 5: anchor + verify ──────────────────────────────────────────
    await call("upsert_balance_anchor", {
      accountId,
      date: fixture.anchorDate,
      amount: fixture.sum,
      currency: "USD",
    });

    const summary = await call<{
      accounts: Array<{ accountId: number; bankOnly: number; balanceDelta: number | null }>;
    }>("get_reconciliation_summary", { accountIds: [accountId] });
    const row = summary.data.accounts.find((a) => a.accountId === accountId);
    expect(row).toBeTruthy();

    // ─── Acceptance ────────────────────────────────────────────────────────
    expect(calls).toBeLessThanOrEqual(12);
    expect(row!.bankOnly).toBe(0);
    expect(Math.abs(Number(row!.balanceDelta))).toBeLessThanOrEqual(0.005);
  }, 120_000);
});
