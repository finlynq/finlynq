/**
 * FINLYNQ-283 — Contract test: `manage_transactions` op=record returns a
 * per-row `transactionId` for SINGLE, BULK, and idempotency-REPLAYED responses.
 *
 * The bug: the bulk form (`transactions[]`) built its caller-facing `results[]`
 * rows WITHOUT `transactionId` (the single-record form has always returned it),
 * so an agent that just bulk-created N rows could not update/split/delete/link
 * any of them without a `search_transactions` round-trip + fuzzy re-match — the
 * exact id-guessing failure mode the echo guard exists to catch. The idempotency
 * replay preserves ids (redaction spreads `{ ...r }` and only blanks
 * message/names), so once `transactionId` is on the result row it survives replay
 * too — this test locks BOTH in.
 *
 * Two layers so the contract is guarded everywhere:
 *   (A) PURE — mirrors the replay-redaction transform inline (like
 *       idempotency-mutex.test.ts mirrors the mutex) and asserts it PRESERVES
 *       `transactionId` (+ resolved*.id) while redacting message/names. Runs
 *       with NO database, so it gates in CI's unit-only path and locally.
 *   (B) DB-backed — invokes the REAL `manage_transactions` handler against a
 *       seeded `finlynq_test` Postgres for single / bulk / replayed shapes and
 *       asserts numeric `transactionId` presence + a round-trip-free delete by
 *       that id. Skipped when no `*_test` DB is configured (mirrors
 *       readonly-contract.test.ts), so it runs in CI's finlynq_test lane.
 *
 * DB lane:  DATABASE_URL=postgres://…/finlynq_test npx vitest run tests/mcp/bulk-record-transaction-id.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { CONTRACT_DEK, seedContractWorld, type SeededWorld } from "./readonly-contract-seed";
import { shutdownTestDb } from "../helpers/portfolio-fixtures";

// ─── DB availability gate (identical to readonly-contract.test.ts) ────────────
const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);

type ToolResponse = { content: Array<{ type: string; text: string }> };

function envelope(res: unknown): { success?: unknown; data?: Record<string, unknown> } {
  const r = res as ToolResponse;
  expect(Array.isArray(r?.content)).toBe(true);
  const block = r.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block.text) as { success?: unknown; data?: Record<string, unknown> };
}

// ─── (A) PURE: replay-redaction contract — no DB ──────────────────────────────
//
// Mirrors the exact transform in transactions.ts (the `results.map` at the
// idempotency-persist site): message → "row #N: redacted on replay",
// resolvedAccount/resolvedCategory names → "[redacted]", and EVERYTHING ELSE
// (incl. `transactionId`, `index`, ids) preserved via the `{ ...r }` spread.
type ResultRow = Record<string, unknown> & {
  index: number;
  transactionId?: number | null;
  message?: string;
  resolvedAccount?: { id: number; name: string };
  resolvedCategory?: { id: number; name: string };
};

function redactForReplay(rows: ResultRow[]): ResultRow[] {
  return rows.map((r) => {
    const out = { ...r };
    if (typeof out.message === "string") out.message = `row #${out.index}: redacted on replay`;
    if (out.resolvedAccount && typeof out.resolvedAccount === "object") {
      out.resolvedAccount = { id: out.resolvedAccount.id, name: "[redacted]" };
    }
    if (out.resolvedCategory && typeof out.resolvedCategory === "object") {
      out.resolvedCategory = { id: out.resolvedCategory.id, name: "[redacted]" };
    }
    return out;
  });
}

describe("FINLYNQ-283 replay redaction preserves ids (pure)", () => {
  it("keeps transactionId + resolved*.id while redacting message + names", () => {
    const live: ResultRow[] = [
      {
        index: 0,
        success: true,
        transactionId: 8801,
        message: "Probe Idem A: -3.5 USD",
        resolvedAccount: { id: 12, name: "Chequing" },
        resolvedCategory: { id: 34, name: "Groceries" },
      },
      {
        index: 1,
        success: true,
        transactionId: 8802,
        message: "Probe Idem B: -7.25 USD",
        resolvedAccount: { id: 12, name: "Chequing" },
      },
    ];
    const replayed = redactForReplay(live);

    // Ids survive redaction (they are not sensitive).
    expect(replayed[0].transactionId).toBe(8801);
    expect(replayed[1].transactionId).toBe(8802);
    expect(replayed[0].resolvedAccount?.id).toBe(12);
    expect(replayed[0].resolvedCategory?.id).toBe(34);
    // Sensitive fields are redacted.
    expect(replayed[0].message).toBe("row #0: redacted on replay");
    expect(replayed[1].message).toBe("row #1: redacted on replay");
    expect(replayed[0].resolvedAccount?.name).toBe("[redacted]");
    expect(replayed[0].resolvedCategory?.name).toBe("[redacted]");
  });
});

// ─── (B) DB-backed: the real handler for single / bulk / replayed ─────────────
const dbSuite = HAS_TEST_DB ? describe : describe.skip;

dbSuite("FINLYNQ-283 manage_transactions returns transactionId (DB-backed)", () => {
  let world: SeededWorld;
  let handler: (args: unknown, extra: unknown) => Promise<unknown>;

  beforeAll(async () => {
    world = await seedContractWorld();
    const server = new McpServer({ name: "f283-contract", version: "0.0.0" });
    const { db } = await import("@/db");
    registerPgTools(server, db as never, world.userId, CONTRACT_DEK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<
      string,
      { handler: (a: unknown, e: unknown) => Promise<unknown> }
    >;
    handler = tools["manage_transactions"].handler;
    expect(typeof handler).toBe("function");
  }, 60_000);

  afterAll(async () => {
    await shutdownTestDb();
  });

  // tc-3 (single leg) — the single-record form already carries transactionId.
  it("single record carries a numeric transactionId", async () => {
    const env = envelope(
      await handler(
        { op: "record", amount: -3.5, payee: "F283 Single", account_id: world.cashAccountId, category: "Groceries" },
        {},
      ),
    );
    expect(env.success).toBe(true);
    expect(typeof env.data?.transactionId).toBe("number");
    expect(env.data?.transactionId as number).toBeGreaterThan(0);
  });

  // tc-1 (primary) — every bulk result row carries transactionId == inserted id,
  // and a follow-up delete by that id succeeds with NO search_transactions.
  it("bulk record rows each carry transactionId, deletable by that id", async () => {
    const env = envelope(
      await handler(
        {
          op: "record",
          transactions: [
            { amount: -3.5, payee: "F283 Bulk A", account_id: world.cashAccountId, category: "Groceries" },
            { amount: -7.25, payee: "F283 Bulk B", account_id: world.cashAccountId, category: "Groceries" },
          ],
        },
        {},
      ),
    );
    expect(env.success).toBe(true);
    const results = env.data?.results as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
    for (const row of results) {
      expect(row.success).toBe(true);
      expect(typeof row.transactionId, `results[${row.index}].transactionId`).toBe("number");
      expect(row.transactionId as number).toBeGreaterThan(0);
    }
    // Ids are distinct real inserts.
    expect(results[0].transactionId).not.toBe(results[1].transactionId);

    // Round-trip-free delete by the returned id — the whole point of the fix.
    const delEnv = envelope(await handler({ op: "delete", id: results[0].transactionId }, {}));
    expect(delEnv.success).toBe(true);
    expect(String(delEnv.data?.message)).toContain(`#${results[0].transactionId}`);
  });

  // tc-2 — idempotent replay preserves the SAME transactionId values while
  // keeping message + resolved names redacted.
  it("idempotent replay preserves transactionId, redacts message + names", async () => {
    const idempotencyKey = randomUUID();
    const rows = [
      { amount: -1.11, payee: "F283 Idem A", account_id: world.cashAccountId, category: "Groceries" },
      { amount: -2.22, payee: "F283 Idem B", account_id: world.cashAccountId, category: "Groceries" },
    ];

    const first = envelope(await handler({ op: "record", transactions: rows, idempotencyKey }, {}));
    const firstResults = first.data?.results as Array<Record<string, unknown>>;
    const firstIds = firstResults.map((r) => r.transactionId);
    expect(firstIds.every((id) => typeof id === "number")).toBe(true);
    expect(first.data?.replayed).toBeUndefined();

    const second = envelope(await handler({ op: "record", transactions: rows, idempotencyKey }, {}));
    expect(second.data?.replayed).toBe(true);
    const replayResults = second.data?.results as Array<Record<string, unknown>>;

    // Ids preserved verbatim across the replay.
    expect(replayResults.map((r) => r.transactionId)).toEqual(firstIds);
    // Sensitive fields redacted on the stored/replayed blob.
    for (const r of replayResults) {
      expect(r.message).toBe(`row #${r.index}: redacted on replay`);
      expect((r.resolvedAccount as { name?: string })?.name).toBe("[redacted]");
      if (r.resolvedCategory) {
        expect((r.resolvedCategory as { name?: string }).name).toBe("[redacted]");
      }
    }
  });
});
