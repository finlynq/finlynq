/**
 * FINLYNQ-273 — the resolver refusal envelope is UNIFIED across families, and
 * the previously id-only deletes (rules / subscriptions) + the category delete
 * COMMIT gain a resolver-name path.
 *
 * Two layers:
 *   1. Pure `resolveEntity` / `formatResolveFailure` unit assertions — every
 *      family's `not_found` carries a top-N `didYouMean` (WITH ids), and
 *      ambiguous + not_found render the SAME message shape (candidates with ids).
 *   2. Handler-level (DB-free fixture harness, same pattern as
 *      resolve-entity-contract.test.ts) — delete-by-name for
 *      manage_rules / manage_subscriptions, and the category delete-commit
 *      accepting the previewed name.
 *
 * DB-free (the mock DB maps SQL substrings to canned rowsets), so it gates in
 * CI's DB-free path.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import {
  resolveEntity,
  formatResolveFailure,
  type Row,
} from "../../mcp-server/tools/_shared";
import { encryptField } from "../../src/lib/crypto/envelope";

// ─── Layer 1: pure envelope shape ─────────────────────────────────────────────

describe("FINLYNQ-273 — unified not_found envelope carries didYouMean WITH ids", () => {
  const goals: Row[] = [
    { id: 1, name: "Retirement" },
    { id: 2, name: "Emergency Fund" },
  ];
  const holdings: Row[] = [
    { id: 10, name: "Vanguard All-World", symbol: "VWRL" },
    { id: 11, name: "Apple Inc", symbol: "AAPL" },
  ];

  it("goal not_found (was bare) → didYouMean candidates each with an id", () => {
    const env = resolveEntity({ entity: "goal", name: "Totally Unrelated ZZZ", options: goals });
    expect(env.status).toBe("not_found");
    if (env.status === "not_found") {
      expect(env.didYouMean?.length).toBeGreaterThan(0);
      for (const c of env.didYouMean!) expect(typeof c.id).toBe("number");
      // The single `suggestion` is preserved and equals didYouMean[0].
      expect(env.suggestion?.id).toBe(env.didYouMean![0].id);
    }
  });

  it("holding not_found → didYouMean carries symbol + id", () => {
    const env = resolveEntity({ entity: "holding", name: "Nope Corp QQQ", options: holdings });
    expect(env.status).toBe("not_found");
    if (env.status === "not_found") {
      expect(env.didYouMean?.length).toBeGreaterThan(0);
      expect(env.didYouMean!.every((c) => typeof c.id === "number")).toBe(true);
    }
  });

  it("empty inventory → not_found with NO didYouMean (nothing to suggest)", () => {
    const env = resolveEntity({ entity: "goal", name: "Anything", options: [] });
    expect(env.status).toBe("not_found");
    if (env.status === "not_found") expect(env.didYouMean).toBeUndefined();
  });
});

describe("FINLYNQ-273 — formatResolveFailure renders identically across families", () => {
  it("not_found message embeds candidate ids for every family", () => {
    for (const entity of ["goal", "category", "subscription", "rule"] as const) {
      const env = resolveEntity({ entity, name: "ZZZ Nope", options: [{ id: 42, name: "Groceries" }] });
      const msg = formatResolveFailure(entity, env)!;
      expect(msg).toMatch(/Did you mean:/);
      expect(msg).toContain("id=42");
      expect(msg).toContain("matched no " + entity);
    }
  });

  it("ambiguous message embeds candidate ids + a *_id disambiguation hint", () => {
    const env = resolveEntity({
      entity: "category",
      name: "Trave",
      options: [{ id: 1, name: "Travel" }, { id: 2, name: "Travel Insurance" }],
    });
    expect(env.status).toBe("ambiguous");
    const msg = formatResolveFailure("category", env)!;
    expect(msg).toContain("ambiguous");
    expect(msg).toContain("id=1");
    expect(msg).toContain("id=2");
    expect(msg).toContain("category_id");
  });

  it("resolved → null (nothing to report)", () => {
    expect(formatResolveFailure("goal", { status: "resolved", id: 3, via: "exact" })).toBeNull();
  });
});

// ─── Layer 2: handler harness ────────────────────────────────────────────────

type FixtureRow = Record<string, unknown>;
type RowsetFn = (text: string) => FixtureRow[] | undefined;

function serializeSqlTemplate(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const result = sqlObj.toQuery?.(dialect);
    if (result && typeof result.sql === "string") return result.sql;
  } catch {
    /* fall through */
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

function makeFixtureDb(matcher: RowsetFn): {
  db: { execute: (q: unknown) => Promise<unknown> };
  queries: string[];
} {
  const queries: string[] = [];
  const db = {
    execute: async (q: unknown) => {
      const text = serializeSqlTemplate(q);
      queries.push(text);
      const rows = matcher(text);
      return { rows: rows ?? [], rowCount: rows?.length ?? 0 };
    },
  };
  return { db, queries };
}

function getTool(
  name: string,
  db: { execute: (q: unknown) => Promise<unknown> },
  dek: Buffer | null,
) {
  const server = new McpServer({ name: "resolve-refusal-test", version: "0.0.0" });
  registerPgTools(server, db, "test-user", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  >;
  const tool = tools[name];
  if (!tool) throw new Error(`${name} tool not registered`);
  return tool;
}

function envelopeText(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any)?.content?.[0]?.text ?? "";
}

describe("FINLYNQ-273 — manage_subscriptions delete-by-name", () => {
  it("delete by exact name → DELETE + success (was id-only)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM subscriptions WHERE user_id/i.test(t) && !/AND id =/i.test(t))
        return [{ id: 5, name_ct: encryptField(dek, "Netflix") }];
      if (/FROM subscriptions WHERE id =/i.test(t)) return [{ id: 5, name_ct: encryptField(dek, "Netflix") }];
      return [];
    });
    const tool = getTool("manage_subscriptions", db, dek);
    const res = await tool.handler({ op: "delete", name: "Netflix" }, {});
    expect(envelopeText(res)).toMatch(/deleted/i);
    expect(queries.filter((q) => /DELETE FROM subscriptions/i.test(q)).length).toBeGreaterThan(0);
  });

  it("unmatched name → unified not_found (no DELETE)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM subscriptions WHERE user_id/i.test(t) ? [{ id: 5, name_ct: encryptField(dek, "Netflix") }] : [],
    );
    const tool = getTool("manage_subscriptions", db, dek);
    const res = await tool.handler({ op: "delete", name: "_NOPE_" }, {});
    expect(envelopeText(res)).toMatch(/matched no subscription/i);
    expect(queries.filter((q) => /DELETE FROM subscriptions/i.test(q))).toHaveLength(0);
  });

  it("ambiguous name → ambiguous list with ids (no DELETE)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM subscriptions WHERE user_id/i.test(t)
        ? [{ id: 5, name_ct: encryptField(dek, "News Daily") }, { id: 6, name_ct: encryptField(dek, "News Weekly") }]
        : [],
    );
    const tool = getTool("manage_subscriptions", db, dek);
    const res = await tool.handler({ op: "delete", name: "News" }, {});
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(envelopeText(res)).toMatch(/id=/);
    expect(queries.filter((q) => /DELETE FROM subscriptions/i.test(q))).toHaveLength(0);
  });

  it("id fast-path still works", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM subscriptions WHERE id =/i.test(t) ? [{ id: 5, name_ct: encryptField(dek, "Netflix") }] : [],
    );
    const tool = getTool("manage_subscriptions", db, dek);
    const res = await tool.handler({ op: "delete", id: 5 }, {});
    expect(envelopeText(res)).toMatch(/deleted/i);
    expect(queries.filter((q) => /DELETE FROM subscriptions/i.test(q)).length).toBeGreaterThan(0);
  });
});

describe("FINLYNQ-273 — manage_rules delete-by-name", () => {
  it("delete by name (name column encrypted) → DELETE + success", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM transaction_rules WHERE user_id/i.test(t) && !/AND id =/i.test(t))
        return [{ id: 9, name: encryptField(dek, "Coffee Rule") }];
      if (/FROM transaction_rules WHERE id =/i.test(t)) return [{ id: 9, name: encryptField(dek, "Coffee Rule") }];
      return [];
    });
    const tool = getTool("manage_rules", db, dek);
    const res = await tool.handler({ op: "delete", name: "Coffee Rule" }, {});
    expect(envelopeText(res)).toMatch(/deleted/i);
    // Message shows the DECRYPTED name, not ciphertext.
    expect(envelopeText(res)).toMatch(/Coffee Rule/);
    expect(envelopeText(res)).not.toMatch(/v1:/);
    expect(queries.filter((q) => /DELETE FROM transaction_rules/i.test(q)).length).toBeGreaterThan(0);
  });

  it("unmatched rule name → unified not_found (no DELETE)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM transaction_rules WHERE user_id/i.test(t) ? [{ id: 9, name: encryptField(dek, "Coffee Rule") }] : [],
    );
    const tool = getTool("manage_rules", db, dek);
    const res = await tool.handler({ op: "delete", name: "_NOPE_" }, {});
    expect(envelopeText(res)).toMatch(/matched no rule/i);
    expect(queries.filter((q) => /DELETE FROM transaction_rules/i.test(q))).toHaveLength(0);
  });

  it("id fast-path still works", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM transaction_rules WHERE id =/i.test(t) ? [{ id: 9, name: encryptField(dek, "Coffee Rule") }] : [],
    );
    const tool = getTool("manage_rules", db, dek);
    const res = await tool.handler({ op: "delete", id: 9 }, {});
    expect(envelopeText(res)).toMatch(/deleted/i);
    expect(queries.filter((q) => /DELETE FROM transaction_rules/i.test(q)).length).toBeGreaterThan(0);
  });
});

describe("FINLYNQ-273 — manage_categories delete COMMIT accepts the previewed name", () => {
  it("preview by name → token; commit by the SAME name → DELETE", async () => {
    const dek = randomBytes(32);
    // A clean (no-dependent) category so commit deletes directly.
    const catRows = [{ id: 3, name_ct: encryptField(dek, "Gifts") }];
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM categories WHERE user_id = .* AND id = /i.test(t)) return catRows;
      if (/FROM categories WHERE user_id/i.test(t)) return catRows;
      if (/COUNT\(\*\)/i.test(t)) return [{ cnt: 0 }];
      return [];
    });
    const tool = getTool("manage_categories", db, dek);
    // 1. Preview by name → get a confirmationToken.
    const preview = await tool.handler({ op: "delete", name: "Gifts" }, {});
    const previewPayload = JSON.parse(envelopeText(preview));
    const token = previewPayload?.data?.confirmationToken as string;
    expect(token).toBeTruthy();
    // 2. Commit by name (NOT id) + that token → success + a DELETE fires.
    const commit = await tool.handler({ op: "delete", name: "Gifts", confirmation_token: token }, {});
    expect(envelopeText(commit)).toMatch(/deleted/i);
    expect(queries.filter((q) => /DELETE FROM categories/i.test(q)).length).toBeGreaterThan(0);
  });

  it("commit with a mistyped name → unified not_found (no DELETE, token untouched)", async () => {
    const dek = randomBytes(32);
    const catRows = [{ id: 3, name_ct: encryptField(dek, "Gifts") }];
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM categories WHERE user_id/i.test(t)) return catRows;
      if (/COUNT\(\*\)/i.test(t)) return [{ cnt: 0 }];
      return [];
    });
    const tool = getTool("manage_categories", db, dek);
    const res = await tool.handler({ op: "delete", name: "_NOPE_", confirmation_token: "irrelevant" }, {});
    expect(envelopeText(res)).toMatch(/matched no category/i);
    expect(queries.filter((q) => /DELETE FROM categories/i.test(q))).toHaveLength(0);
  });
});
