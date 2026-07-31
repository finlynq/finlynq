/**
 * FINLYNQ-264 Phase 2 — tier-2 `expected_summary` echo gate on
 * `delete_transaction` + `delete_split`.
 *
 * Decision #1: high-frequency single-row deletes use a round-trip-free echo
 * (the caller passes the payee/amount it believes it's deleting; a mismatch is
 * refused) rather than a token. The echo is OPTIONAL (non-breaking): omitting
 * it still deletes. This suite proves both branches, DB-free.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { encryptField } from "../../src/lib/crypto/envelope";
import { checkExpectedEcho } from "../../mcp-server/tools/_confirm";

function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const result = sqlObj.toQuery?.(dialect);
    if (result && typeof result.sql === "string") return result.sql;
  } catch { /* fall through */ }
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) out += (c as { value: string[] }).value.join("");
    else if (typeof c === "string") out += c;
  }
  return out;
}

function makeFixtureDb(matcher: (sqlText: string) => Record<string, unknown>[] | undefined) {
  const queries: { text: string }[] = [];
  const db = {
    execute: async (q: unknown) => {
      // Collapse whitespace — the shared delete chokepoint writes multi-line
      // `sql` templates, and these fixtures match on substrings.
      const text = serializeSqlTemplate(q).replace(/\s+/g, " ").trim();
      queries.push({ text });
      const rows = matcher(text);
      return { rows: rows ?? [], rowCount: rows?.length ?? 0 };
    },
  };
  return { db, queries };
}

// v4.1 clean break: the per-verb delete aliases were removed; each op now lives
// on a consolidated discriminated-union tool. Map the old alias name → the
// union tool + the `op` discriminator to inject so each test's args stay identical.
const ALIAS_TO_CONSOLIDATED: Record<string, { tool: string; op: string }> = {
  delete_transaction: { tool: "manage_transactions", op: "delete" },
  delete_split: { tool: "manage_splits", op: "delete" },
};

function getTool(name: string, db: { execute: (q: unknown) => Promise<unknown> }, dek: Buffer | null) {
  const server = new McpServer({ name: "delete-echo-test", version: "0.0.0" });
  registerPgTools(server, db, "test-user", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
  const map = ALIAS_TO_CONSOLIDATED[name];
  if (!map) throw new Error(`no consolidated mapping for ${name}`);
  const tool = tools[map.tool];
  if (!tool) throw new Error(`${map.tool} not registered`);
  return {
    handler: (args: unknown, extra: unknown) =>
      tool.handler({ op: map.op, ...(args as Record<string, unknown>) }, extra),
  };
}

function envelopeText(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any)?.content?.[0]?.text ?? "";
}

describe("checkExpectedEcho (pure)", () => {
  it("passes when the echo is omitted (back-compat)", () => {
    expect(checkExpectedEcho(undefined, { payee: "X", amount: 1 }, "tx")).toBeNull();
  });
  it("passes on a case-insensitive payee + within-epsilon amount match", () => {
    expect(checkExpectedEcho({ payee: "  starbucks ", amount: -6.5 }, { payee: "Starbucks", amount: -6.501 }, "tx")).toBeNull();
  });
  it("fails on a payee mismatch", () => {
    expect(checkExpectedEcho({ payee: "Starbucks" }, { payee: "Rent", amount: -1200 }, "tx")).toMatch(/Refusing to delete tx/);
  });
  it("fails on an amount mismatch beyond epsilon", () => {
    expect(checkExpectedEcho({ amount: 100 }, { amount: 101 }, "split")).toMatch(/Refusing to delete split/);
  });
});

describe("delete_transaction — echo gate (FINLYNQ-264 Phase 2)", () => {
  const dek = randomBytes(32);
  const fixture = (sqlText: string): Record<string, unknown>[] | undefined => {
    // The echo-gate lookup AND the shared chokepoint's owner-scope / sibling /
    // dirty-date reads all select from `transactions` by id — one row answers
    // them all (no link ids ⇒ the cascade expands to just this row).
    if (/^SELECT .*FROM transactions WHERE user_id = \?/i.test(sqlText) && /AND id = /i.test(sqlText)) {
      return [{ id: 812, payee: encryptField(dek, "Rent"), amount: -1200, date: "2026-01-02" }];
    }
    return [];
  };

  it("refuses (no delete) when the expected payee mismatches", async () => {
    const { db, queries } = makeFixtureDb(fixture);
    const tool = getTool("delete_transaction", db, dek);
    const res = await tool.handler({ id: 812, expected: { payee: "Starbucks" } }, {});
    expect(envelopeText(res)).toMatch(/Refusing to delete transaction #812/);
    expect(queries.filter((q) => /DELETE FROM transactions/i.test(q.text))).toHaveLength(0);
  });

  it("deletes when the expected payee+amount match", async () => {
    const { db, queries } = makeFixtureDb(fixture);
    const tool = getTool("delete_transaction", db, dek);
    const res = await tool.handler({ id: 812, expected: { payee: "rent", amount: -1200 } }, {});
    expect(envelopeText(res)).toMatch(/Deleted transaction #812/);
    expect(queries.filter((q) => /DELETE FROM transactions/i.test(q.text))).toHaveLength(1);
  });

  it("deletes with no echo (back-compat)", async () => {
    const { db, queries } = makeFixtureDb(fixture);
    const tool = getTool("delete_transaction", db, dek);
    const res = await tool.handler({ id: 812 }, {});
    expect(envelopeText(res)).toMatch(/Deleted transaction #812/);
    expect(queries.filter((q) => /DELETE FROM transactions/i.test(q.text))).toHaveLength(1);
  });
});

describe("delete_split — echo gate (FINLYNQ-264 Phase 2)", () => {
  const fixture = (sqlText: string): Record<string, unknown>[] | undefined => {
    if (/FROM transaction_splits s/i.test(sqlText)) {
      return [{ id: 44, amount: 25.5 }];
    }
    return [];
  };

  it("refuses (no delete) when the expected amount mismatches", async () => {
    const { db, queries } = makeFixtureDb(fixture);
    const tool = getTool("delete_split", db, null);
    const res = await tool.handler({ split_id: 44, expected: { amount: 99 } }, {});
    expect(envelopeText(res)).toMatch(/Refusing to delete split #44/);
    expect(queries.filter((q) => /DELETE FROM transaction_splits/i.test(q.text))).toHaveLength(0);
  });

  it("deletes when the expected amount matches (and with no echo)", async () => {
    const { db, queries } = makeFixtureDb(fixture);
    const tool = getTool("delete_split", db, null);
    const ok = await tool.handler({ split_id: 44, expected: { amount: 25.5 } }, {});
    expect(envelopeText(ok)).toMatch(/Split #44 deleted/);
    const bare = await tool.handler({ split_id: 44 }, {});
    expect(envelopeText(bare)).toMatch(/Split #44 deleted/);
    expect(queries.filter((q) => /DELETE FROM transaction_splits/i.test(q.text))).toHaveLength(2);
  });
});
