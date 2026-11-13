/**
 * The chart-load self-heal starts a FULL-history rebuild (investment walk from
 * the first holding, then every cash account from its first transaction) when
 * it sees an "orphaned" investment snapshot. It used to call any snapshot row
 * whose account had no live holdings value an orphan, but an EMPTIED account
 * (every position sold) legitimately keeps a zero row every day and the
 * rebuild's reaper keeps it, so the signal never cleared and every chart load
 * rebuilt all history (2026-11-13, seen as "day 903 of 1413" then cash "day
 * 1936 of 28720" right after booking one entry).
 *
 * The rule is now the reaper's own: an orphan is a snapshot account NOT in
 * getHoldingAccountIds. These tests pin the pure rule and that the route and the
 * reaper read the same set, so one rebuild always clears what triggered it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: {} }));
vi.mock("@/lib/portfolio/snapshots/builder", () => ({
  buildDailySnapshot: vi.fn(),
  loadInvestmentAccountsActiveSince: vi.fn(),
}));
vi.mock("@/lib/portfolio/snapshots/cash-builder", () => ({
  rebuildCashSnapshots: vi.fn(),
}));

import { reapableInvestmentAccounts } from "@/lib/portfolio/snapshots/rebuild";

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ROOT = join(__dirname, "..");
const route = stripComments(
  readFileSync(join(ROOT, "src/app/api/net-worth-history/route.ts"), "utf8"),
);
const rebuild = stripComments(
  readFileSync(join(ROOT, "src/lib/portfolio/snapshots/rebuild.ts"), "utf8"),
);

describe("reapableInvestmentAccounts", () => {
  it("is every snapshot account the reaper does not keep, once each", () => {
    expect(reapableInvestmentAccounts([1, 2, 3, 2], new Set([1, 3]))).toEqual([2]);
  });

  it("does not flag an emptied account that still has holdings rows", () => {
    // Account 7 sold everything: no live value, but its holdings rows remain,
    // so it is in the keep set and its zero rows are legitimate.
    expect(reapableInvestmentAccounts([7], new Set([7, 8]))).toEqual([]);
  });

  it("flags every account when nothing holds positions any more", () => {
    expect(reapableInvestmentAccounts([4, 5], new Set())).toEqual([4, 5]);
  });
});

describe("the chart's orphan trigger uses the reaper's rule", () => {
  it("route decides hasInvestmentOrphans through getHoldingAccountIds + reapableInvestmentAccounts", () => {
    expect(route).toMatch(/await getHoldingAccountIds\(userId\)/);
    expect(route).toMatch(
      /hasInvestmentOrphans\s*=\s*reapableInvestmentAccounts\(/,
    );
  });

  it("route no longer calls a row without a live value an orphan", () => {
    expect(route).not.toMatch(
      /hasInvestmentOrphans\s*=\s*snapshots\.some\([\s\S]{0,80}?liveInvestmentByAccount\.has/,
    );
  });

  it("the reaper keeps exactly getHoldingAccountIds", () => {
    expect(rebuild).toMatch(/const holdingAccountIds = await getHoldingAccountIds\(userId\)/);
    const reaps = rebuild.match(/await deleteInvestmentOrphanSnapshots\(userId, (\w+)\)/g) ?? [];
    expect(reaps.length).toBeGreaterThan(0);
    for (const call of reaps) expect(call).toContain("holdingAccountIds");
  });
});
