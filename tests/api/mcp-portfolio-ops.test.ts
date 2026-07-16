/**
 * MCP portfolio_* operation tools + investment-account refusal.
 *
 * Verifies the two halves of this change:
 *   1. record_transaction REFUSES any investment account outright (full block —
 *      no longer "fine if a holding is bound"), pointing the caller at the
 *      portfolio_* tools. createTransaction is never reached.
 *   2. portfolio_buy resolves account + holding and routes through the canonical
 *      domain helper `recordBuy` with source='mcp_http', then invalidates the
 *      per-user tx cache and marks snapshots dirty. Refuses without a DEK.
 *
 * In-process harness (no live DB): mock the operations domain layer + the
 * investment-account predicate, bootstrap registerPgTools against a tiny
 * resolver DB, and invoke the registered tool handlers directly — same pattern
 * as mcp-record-transaction-parity.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// Stable env so the auth/encryption modules don't blow up at import time.
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// ── Mocks ──────────────────────────────────────────────────────────────────
// Spy on the canonical buy helper; keep the REAL error classes so the handler's
// `instanceof` error mapping still resolves.
const recordBuySpy = vi.fn();
vi.mock("@/lib/portfolio/operations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portfolio/operations")>();
  return { ...actual, recordBuy: (...a: unknown[]) => recordBuySpy(...a) };
});

// Treat account #7 as an investment account (both the per-call predicate and
// the bulk pre-fetch set).
vi.mock("@/lib/investment-account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/investment-account")>();
  return {
    ...actual,
    isInvestmentAccount: vi.fn(async () => true),
    getInvestmentAccountIds: vi.fn(async () => new Set<number>([7])),
  };
});

// Assert these side effects fire after a portfolio write.
const invalidateUserSpy = vi.fn();
vi.mock("@/lib/mcp/user-tx-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/user-tx-cache")>();
  return { ...actual, invalidateUser: (...a: unknown[]) => invalidateUserSpy(...a) };
});
const markSnapshotsDirtySpy = vi.fn();
vi.mock("@/lib/portfolio/snapshots/dirty", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portfolio/snapshots/dirty")>();
  return { ...actual, markSnapshotsDirty: (...a: unknown[]) => markSnapshotsDirtySpy(...a) };
});

// Spy on createTransaction to PROVE record_transaction never writes to an
// investment account.
const createTransactionSpy = vi.fn();
vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return { ...actual, createTransaction: (...a: unknown[]) => createTransactionSpy(...a) };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";
import { encryptField } from "../../src/lib/crypto/envelope";

const DEK = randomBytes(32);

/**
 * Fake DbLike for the resolution SELECTs the handlers run before the write:
 *   1. accounts lookup (id, currency, name_ct, alias_ct) → account #7
 *   2. portfolio_holdings ownership pre-check (portfolio_buy with holdingId)
 * Routes by substring-matching the serialized SQL text.
 */
function makeResolverDb() {
  const acctNameCt = encryptField(DEK, "Questrade USD");
  return {
    execute: async (q: unknown) => {
      const text = serializeSqlTemplate(q);
      if (/FROM\s+accounts/i.test(text)) {
        return { rows: [{ id: 7, currency: "USD", name_ct: acctNameCt, alias_ct: null }], rowCount: 1 };
      }
      if (/FROM\s+portfolio_holdings/i.test(text)) {
        return { rows: [{ ok: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

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

function bootstrap(dek: Buffer | null = DEK) {
  const db = makeResolverDb();
  const server = new McpServer({ name: "portfolio-ops-test", version: "0.0.0" });
  registerPgTools(server, db, "user-1", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler?: (args: unknown, extra: unknown) => Promise<unknown> }
  >;
  return { tools };
}

function bodyText(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

beforeEach(() => {
  recordBuySpy.mockReset();
  invalidateUserSpy.mockReset();
  markSnapshotsDirtySpy.mockReset();
  createTransactionSpy.mockReset();
  recordBuySpy.mockResolvedValue({ stockLegTxId: 1, cashLegTxId: 2, tradeLinkId: "trade-uuid", lotId: 9 });
});

describe("record_transaction refuses investment accounts", () => {
  it("returns an error pointing at portfolio_* and never calls createTransaction", async () => {
    const { tools } = bootstrap();
    const cb = tools["record_transaction"].handler!;
    const res = await cb(
      { amount: -1500, payee: "AAPL", account_id: 7, date: "2026-06-10" },
      {},
    );
    const txt = bodyText(res);
    expect(txt).toMatch(/investment account/i);
    // FINLYNQ-282: the refusal now points at the v4 consolidated tool, not the
    // retired per-verb portfolio_* names (which are hidden aliases absent from
    // tools/list).
    expect(txt).toMatch(/portfolio_record_entry/);
    expect(txt).toMatch(/entry_type/);
    expect(createTransactionSpy).not.toHaveBeenCalled();
  });

  it("refuses on the dryRun path too (preview the block)", async () => {
    const { tools } = bootstrap();
    const cb = tools["record_transaction"].handler!;
    const res = await cb(
      { amount: -1500, payee: "AAPL", account_id: 7, dryRun: true, date: "2026-06-10" },
      {},
    );
    expect(bodyText(res)).toMatch(/investment account/i);
    expect(createTransactionSpy).not.toHaveBeenCalled();
  });
});

describe("portfolio_buy routes through the operations domain layer", () => {
  it("calls recordBuy with the resolved ids, source='mcp_http', and fires the side effects", async () => {
    const { tools } = bootstrap();
    expect(tools["portfolio_buy"], "portfolio_buy is registered").toBeDefined();
    const cb = tools["portfolio_buy"].handler!;
    const res = await cb(
      { account_id: 7, holdingId: 55, qty: 10, totalCost: 1500, date: "2026-06-10" },
      {},
    );
    expect(recordBuySpy).toHaveBeenCalledTimes(1);
    const arg = recordBuySpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.accountId).toBe(7);
    expect(arg.holdingId).toBe(55);
    expect(arg.qty).toBe(10);
    expect(arg.totalCost).toBe(1500);
    expect(arg.source).toBe("mcp_http");
    expect(arg.date).toBe("2026-06-10");
    // Side effects: per-user tx cache invalidated + snapshots marked dirty.
    expect(invalidateUserSpy).toHaveBeenCalledWith("user-1");
    expect(markSnapshotsDirtySpy).toHaveBeenCalledWith("user-1", "2026-06-10");
    const body = JSON.parse(bodyText(res));
    expect(body.success).toBe(true);
    expect(body.data.tradeLinkId).toBe("trade-uuid");
    expect(body.data.resolvedAccount.id).toBe(7);
  });

  it("refuses without a DEK before touching the domain layer", async () => {
    const { tools } = bootstrap(null);
    const cb = tools["portfolio_buy"].handler!;
    const res = await cb(
      { account_id: 7, holdingId: 55, qty: 1, totalCost: 1, date: "2026-06-10" },
      {},
    );
    expect(bodyText(res)).toMatch(/DEK/);
    expect(recordBuySpy).not.toHaveBeenCalled();
  });
});
