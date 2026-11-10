/**
 * The cash leg that closes every snapshot rebuild is scoped to the CALLER's
 * date (2026-11-10). It used to run full history every time, so booking one
 * transaction last month made the chart-load self-heal rewrite every cash
 * account back to 2015 — one row per account per day ("day 16623 of 28633").
 *
 * `@/db` and the builders are mocked so nothing touches Postgres: every DB probe
 * answers with one row whose `minDate` is FIRST_HOLDING and whose `accountId`
 * is 1 (so the investment walk runs and the first-holding clamp is exercised).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const FIRST_HOLDING = "2026-10-01";

vi.mock("@/db", () => {
  const rows = async () => [{ minDate: "2026-10-01", accountId: 1 }];
  const chain = () => ({ from: () => ({ where: rows }) });
  return {
    db: {
      select: chain,
      selectDistinct: chain,
      execute: vi.fn(async () => ({ rows: [] })),
    },
    schema: {
      transactions: { userId: "user_id", date: "date", portfolioHoldingId: "portfolio_holding_id" },
      portfolioSnapshots: { userId: "user_id", snapDate: "snap_date" },
      portfolioHoldings: { userId: "user_id", accountId: "account_id" },
      holdingAccounts: { userId: "user_id", accountId: "account_id" },
    },
  };
});

vi.mock("@/lib/portfolio/snapshots/builder", () => ({
  buildDailySnapshot: vi.fn(async () => ({ gapsFilled: false })),
  loadInvestmentAccountsActiveSince: vi.fn(async () => new Map()),
}));

type CashOpts = {
  fromDate: string | null;
  toDate: string;
  stampMeta?: boolean;
  onProgress?: (done: number, total: number) => void;
};
const rebuildCashSnapshots = vi.fn(async (_opts: CashOpts) => undefined);
vi.mock("@/lib/portfolio/snapshots/cash-builder", () => ({
  rebuildCashSnapshots: (opts: CashOpts) => rebuildCashSnapshots(opts),
}));

import { cashLegWindow, rebuildPortfolioSnapshots } from "@/lib/portfolio/snapshots/rebuild";

let n = 0;
const uid = () => `cash-leg-${Date.now()}-${n++}`;

beforeEach(() => {
  rebuildCashSnapshots.mockClear();
});

describe("cashLegWindow", () => {
  it("a caller date rebuilds from that date and leaves the watermark alone", () => {
    expect(cashLegWindow("2026-10-15")).toEqual({ fromDate: "2026-10-15", stampMeta: false });
  });

  it("no caller date rebuilds full history and stamps the watermark", () => {
    expect(cashLegWindow(null)).toEqual({ fromDate: null, stampMeta: true });
    expect(cashLegWindow(undefined)).toEqual({ fromDate: null, stampMeta: true });
    expect(cashLegWindow("")).toEqual({ fromDate: null, stampMeta: true });
  });
});

describe("rebuildPortfolioSnapshots cash leg", () => {
  it("a dated rebuild (dirty marker) runs the cash leg from that date, unstamped", async () => {
    await rebuildPortfolioSnapshots(uid(), "2026-11-01", "2026-11-03", null);
    expect(rebuildCashSnapshots).toHaveBeenCalledTimes(1);
    const opts = rebuildCashSnapshots.mock.calls[0][0];
    expect(opts.fromDate).toBe("2026-11-01");
    expect(opts.stampMeta).toBe(false);
    expect(opts.toDate).toBe("2026-11-03");
  });

  it("an undated rebuild (manual button) still runs full cash history and stamps", async () => {
    await rebuildPortfolioSnapshots(uid(), null, "2026-10-03", null);
    const opts = rebuildCashSnapshots.mock.calls[0][0];
    expect(opts.fromDate).toBeNull();
    expect(opts.stampMeta).toBe(true);
  });

  it("uses the caller's date, not the investment start clamped up to the first holding", async () => {
    // A cash edit dated before the first holding: the investment walk starts at
    // FIRST_HOLDING, but the impacted cash days begin at the edit date.
    const result = await rebuildPortfolioSnapshots(uid(), "2026-09-15", "2026-10-02", null);
    expect(result.fromDate).toBe(FIRST_HOLDING);
    expect(rebuildCashSnapshots.mock.calls[0][0].fromDate).toBe("2026-09-15");
  });

  it("reports the cash leg's progress under the 'cash' phase", async () => {
    const phases: Array<string | undefined> = [];
    await rebuildPortfolioSnapshots(uid(), "2026-11-01", "2026-11-01", null, (_d, _t, phase) =>
      phases.push(phase),
    );
    rebuildCashSnapshots.mock.calls[0][0].onProgress?.(1, 4);
    expect(phases.at(-1)).toBe("cash");
  });
});

describe("chart-load self-heal forwards the phase", () => {
  it("kickSelfHeal passes the phase into the progress registry", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/api/net-worth-history/route.ts"),
      "utf8",
    );
    const body = src.slice(
      src.indexOf("function kickSelfHeal("),
      src.indexOf("function kickCashSelfHeal("),
    );
    expect(body).toMatch(
      /\(done,\s*total,\s*phase\)\s*=>\s*reportRebuildProgress\(userId,\s*done,\s*total,\s*phase\)/,
    );
  });
});
