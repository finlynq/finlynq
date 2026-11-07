/**
 * `GET /api/reports` refuses dates a report can't run for, before any work
 * (2026-11-07). The income statement values every holding at both ends of the
 * range, so a half-typed start date of 0002-01-01 priced the whole portfolio at
 * year 2. tests/api/reports.test.ts is quarantined, so the guard has its own
 * file: the 400 path returns before the route touches the DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: "u1", method: "account", mfaVerified: false, dek: null, sessionId: "s1" },
  })),
}));

const getDisplayCurrency = vi.fn(async () => "USD");
const getRateMap = vi.fn(async () => new Map());
vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: (...a: unknown[]) => getDisplayCurrency(...(a as [])),
  getRateMap: (...a: unknown[]) => getRateMap(...(a as [])),
  convertWithRateMap: (n: number) => n,
}));

import { GET } from "@/app/api/reports/route";
import { createMockRequest, parseResponse } from "./helpers/api-test-utils";

beforeEach(() => {
  getDisplayCurrency.mockClear();
  getRateMap.mockClear();
});

describe("GET /api/reports date guard", () => {
  it.each([
    ["startDate=0002-01-01&endDate=2026-11-07"],
    ["startDate=0201-01-01"],
    ["startDate=1969-12-31"],
    ["endDate=2026-02-30"],
    ["startDate=not-a-date"],
    ["type=balance-sheet&endDate=0020-01-01"],
  ])("answers 400 for %s without running the report", async (qs) => {
    const res = await GET(createMockRequest(`http://localhost:3000/api/reports?${qs}`));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(400);
    expect(String((data as { error?: string }).error)).toMatch(/YYYY-MM-DD/);
    expect(getDisplayCurrency).not.toHaveBeenCalled();
    expect(getRateMap).not.toHaveBeenCalled();
  });
});

// A position nobody held on the valuation date is skipped by the valuation
// loop, so asking Yahoo for its price there was pure waste: ~80 refused calls
// per report for a start date before the user's first purchase.
describe("holdings valuation prices only positions held on the date", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/holdings-value.ts"), "utf8");

  it("builds the stock and crypto price lists from heldOnDate", () => {
    expect(src).toMatch(/const heldOnDate = holdings\.filter\(\(h\) => isMaterialQty\(qtyByHoldingId\.get\(h\.id\) \?\? 0\)\)/);
    expect(src).toMatch(/const stockSymbols = heldOnDate\b/);
    expect(src).toMatch(/for \(const h of heldOnDate\) \{\s*if \(isManual\(h\)\) continue; \/\/ manual securities never hit CoinGecko/);
  });
});
