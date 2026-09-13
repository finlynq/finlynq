/**
 * `manage_accounts(op:update)` accepts and applies `type` (PR #346).
 *
 * The update variant had no `type` field, so zod STRIPPED a caller's
 * `type: "L"` before the handler ran and the call reported success with the
 * column unchanged. DB-free: a fake executor answers the ownership lookup and
 * captures the UPDATE, which is rendered to SQL + params for the assertion.
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

const dialect = new PgDialect();
let executed: Array<{ sql: string; params: unknown[] }> = [];
let tool: Tool;

beforeAll(() => {
  const server = withAutoAnnotations(new McpServer({ name: "accounts-type-test", version: "0.0.0" }));
  registerPgTools(
    server,
    {
      execute: async (query: SQL) => {
        const rendered = dialect.sqlToQuery(query);
        executed.push({ sql: rendered.sql, params: rendered.params });
        if (/^\s*SELECT id, name_ct, alias_ct FROM accounts/.test(rendered.sql)) {
          return { rows: [{ id: 7, name_ct: null, alias_ct: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    },
    "default",
    Buffer.alloc(32),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool = (server as any)._registeredTools.manage_accounts as Tool;
});

describe("manage_accounts op:update type", () => {
  it("keeps `type` through schema validation", () => {
    const parsed = tool.inputSchema.safeParse({ op: "update", accountId: 7, type: "L" });
    expect(parsed.success).toBe(true);
    expect(parsed.data.type).toBe("L");
  });

  it("rejects a type other than A or L", () => {
    expect(tool.inputSchema.safeParse({ op: "update", accountId: 7, type: "X" }).success).toBe(false);
  });

  it("writes the new type to the accounts row", async () => {
    executed = [];
    await tool.handler({ op: "update", accountId: 7, type: "L" }, {});
    const update = executed.find((q) => /^\s*UPDATE accounts SET/.test(q.sql));
    expect(update, "UPDATE issued").toBeTruthy();
    expect(update!.sql).toMatch(/\btype = \$\d+/);
    expect(update!.params).toContain("L");
  });
});
