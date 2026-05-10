/**
 * Regression tests for the issue #230 hotfix on MCP HTTP `delete_account`.
 *
 * The bug class: post Stream D Phase 4 the `accounts` table only carries
 * `name_ct` / `alias_ct` (no plaintext). The previous handler called
 * `fuzzyFind` on the raw rows without first running `decryptNameish`, so
 * every row had `o.name === undefined`. `fuzzyFind`'s last-resort waterfall
 * step `lo.includes(String(o.name ?? "").toLowerCase())` collapsed to
 * `lo.includes("")` (unconditionally true) and silently returned the FIRST
 * row in the SELECT result. With `force=true` and FK CASCADE on
 * `accounts → transactions / holding_accounts / goal_accounts`, the
 * wrong-target was a data-loss-risk class. Same shape as the closed bugs
 * #211 (delete_budget / delete_loan) and #214 (create_rule).
 *
 * What this file gates against:
 *
 *   1. Name-fuzzy resolution targets the correct id, NOT the first SELECT row.
 *   2. Name-fuzzy without an unlocked DEK refuses cleanly (NOT a silent miss).
 *   3. Unknown-name returns a "did you mean ..." suggestion list.
 *   4. `accountId` exact-id path succeeds without a DEK and echoes
 *      `<encrypted>` instead of literal `undefined`.
 *   5. Mismatched `accountId` + `account` fails loud and does NOT delete.
 *   6. Neither param returns the dual-param hint.
 *   7. Adversarial-order test: when the encrypted-name SELECT lists the wrong
 *      account first, querying by the second account's name still hits the
 *      second account's id. (This is the live data-loss repro shape.)
 *   8. Successful delete invalidates the per-user tx cache (matches
 *      `delete_budget` precedent and the CLAUDE.md invariant).
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

// Stable env so the auth/encryption modules don't blow up at import time.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { encryptField } from "../../src/lib/crypto/envelope";

type CapturedQuery = { text: string; params: unknown[] };
type FixtureRow = Record<string, unknown>;
type RowsetFn = (text: string) => FixtureRow[] | undefined;

/**
 * Walk a Drizzle `sql` template and return the SQL text. Same approach as
 * `tests/api/mcp-http-smoke.test.ts`.
 */
function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const result = sqlObj.toQuery?.(dialect);
    if (result && typeof result.sql === "string") return result.sql;
  } catch {
    // fall through
  }
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) {
      out += (c as { value: string[] }).value.join("");
    } else if (typeof c === "string") {
      out += c;
    }
  }
  return out;
}

/**
 * Fixture DB: every test wires a `RowsetFn` that maps SQL substrings to a
 * canned rowset. Captures every issued query so tests can assert on the
 * shape of the DELETE.
 */
function makeFixtureDb(matcher: RowsetFn): {
  db: { execute: (q: unknown) => Promise<unknown> };
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const db = {
    execute: async (q: unknown) => {
      const text = serializeSqlTemplate(q);
      queries.push({ text, params: [] });
      const rows = matcher(text);
      return { rows: rows ?? [], rowCount: rows?.length ?? 0 };
    },
  };
  return { db, queries };
}

/**
 * Pull `delete_account`'s handler off a freshly-registered server.
 */
function getDeleteAccountTool(
  db: { execute: (q: unknown) => Promise<unknown> },
  dek: Buffer | null,
) {
  const server = new McpServer({ name: "delete-account-test", version: "0.0.0" });
  registerPgTools(server, db, "test-user", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  >;
  const tool = tools["delete_account"];
  if (!tool) throw new Error("delete_account tool not registered");
  return tool;
}

/**
 * Pull the `text` field out of the MCP tool envelope.
 */
function envelopeText(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;
  return r?.content?.[0]?.text ?? "";
}

/**
 * Build a fake `accounts` row whose `name_ct` column is real ciphertext under
 * `dek`. `decryptNameish` will hydrate `o.name` from this.
 */
function fakeAccountRow(id: number, name: string, dek: Buffer): FixtureRow {
  return { id, name_ct: encryptField(dek, name), alias_ct: null };
}

describe("MCP HTTP delete_account (issue #230 hotfix)", () => {
  it("rejects when neither `accountId` nor `account` is provided", async () => {
    const { db, queries } = makeFixtureDb(() => []);
    const tool = getDeleteAccountTool(db, randomBytes(32));
    const result = await tool.handler({}, {});
    const text = envelopeText(result);
    expect(text).toMatch(/Pass `accountId` \(numeric\) or `account` \(name\/alias\)/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(0);
  });

  it("refuses the name path with a clear error when no DEK is present", async () => {
    const { db, queries } = makeFixtureDb(() => []);
    const tool = getDeleteAccountTool(db, null);
    const result = await tool.handler({ account: "Anything" }, {});
    const text = envelopeText(result);
    expect(text).toMatch(/Cannot resolve account by name without an unlocked DEK/);
    expect(text).toMatch(/Pass `accountId` instead/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(0);
  });

  it("returns a `did you mean` suggestion list on unknown name", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText)) {
        return [
          fakeAccountRow(601, "Wealthsimple TFSA", dek),
          fakeAccountRow(686, "Verify EUR Account", dek),
        ];
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, dek);
    const result = await tool.handler({ account: "_UNKNOWN_NAME_" }, {});
    const text = envelopeText(result);
    expect(text).toMatch(/Account "_UNKNOWN_NAME_" not found/);
    // Any one of the candidates should appear in the suggestion list.
    expect(text).toMatch(/Wealthsimple TFSA|Verify EUR Account/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(0);
  });

  it("targets the correct account id when the matching name is NOT first in the SELECT (the live #230 repro)", async () => {
    const dek = randomBytes(32);
    // Adversarial order: id 601 is first; the user wants to delete id 686.
    // Pre-fix this returned id 601 (data-loss class). Post-fix it must
    // resolve to id 686 because exact-name match wins over the first-row
    // fallthrough.
    const accounts = [
      fakeAccountRow(601, "Wealthsimple TFSA", dek),
      fakeAccountRow(686, "_VERIFY_EUR_ACCOUNT_", dek),
    ];
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText) && !/AND id = /i.test(sqlText)) {
        return accounts;
      }
      // tx-count gate: zero so DELETE proceeds without `force`.
      if (/COUNT\(\*\)/i.test(sqlText) && /FROM transactions/i.test(sqlText)) {
        return [{ cnt: 0 }];
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, dek);
    const result = await tool.handler({ account: "_VERIFY_EUR_ACCOUNT_" }, {});
    const text = envelopeText(result);
    // The text is JSON-stringified by `text()` so quotes are escaped (\").
    // Match on the unescaped substring.
    expect(text).toMatch(/Account #686/);
    expect(text).toMatch(/_VERIFY_EUR_ACCOUNT_/);
    expect(text).toMatch(/deleted/);
    expect(text).not.toMatch(/#601/);
    const deletes = queries.filter((q) => /DELETE FROM accounts/i.test(q.text));
    expect(deletes).toHaveLength(1);
  });

  it("succeeds via `accountId` even when no DEK is present (id-only path)", async () => {
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText) && /AND id = /i.test(sqlText)) {
        // Real ciphertext we cannot decrypt because dek=null. Handler
        // should fall back to `<encrypted>` in the success message.
        return [{ id: 686, name_ct: "v1:abcd:efgh:ijkl", alias_ct: null }];
      }
      if (/COUNT\(\*\)/i.test(sqlText) && /FROM transactions/i.test(sqlText)) {
        return [{ cnt: 0 }];
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, null);
    const result = await tool.handler({ accountId: 686 }, {});
    const text = envelopeText(result);
    expect(text).toMatch(/Account #686/);
    // No literal "undefined" — that was part of the bug.
    expect(text).not.toMatch(/undefined/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(1);
  });

  it("returns 404-style error when `accountId` does not match any row", async () => {
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText) && /AND id = /i.test(sqlText)) {
        return []; // not found
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, randomBytes(32));
    const result = await tool.handler({ accountId: 99999 }, {});
    const text = envelopeText(result);
    expect(text).toMatch(/Account #99999 not found/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(0);
  });

  it("fails loud and does NOT delete when `accountId` and `account` resolve to different accounts", async () => {
    const dek = randomBytes(32);
    const accounts = [
      fakeAccountRow(601, "Wealthsimple TFSA", dek),
      fakeAccountRow(686, "_VERIFY_EUR_ACCOUNT_", dek),
    ];
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText) && /AND id = /i.test(sqlText)) {
        // accountId=601 path
        return [accounts[0]];
      }
      if (/FROM accounts WHERE user_id/i.test(sqlText)) {
        return accounts;
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, dek);
    const result = await tool.handler(
      { accountId: 601, account: "_VERIFY_EUR_ACCOUNT_" },
      {},
    );
    const text = envelopeText(result);
    expect(text).toMatch(/Account mismatch/);
    expect(text).toMatch(/_VERIFY_EUR_ACCOUNT_/);
    expect(text).toMatch(/#686/);
    expect(text).toMatch(/accountId=601/);
    // No DELETE was issued.
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(0);
  });

  it("succeeds when `accountId` and `account` both resolve to the same account", async () => {
    const dek = randomBytes(32);
    const accounts = [
      fakeAccountRow(601, "Wealthsimple TFSA", dek),
      fakeAccountRow(686, "_VERIFY_EUR_ACCOUNT_", dek),
    ];
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText) && /AND id = /i.test(sqlText)) {
        return [accounts[1]]; // id=686
      }
      if (/FROM accounts WHERE user_id/i.test(sqlText)) {
        return accounts;
      }
      if (/COUNT\(\*\)/i.test(sqlText) && /FROM transactions/i.test(sqlText)) {
        return [{ cnt: 0 }];
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, dek);
    const result = await tool.handler(
      { accountId: 686, account: "_VERIFY_EUR_ACCOUNT_" },
      {},
    );
    const text = envelopeText(result);
    expect(text).toMatch(/Account #686/);
    expect(text).toMatch(/_VERIFY_EUR_ACCOUNT_/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(1);
  });

  it("blocks delete with a tx-count error when transactions exist and `force` is false", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText) && /AND id = /i.test(sqlText)) {
        return [{ id: 686, name_ct: encryptField(dek, "_BUSY_"), alias_ct: null }];
      }
      if (/COUNT\(\*\)/i.test(sqlText) && /FROM transactions/i.test(sqlText)) {
        return [{ cnt: 5 }];
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, dek);
    const result = await tool.handler({ accountId: 686 }, {});
    const text = envelopeText(result);
    expect(text).toMatch(/Account #686/);
    expect(text).toMatch(/_BUSY_/);
    expect(text).toMatch(/has 5 transaction\(s\). Pass force=true/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(0);
  });

  it("proceeds with `force=true` when transactions exist (FK CASCADE handles children)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((sqlText) => {
      if (/FROM accounts WHERE user_id/i.test(sqlText) && /AND id = /i.test(sqlText)) {
        return [{ id: 686, name_ct: encryptField(dek, "_FORCE_"), alias_ct: null }];
      }
      if (/COUNT\(\*\)/i.test(sqlText) && /FROM transactions/i.test(sqlText)) {
        return [{ cnt: 5 }];
      }
      return [];
    });
    const tool = getDeleteAccountTool(db, dek);
    const result = await tool.handler({ accountId: 686, force: true }, {});
    const text = envelopeText(result);
    expect(text).toMatch(/Account #686/);
    expect(text).toMatch(/5 transactions also removed/);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q.text))).toHaveLength(1);
  });

  it("source verification: handler invokes invalidateUserTxCache after a successful DELETE", async () => {
    // Behavioural assertions above can't reach the in-memory cache through
    // the imported binding. This test pins the source string instead — the
    // CLAUDE.md invariant "every MCP tx-mutating write must call
    // invalidateUser(userId)" is verified by ensuring the call is in the
    // handler. Locks against an accidental future removal.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(__dirname, "../../mcp-server/register-tools-pg.ts");
    const src = await fs.readFile(file, "utf8");
    const idx = src.indexOf('"delete_account"');
    expect(idx).toBeGreaterThan(0);
    // Slice from the tool definition to the next tool boundary; assert
    // the cache-invalidation call is in there.
    const sliceEnd = src.indexOf("// ── update_goal", idx);
    expect(sliceEnd).toBeGreaterThan(idx);
    const handler = src.slice(idx, sliceEnd);
    expect(handler).toMatch(/invalidateUserTxCache\(userId\)/);
    // FK CASCADE comment present so future readers don't add redundant
    // child-row DELETEs.
    expect(handler).toMatch(/CASCADE/);
  });
});
