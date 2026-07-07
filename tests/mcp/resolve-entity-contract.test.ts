/**
 * FINLYNQ-267 — tc-1 contract suite for the shared name-resolver.
 *
 * Table-driven: for each migrated name-accepting tool + name param, assert the
 * three house-rule cases against an in-process registered handler with a mocked
 * DB (same fixture pattern as delete-account.test.ts):
 *   (a) nonexistent name  → a warning / not-found error; NEVER a silent success
 *       (for the create linkers: the row is NOT created-with-no-link — it errors);
 *   (b) name matching 2+ rows → an `ambiguous` candidate list; NOT a first-pick;
 *   (c) id + conflicting name → the row identified by `id` is used (id wins).
 *
 * Cases are appended per phase as tools migrate. Runs DB-free (the mock DB maps
 * SQL substrings to canned rowsets) so it gates in CI's DB-free path.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";

process.env.PF_JWT_SECRET = process.env.PF_JWT_SECRET ?? "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { encryptField } from "../../src/lib/crypto/envelope";

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
  const server = new McpServer({ name: "resolve-contract-test", version: "0.0.0" });
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

function fakeAccountRow(id: number, name: string, dek: Buffer): FixtureRow {
  return { id, name_ct: encryptField(dek, name), alias_ct: null };
}

/** Two accounts sharing a startsWith prefix so a fuzzy `Sav*` is ambiguous. */
function ambiguousAccounts(dek: Buffer): FixtureRow[] {
  return [fakeAccountRow(2, "Savings", dek), fakeAccountRow(3, "Savings Bonds", dek)];
}

const INSERT_RE = {
  goal: /INSERT INTO goals/i,
  loan: /INSERT INTO loans/i,
  subscription: /INSERT INTO subscriptions/i,
};

describe("FINLYNQ-267 tc-1 — add_goal (Phase 1)", () => {
  it("(a) mistyped account name → REFUSES the create (no INSERT, warning)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM accounts WHERE user_id/i.test(t) ? [fakeAccountRow(2, "Savings", dek)] : [],
    );
    const tool = getTool("add_goal", db, dek);
    const res = await tool.handler(
      { name: "Vacation", type: "savings", target_amount: 1000, account: "_NOPE_" },
      {},
    );
    expect(envelopeText(res)).toMatch(/matched no account|not found|no confident/i);
    expect(queries.filter((q) => INSERT_RE.goal.test(q))).toHaveLength(0);
  });

  it("(b) account name matching 2+ rows → ambiguous (no INSERT)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM accounts WHERE user_id/i.test(t) ? ambiguousAccounts(dek) : [],
    );
    const tool = getTool("add_goal", db, dek);
    const res = await tool.handler(
      { name: "Vacation", type: "savings", target_amount: 1000, account: "Savin" },
      {},
    );
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(queries.filter((q) => INSERT_RE.goal.test(q))).toHaveLength(0);
  });

  it("(c) account_id + conflicting name → id wins (INSERT links account_id)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM accounts WHERE user_id/i.test(t) && /id = ANY/i.test(t)) return [{ id: 2 }];
      if (/FROM accounts WHERE user_id/i.test(t)) return ambiguousAccounts(dek);
      if (INSERT_RE.goal.test(t)) return [{ id: 55 }];
      return [];
    });
    const tool = getTool("add_goal", db, dek);
    // account_id=2 conflicts with a fuzzy name that would be ambiguous — id wins.
    const res = await tool.handler(
      { name: "Vacation", type: "savings", target_amount: 1000, account_id: 2, account: "Savin" },
      {},
    );
    const text = envelopeText(res);
    expect(text).not.toMatch(/ambiguous|not found/i);
    expect(queries.filter((q) => INSERT_RE.goal.test(q)).length).toBeGreaterThan(0);
  });
});

describe("FINLYNQ-267 tc-1 — add_loan (Phase 1)", () => {
  it("(a) mistyped account name → REFUSES the create (no INSERT)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM accounts WHERE user_id/i.test(t) ? [fakeAccountRow(2, "Savings", dek)] : [],
    );
    const tool = getTool("add_loan", db, dek);
    const res = await tool.handler(
      { name: "Car", type: "auto", principal: 20000, annual_rate: 5, start_date: "2026-01-01", term_months: 60, account: "_NOPE_" },
      {},
    );
    expect(envelopeText(res)).toMatch(/matched no account|not found|no confident/i);
    expect(queries.filter((q) => INSERT_RE.loan.test(q))).toHaveLength(0);
  });

  it("(b) account name matching 2+ rows → ambiguous (no INSERT)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM accounts WHERE user_id/i.test(t) ? ambiguousAccounts(dek) : [],
    );
    const tool = getTool("add_loan", db, dek);
    const res = await tool.handler(
      { name: "Car", type: "auto", principal: 20000, annual_rate: 5, start_date: "2026-01-01", term_months: 60, account: "Savin" },
      {},
    );
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(queries.filter((q) => INSERT_RE.loan.test(q))).toHaveLength(0);
  });

  it("(c) account_id + conflicting name → id wins (INSERT)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM accounts WHERE user_id/i.test(t)) return ambiguousAccounts(dek).concat(fakeAccountRow(2, "Savings", dek));
      if (INSERT_RE.loan.test(t)) return [{ id: 77 }];
      return [];
    });
    const tool = getTool("add_loan", db, dek);
    const res = await tool.handler(
      { name: "Car", type: "auto", principal: 20000, annual_rate: 5, start_date: "2026-01-01", term_months: 60, account_id: 2, account: "Savin" },
      {},
    );
    expect(envelopeText(res)).not.toMatch(/ambiguous|not found/i);
    expect(queries.filter((q) => INSERT_RE.loan.test(q)).length).toBeGreaterThan(0);
  });
});

describe("FINLYNQ-267 tc-1 — add_subscription (Phase 1)", () => {
  it("(a) mistyped account name → REFUSES the create (no INSERT)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM subscriptions\s+WHERE user_id = .* AND name_lookup/i.test(t)) return [];
      if (/FROM accounts WHERE user_id/i.test(t)) return [fakeAccountRow(2, "Savings", dek)];
      return [];
    });
    const tool = getTool("add_subscription", db, dek);
    const res = await tool.handler(
      { name: "Netflix", amount: 15, cadence: "monthly", next_billing_date: "2026-02-01", account: "_NOPE_" },
      {},
    );
    expect(envelopeText(res)).toMatch(/matched no account|not found|no confident/i);
    expect(queries.filter((q) => INSERT_RE.subscription.test(q))).toHaveLength(0);
  });

  it("(b) account name matching 2+ rows → ambiguous (no INSERT)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM subscriptions\s+WHERE user_id = .* AND name_lookup/i.test(t)) return [];
      if (/FROM accounts WHERE user_id/i.test(t)) return ambiguousAccounts(dek);
      return [];
    });
    const tool = getTool("add_subscription", db, dek);
    const res = await tool.handler(
      { name: "Netflix", amount: 15, cadence: "monthly", next_billing_date: "2026-02-01", account: "Savin" },
      {},
    );
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(queries.filter((q) => INSERT_RE.subscription.test(q))).toHaveLength(0);
  });

  it("(c) account_id + conflicting name → id wins (INSERT)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM subscriptions\s+WHERE user_id = .* AND name_lookup/i.test(t)) return [];
      if (/FROM accounts WHERE user_id/i.test(t)) return ambiguousAccounts(dek).concat(fakeAccountRow(2, "Savings", dek));
      if (INSERT_RE.subscription.test(t)) return [{ id: 88 }];
      return [];
    });
    const tool = getTool("add_subscription", db, dek);
    const res = await tool.handler(
      { name: "Netflix", amount: 15, cadence: "monthly", next_billing_date: "2026-02-01", account_id: 2, account: "Savin" },
      {},
    );
    expect(envelopeText(res)).not.toMatch(/ambiguous|not found/i);
    expect(queries.filter((q) => INSERT_RE.subscription.test(q)).length).toBeGreaterThan(0);
  });
});

// ── Phase 2 — silent-first writes now ambiguous-aware + id fast-paths ─────────

function fakeGoalRow(id: number, name: string, dek: Buffer): FixtureRow {
  return { id, name_ct: encryptField(dek, name) };
}
function fakeCatRow(id: number, name: string, dek: Buffer): FixtureRow {
  return { id, name_ct: encryptField(dek, name) };
}
function fakeHoldingRow(id: number, name: string, symbol: string, dek: Buffer): FixtureRow {
  return { id, name_ct: encryptField(dek, name), symbol_ct: encryptField(dek, symbol) };
}

describe("FINLYNQ-267 tc-1 — delete_budget category (Phase 2)", () => {
  it("(a) nonexistent category → not-found (no DELETE)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM categories WHERE user_id/i.test(t) ? [fakeCatRow(1, "Groceries", dek)] : [],
    );
    const tool = getTool("delete_budget", db, dek);
    const res = await tool.handler({ category: "_NOPE_", month: "2026-01" }, {});
    expect(envelopeText(res)).toMatch(/matched no category|not found|no confident/i);
    expect(queries.filter((q) => /DELETE FROM budgets/i.test(q))).toHaveLength(0);
  });

  it("(b) category name matching 2+ rows → ambiguous (no DELETE)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM categories WHERE user_id/i.test(t)
        ? [fakeCatRow(1, "Travel", dek), fakeCatRow(2, "Travel Insurance", dek)]
        : [],
    );
    const tool = getTool("delete_budget", db, dek);
    const res = await tool.handler({ category: "Trave", month: "2026-01" }, {});
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(queries.filter((q) => /DELETE FROM budgets/i.test(q))).toHaveLength(0);
  });

  it("(c) category_id + conflicting name → id wins", async () => {
    const dek = randomBytes(32);
    const { db } = makeFixtureDb((t) => {
      if (/FROM categories WHERE user_id/i.test(t))
        return [fakeCatRow(1, "Travel", dek), fakeCatRow(2, "Travel Insurance", dek)];
      if (/FROM budgets WHERE user_id/i.test(t)) return [{ id: 9 }];
      return [];
    });
    const tool = getTool("delete_budget", db, dek);
    const res = await tool.handler({ category_id: 1, category: "Trave", month: "2026-01" }, {});
    expect(envelopeText(res)).not.toMatch(/ambiguous|matched no category/i);
  });
});

describe("FINLYNQ-267 tc-1 — update_goal (Phase 2)", () => {
  it("(a) nonexistent goal name → not-found (no UPDATE goals)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM goals WHERE user_id/i.test(t) ? [fakeGoalRow(1, "Retirement", dek)] : [],
    );
    const tool = getTool("update_goal", db, dek);
    const res = await tool.handler({ goal: "_NOPE_", target_amount: 500 }, {});
    expect(envelopeText(res)).toMatch(/matched no goal|not found|no confident/i);
    expect(queries.filter((q) => /UPDATE goals SET/i.test(q))).toHaveLength(0);
  });

  it("(b) goal name matching 2+ rows → ambiguous (no UPDATE)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM goals WHERE user_id/i.test(t)
        ? [fakeGoalRow(1, "House Fund", dek), fakeGoalRow(2, "House Reno", dek)]
        : [],
    );
    const tool = getTool("update_goal", db, dek);
    const res = await tool.handler({ goal: "House", target_amount: 500 }, {});
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(queries.filter((q) => /UPDATE goals SET/i.test(q))).toHaveLength(0);
  });

  it("(c) goal_id + conflicting name → id wins (UPDATE)", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) => {
      if (/FROM goals WHERE user_id/i.test(t))
        return [fakeGoalRow(1, "House Fund", dek), fakeGoalRow(2, "House Reno", dek)];
      return [];
    });
    const tool = getTool("update_goal", db, dek);
    const res = await tool.handler({ goal_id: 1, goal: "House", target_amount: 500 }, {});
    expect(envelopeText(res)).not.toMatch(/ambiguous|matched no goal/i);
    expect(queries.filter((q) => /UPDATE goals SET/i.test(q)).length).toBeGreaterThan(0);
  });
});

describe("FINLYNQ-267 tc-1 — delete_portfolio_holding (Phase 2, ambiguous flip 5a)", () => {
  it("(b) name matching 2 positions across accounts → ambiguous (no DELETE) — was silent-first", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM portfolio_holdings\s+WHERE user_id/i.test(t)
        ? [fakeHoldingRow(10, "Vanguard All-World", "VWRL", dek), fakeHoldingRow(11, "Vanguard All-World", "VWRL", dek)]
        : [],
    );
    const tool = getTool("delete_portfolio_holding", db, dek);
    const res = await tool.handler({ holding: "Vanguard All-World" }, {});
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(queries.filter((q) => /DELETE FROM portfolio_holdings/i.test(q))).toHaveLength(0);
  });

  it("(c) holdingId bypasses fuzzy (resolves the id)", async () => {
    const dek = randomBytes(32);
    const { db } = makeFixtureDb((t) => {
      if (/FROM portfolio_holdings\s+WHERE user_id/i.test(t))
        return [fakeHoldingRow(10, "Vanguard All-World", "VWRL", dek), fakeHoldingRow(11, "Vanguard All-World", "VWRL", dek)];
      if (/FROM transactions WHERE user_id/i.test(t)) return [{ cnt: 0 }];
      if (/FROM holding_lots WHERE user_id/i.test(t)) return [{ cnt: 0 }];
      return [];
    });
    const tool = getTool("delete_portfolio_holding", db, dek);
    const res = await tool.handler({ holdingId: 11 }, {});
    // No ambiguous error — the id resolved a single row (a clean 0-tx/0-lot
    // holding deletes directly; the response is a success, not an ambiguity).
    expect(envelopeText(res)).not.toMatch(/ambiguous/i);
  });
});

// ── Phase 3 — normalize already-strict + fuzzy writes onto the envelope ───────
// NOTE: record_transaction / update_transaction category paths were migrated in
// Phase 3 too, but their handlers call adapter-bound helpers (isInvestmentAccount)
// that need the real DB — they can't run against this DB-free mock harness, so
// they're exercised by the full-suite integration tests rather than tc-1 here.

describe("FINLYNQ-267 tc-1 — delete_account name resolution (Phase 3, ambiguous-aware)", () => {
  it("(b) account name matching 2+ rows → ambiguous (no DELETE) — was fuzzy silent-first", async () => {
    const dek = randomBytes(32);
    const { db, queries } = makeFixtureDb((t) =>
      /FROM accounts WHERE user_id/i.test(t) ? ambiguousAccounts(dek) : [],
    );
    const tool = getTool("delete_account", db, dek);
    const res = await tool.handler({ account: "Savin" }, {});
    expect(envelopeText(res)).toMatch(/ambiguous/i);
    expect(queries.filter((q) => /DELETE FROM accounts/i.test(q))).toHaveLength(0);
  });
});

// ── Phase 4 — preview_delete_category name path onto the envelope ─────────────

describe("FINLYNQ-267 tc-1 — preview_delete_category name (Phase 4)", () => {
  it("(a) mistyped name → not-found (no token minted)", async () => {
    const dek = randomBytes(32);
    const { db } = makeFixtureDb((t) =>
      /FROM categories WHERE user_id/i.test(t) ? [fakeCatRow(1, "Groceries", dek)] : [],
    );
    const tool = getTool("preview_delete_category", db, dek);
    const res = await tool.handler({ name: "_NOPE_" }, {});
    // FINLYNQ-273 — category refusal now uses the unified `matched no <entity>`
    // wording (was the bespoke `"X" not found. Did you mean:`).
    expect(envelopeText(res)).toMatch(/matched no category|not found|no confident/i);
    expect(envelopeText(res)).not.toMatch(/confirmationToken/i);
  });

  it("(b) name matching 2+ rows → ambiguous (was fuzzy silent-first)", async () => {
    const dek = randomBytes(32);
    const { db } = makeFixtureDb((t) =>
      /FROM categories WHERE user_id/i.test(t)
        ? [fakeCatRow(1, "Travel", dek), fakeCatRow(2, "Travel Insurance", dek)]
        : [],
    );
    const tool = getTool("preview_delete_category", db, dek);
    const res = await tool.handler({ name: "Trave" }, {});
    expect(envelopeText(res)).toMatch(/ambiguous/i);
  });
});
