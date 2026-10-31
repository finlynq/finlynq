/**
 * `manage_accounts(op:add | update)` refuse a duplicate account name cleanly.
 *
 * Account names are unique per user via `accounts_user_name_lookup_uniq`
 * (a unique index over the name_lookup HMAC). Both ops pre-check the lookup,
 * but a rename never did, and a concurrent add races past the pre-check; in
 * both cases Postgres raised 23505 and the SDK surfaced Drizzle's raw
 * "Failed query: insert into \"accounts\" …" as the tool error (the REST route
 * had the same gap — prod `diagnostics_log` 2026-10-28 20:13). DB-free: a
 * fake executor answers the lookups and throws the unique violation from the
 * INSERT / UPDATE, in both the bare `pg` shape and the Drizzle-wrapped one.
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { withAutoAnnotations } from "../../mcp-server/auto-annotations";

type Tool = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

type Executed = { sql: string; params: unknown[] };

/** A Postgres unique-violation as `pg` surfaces it. */
function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint,
  });
}

/** The same violation as Drizzle rethrows it: the pg error sits on `.cause`. */
function drizzleWrapped(constraint: string, statement: string): Error {
  return Object.assign(new Error(`Failed query: ${statement}`), { cause: uniqueViolation(constraint) });
}

const dialect = new PgDialect();
let executed: Executed[] = [];
/** Per-test plan: what the fake executor returns or throws for each statement. */
let plan: {
  /** Rows for the rename clash check (`… AND id <> $3`). */
  clash?: Array<{ id: number }>;
  /** Thrown from the INSERT, if set. */
  insertThrows?: Error;
  /** Thrown from the UPDATE, if set. */
  updateThrows?: Error;
} = {};
let tool: Tool;

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "accounts-dup-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        executed.push({ sql: rendered.sql, params: rendered.params });
        const sql = rendered.sql.trim();
        // op:update — ownership lookup by id.
        if (/^SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = \$1 AND id = \$2/.test(sql)) {
          return { rows: [{ id: 7, name_ct: null, alias_ct: null }], rowCount: 1 };
        }
        // op:update — rename clash check.
        if (/^SELECT id FROM accounts WHERE user_id = \$1 AND name_lookup = \$2 AND id <> \$3/.test(sql)) {
          return { rows: plan.clash ?? [], rowCount: (plan.clash ?? []).length };
        }
        // op:add — pre-check (no clash: let the INSERT run).
        if (/^SELECT id FROM accounts WHERE user_id = \$1 AND name_lookup = \$2/.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        if (/^INSERT INTO accounts/.test(sql)) {
          if (plan.insertThrows) throw plan.insertThrows;
          return { rows: [{ id: 42 }], rowCount: 1 };
        }
        if (/^UPDATE accounts SET/.test(sql)) {
          if (plan.updateThrows) throw plan.updateThrows;
          return { rows: [], rowCount: 1 };
        }
        // Everything else (display-currency lookup, …): empty → defaults.
        return { rows: [], rowCount: 0 };
      },
    },
    "default",
    Buffer.alloc(32),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool = (server as any)._registeredTools.manage_accounts as Tool;
});

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("manage_accounts op:add duplicate name", () => {
  it("still creates an account when nothing clashes", async () => {
    executed = [];
    plan = {};
    const out = textOf(await tool.handler({ op: "add", name: "Savings", type: "A" }, {}));
    expect(out).not.toMatch(/^Error:/);
    expect(JSON.parse(out)).toMatchObject({ success: true, data: { accountId: 42 } });
  });

  it("turns a 23505 from the INSERT into a clean 'already exists' error (pg shape)", async () => {
    executed = [];
    plan = { insertThrows: uniqueViolation("accounts_user_name_lookup_uniq") };
    const out = textOf(await tool.handler({ op: "add", name: "Savings", type: "A", currency: "EUR" }, {}));
    expect(out).toMatch(/^Error: Account "Savings" already exists/);
    expect(out).not.toMatch(/Failed query|duplicate key value/i);
  });

  it("unwraps the Drizzle 'Failed query' wrapper to find the 23505", async () => {
    executed = [];
    plan = {
      insertThrows: drizzleWrapped(
        "accounts_user_name_lookup_uniq",
        'insert into "accounts" ("user_id", "type", "group", "currency") values ($1, $2, $3, $4)',
      ),
    };
    const out = textOf(await tool.handler({ op: "add", name: "Savings", type: "A" }, {}));
    expect(out).toMatch(/^Error: Account "Savings" already exists/);
    expect(out).not.toMatch(/Failed query/i);
  });

  it("rethrows anything that is not the name index", async () => {
    executed = [];
    plan = { insertThrows: uniqueViolation("some_other_uniq") };
    await expect(tool.handler({ op: "add", name: "Savings", type: "A" }, {})).rejects.toThrow(/some_other_uniq/);
    plan = { insertThrows: new Error("connection reset") };
    await expect(tool.handler({ op: "add", name: "Savings", type: "A" }, {})).rejects.toThrow(/connection reset/);
  });
});

describe("manage_accounts op:update duplicate name", () => {
  it("refuses a rename onto an existing name before issuing the UPDATE", async () => {
    executed = [];
    plan = { clash: [{ id: 9 }] };
    const out = textOf(await tool.handler({ op: "update", accountId: 7, name: "Chequing" }, {}));
    expect(out).toMatch(/^Error: Account "Chequing" already exists \(id: 9\)/);
    expect(executed.some((q) => /^\s*UPDATE accounts SET/.test(q.sql)), "no UPDATE issued").toBe(false);
  });

  it("turns a 23505 from the UPDATE into the same clean error (race backstop)", async () => {
    executed = [];
    plan = {
      clash: [],
      updateThrows: drizzleWrapped("accounts_user_name_lookup_uniq", 'update "accounts" set "name_ct" = $1'),
    };
    const out = textOf(await tool.handler({ op: "update", accountId: 7, name: "Chequing" }, {}));
    expect(out).toMatch(/^Error: Account "Chequing" already exists/);
    expect(out).not.toMatch(/Failed query/i);
  });

  it("does not run the clash check when the name is not changing", async () => {
    executed = [];
    plan = {};
    const out = textOf(await tool.handler({ op: "update", accountId: 7, group: "Banks" }, {}));
    expect(out).not.toMatch(/^Error:/);
    expect(executed.some((q) => /name_lookup = \$2 AND id <> \$3/.test(q.sql)), "no clash SELECT").toBe(false);
  });

  it("rethrows an unrelated UPDATE failure", async () => {
    executed = [];
    plan = { clash: [], updateThrows: new Error("connection reset") };
    await expect(tool.handler({ op: "update", accountId: 7, name: "Chequing" }, {})).rejects.toThrow(/connection reset/);
  });
});
