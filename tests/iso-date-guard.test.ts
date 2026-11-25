// Malformed transaction dates (2026-11-24).
//
// The web transaction routes took `date: z.string()`, so one prod transaction
// was saved as "2026-09-4". `new Date("2026-09-4T00:00:00")` is invalid, and
// the insights day-of-week math then read `data[NaN].total` and threw on every
// load for that user. This pins the three parts of the fix: the shared strict
// rule, the routes using it, and the insights math skipping a bad date.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isIsoDate, isoDateSchema } from "@/lib/schemas/iso-date";
import { spendingByDayOfWeek } from "@/lib/spending-insights";
import { ymdDate } from "../mcp-server/lib/date-validators";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("isIsoDate / isoDateSchema", () => {
  it.each(["2026-09-04", "2024-02-29", "2026-12-31", "1999-01-01"])("accepts %s", (d) => {
    expect(isIsoDate(d)).toBe(true);
    expect(isoDateSchema.parse(d)).toBe(d);
  });

  it.each([
    "2026-09-4",
    "2026-9-04",
    "2025-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "2026-09-04T00:00:00",
    "20260904",
    "",
    " 2026-09-04",
  ])("rejects %j", (d) => {
    expect(isIsoDate(d)).toBe(false);
    expect(isoDateSchema.safeParse(d).success).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20260904)).toBe(false);
  });

  it("MCP's ymdDate is the same rule", () => {
    expect(ymdDate).toBe(isoDateSchema);
  });
});

describe("spendingByDayOfWeek with a malformed date", () => {
  it("skips the bad row instead of throwing", () => {
    const result = spendingByDayOfWeek([
      { date: "2026-09-4", amount: -25 },
      { date: "not a date", amount: -10 },
      { date: "2024-01-15", amount: -50 }, // Monday
    ]);
    expect(result.length).toBe(7);
    expect(result.reduce((s, r) => s + r.count, 0)).toBe(1);
    expect(result.find((r) => r.day === "Monday")!.total).toBe(50);
  });
});

describe("transaction write routes validate dates with the shared rule", () => {
  const routes = [
    "src/app/api/transactions/route.ts",
    "src/app/api/transactions/transfer/route.ts",
    "src/app/api/transactions/bulk/route.ts",
    ...["buy", "deposit", "fx-conversion", "income-expense", "sell", "swap", "transfer", "withdrawal"].map(
      (op) => `src/app/api/portfolio/operations/${op}/route.ts`,
    ),
  ];

  it.each(routes)("%s", (rel) => {
    const src = read(rel);
    expect(src).toContain('from "@/lib/schemas/iso-date"');
    expect(src).toMatch(/\bdate:\s*isoDateSchema/);
    // No loose `date: z.string()` left behind.
    expect(src).not.toMatch(/\bdate:\s*z\.string\(\)/);
  });
});

describe("repair migration", () => {
  const sql = read("scripts/migrations/20261124c_repair_unpadded_transaction_dates.sql");

  it("only touches unpadded dates and stamps updated_at", () => {
    expect(sql).toContain("date ~ '^\\d{4}-\\d{1,2}-\\d{1,2}$'");
    expect(sql).toContain("date !~ '^\\d{4}-\\d{2}-\\d{2}$'");
    expect(sql).toMatch(/SET date = f\.new_date, updated_at = NOW\(\)/);
  });

  it("marks balance history stale and never deletes a transaction", () => {
    expect(sql).toContain("portfolio_cash_snapshot_dirty");
    expect(sql).toContain("portfolio_snapshot_dirty");
    expect(sql).not.toMatch(/DELETE\s+FROM\s+transactions/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});
