/**
 * Which accounts the investment snapshot builder writes a zero row for
 * (2026-10-29, in-app feedback #27). The real-database case is
 * portfolio-snapshot-emptied-account.test.ts; this pins the decision itself
 * with the valuation mocked, including the case that test can't stage
 * without a network call: an account that holds something it could not
 * price that day must NOT be recorded as empty (that would overwrite good
 * history with a false dip during a price-provider outage).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Same-day legs the builder reads for net contribution.
let legs: Array<Record<string, unknown>> = [];
const executed: SQL[] = [];
vi.mock("@/db", async () => {
  const schemaPg = await vi.importActual<typeof import("@/db/schema-pg")>("@/db/schema-pg");
  return {
    schema: schemaPg,
    db: {
      select: () => ({ from: () => ({ where: async () => legs }) }),
      execute: async (q: SQL) => {
        executed.push(q);
      },
    },
  };
});

// Valued accounts, plus accounts that hold something (priced or not).
let valued = new Map<number, { accountId: number; value: number; costBasis: number; currency: string }>();
let held: number[] = [];
vi.mock("@/lib/holdings-value", () => ({
  getHoldingsValueByAccount: async (_u: string, _d: unknown, opts: { heldAccountIds?: Set<number> }) => {
    for (const id of held) opts.heldAccountIds?.add(id);
    return valued;
  },
}));
vi.mock("../mcp-server/reporting-currency", () => ({ resolveReportingCurrency: async () => "HKD" }));
vi.mock("@/lib/fx-service", () => ({ getRate: async () => 7.78 }));

import { buildDailySnapshot } from "@/lib/portfolio/snapshots/builder";

const DEK = Buffer.alloc(32, 1);

/** The per-account tuples of the one INSERT, as plain objects. */
function writtenRows() {
  const { params } = new PgDialect().sqlToQuery(executed[executed.length - 1]);
  // Per-account tuple: user, date, account, mv, cb, contribution, currency,
  // nativeMv, nativeCurrency, gapsFilled, source (11). The aggregate tuple
  // ends the list with a literal NULL account (10 params).
  const perAccount = params.slice(0, params.length - 10);
  const rows = [];
  for (let i = 0; i < perAccount.length; i += 11) {
    const t = perAccount.slice(i, i + 11);
    rows.push({ accountId: t[2], mv: t[3], contribution: t[5], nativeMv: t[7], nativeCurrency: t[8] });
  }
  return rows;
}

describe("buildDailySnapshot zero rows", () => {
  beforeEach(() => {
    executed.length = 0;
    legs = [];
    valued = new Map([[1, { accountId: 1, value: 1000, costBasis: 900, currency: "USD" }]]);
    held = [1];
  });

  const active = new Map([
    [1, { since: "2021-01-01", currency: "USD" }],
    [2, { since: "2021-01-01", currency: "USD" }],
    [3, { since: "2021-01-01", currency: "EUR" }],
    [4, { since: "2022-06-01", currency: "USD" }],
  ]);

  it("writes zero for an emptied account, nothing for one not started or holding unpriced", async () => {
    held = [1, 3]; // 3 holds something that had no price today
    const result = await buildDailySnapshot({ userId: "u", date: "2021-09-29", dek: DEK, activeAccounts: active });

    expect(writtenRows()).toEqual([
      { accountId: 1, mv: 1000 * 7.78, contribution: 0, nativeMv: 1000, nativeCurrency: "USD" },
      { accountId: 2, mv: 0, contribution: 0, nativeMv: 0, nativeCurrency: "USD" },
    ]);
    expect(result.perAccountRows).toBe(2);
  });

  it("keeps the withdrawal day's flow on the zero row, in the reporting currency", async () => {
    legs = [{ accountId: 2, enteredAmount: null, amount: -14799.24, linkId: "L1", tradeLinkId: null, quantity: -14799.24, kind: "brokerage_withdrawal_out" }];
    await buildDailySnapshot({ userId: "u", date: "2021-09-28", dek: DEK, activeAccounts: active });

    const zero = writtenRows().find((r) => r.accountId === 2);
    expect(zero?.mv).toBe(0);
    expect(zero?.contribution).toBeCloseTo(-14799.24 * 7.78, 6);
  });

  it("writes no rows at all without a DEK", async () => {
    const result = await buildDailySnapshot({ userId: "u", date: "2021-09-29", dek: null, activeAccounts: active });
    expect(result.perAccountRows).toBe(0);
    expect(executed).toHaveLength(0);
  });
});

describe("rebuild wiring (static)", () => {
  it("loads the active accounts once and passes them to every day", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/portfolio/snapshots/rebuild.ts"), "utf8");
    const walk = src.slice(src.indexOf("loadInvestmentAccountsActiveSince(userId)"));
    expect(walk.length).toBeGreaterThan(0);
    expect(walk).toMatch(/buildDailySnapshot\(\{[^}]*activeAccounts/);
  });
});
