/**
 * FINLYNQ-182 — pure aggregation core for the Dividends report.
 *
 * Covers the test-plan cases that don't need a live DB:
 *   - tc-3 (uses-stored-fields): reporting mode sums the STORED
 *     `reportingAmount` grouped by `reportingCurrency` and NEVER converts the
 *     raw `amount` at render time. A row whose reporting fields are NULL is
 *     EXCLUDED (counted as `unratedCount`), never on-the-fly converted.
 *   - tc-1 (one-row-per-period): native pivot collapses a year with mixed
 *     USD/CAD rows into ONE period row carrying a per-currency `byCurrency`
 *     breakdown (no duplicate period rows).
 *   - tc-5 (attribution-preserved, partial): the helper folds rows by the
 *     attribution `holdingId` it is handed (the SQL COALESCE happens upstream);
 *     it never re-derives attribution, so a row whose `holdingId` is the
 *     paying security stays grouped under that security.
 *
 * Pure (no DB) — `aggregateDividendRows` is the DB-free core extracted from
 * `listDividendIncome`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  aggregateDividendRows,
  type DividendRow,
} from "@/lib/portfolio/dividends";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function row(p: Partial<DividendRow>): DividendRow {
  return {
    txId: 1,
    date: "2026-03-15",
    amount: 100,
    currency: "USD",
    isReinvested: false,
    isWithholding: false,
    holdingId: 10,
    holdingName: "VOO",
    accountId: 1,
    accountName: "TFSA",
    payee: null,
    reportingAmount: null,
    reportingCurrency: null,
    ...p,
  };
}

describe("aggregateDividendRows — native pivot (tc-1)", () => {
  it("collapses a year with mixed USD + CAD into ONE row with a per-currency breakdown", () => {
    const rows: DividendRow[] = [
      row({ txId: 1, date: "2026-02-01", amount: 24.91, currency: "USD" }),
      row({ txId: 2, date: "2026-05-01", amount: 236.61, currency: "CAD" }),
      row({ txId: 3, date: "2026-08-01", amount: 10, currency: "USD" }),
    ];

    const { groups, totals, modeFields } = aggregateDividendRows(rows, {
      groupBy: "year",
      reportingMode: false,
      pivot: true,
      displayCurrency: "USD",
    });

    expect(modeFields.mode).toBe("native");
    // One row per period — NOT one per (period, currency).
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.label).toBe("2026");
    expect(g.rowCount).toBe(3); // summed across currencies
    expect(g.byCurrency).toBeDefined();
    expect(g.byCurrency!.USD.amount).toBeCloseTo(34.91, 2);
    expect(g.byCurrency!.USD.rowCount).toBe(2);
    expect(g.byCurrency!.CAD.amount).toBeCloseTo(236.61, 2);
    expect(g.byCurrency!.CAD.rowCount).toBe(1);
    // Native totals stay per-currency.
    expect(totals.byCurrency.USD).toBeCloseTo(34.91, 2);
    expect(totals.byCurrency.CAD).toBeCloseTo(236.61, 2);
    expect(totals.unratedCount).toBeUndefined();
  });

  it("legacy native (pivot=false) keeps per-(period,currency) rows for mobile/MCP", () => {
    const rows: DividendRow[] = [
      row({ txId: 1, date: "2026-02-01", amount: 24.91, currency: "USD" }),
      row({ txId: 2, date: "2026-05-01", amount: 236.61, currency: "CAD" }),
    ];
    const { groups } = aggregateDividendRows(rows, {
      groupBy: "year",
      reportingMode: false,
      pivot: false,
      displayCurrency: "USD",
    });
    // Two rows — one per currency (unchanged legacy behavior).
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.byCurrency === undefined)).toBe(true);
  });
});

describe("aggregateDividendRows — reporting mode (tc-3)", () => {
  it("sums STORED reportingAmount grouped by reportingCurrency; never converts raw amount", () => {
    const rows: DividendRow[] = [
      // amount is the NATIVE figure; reportingAmount is the stored historical
      // figure. The reporting total MUST equal the stored reportingAmount sum,
      // NOT the native amount (which would be the result of a render-time FX).
      row({
        txId: 1,
        date: "2026-02-01",
        amount: 236.61,
        currency: "CAD",
        reportingAmount: 175.0,
        reportingCurrency: "USD",
      }),
      row({
        txId: 2,
        date: "2026-05-01",
        amount: 24.91,
        currency: "USD",
        reportingAmount: 24.91,
        reportingCurrency: "USD",
      }),
    ];

    const { groups, totals, modeFields } = aggregateDividendRows(rows, {
      groupBy: "year",
      reportingMode: true,
      pivot: false,
      displayCurrency: "USD",
    });

    expect(modeFields.mode).toBe("reporting");
    expect((modeFields as { reportingCurrency: string }).reportingCurrency).toBe("USD");
    // ONE period row in the single reporting currency.
    expect(groups).toHaveLength(1);
    expect(groups[0].amount).toBeCloseTo(175.0 + 24.91, 2);
    // Proof we used the stored fields, not the native amounts (236.61 + 24.91).
    expect(groups[0].amount).not.toBeCloseTo(236.61 + 24.91, 2);
    expect(totals.amount).toBeCloseTo(199.91, 2);
    expect(totals.byCurrency.USD).toBeCloseTo(199.91, 2);
    expect(totals.byCurrency.CAD).toBeUndefined();
  });

  it("EXCLUDES rows with NULL reporting fields (counts them as unratedCount, never converts)", () => {
    const rows: DividendRow[] = [
      row({
        txId: 1,
        date: "2026-02-01",
        amount: 100,
        currency: "USD",
        reportingAmount: 100,
        reportingCurrency: "USD",
      }),
      // Laggard — not yet re-rated. MUST be excluded, NOT on-the-fly converted.
      row({
        txId: 2,
        date: "2026-03-01",
        amount: 50,
        currency: "CAD",
        reportingAmount: null,
        reportingCurrency: null,
      }),
    ];

    const { groups, totals } = aggregateDividendRows(rows, {
      groupBy: "year",
      reportingMode: true,
      pivot: false,
      displayCurrency: "USD",
    });

    expect(totals.amount).toBeCloseTo(100, 2); // laggard excluded
    expect(totals.unratedCount).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].amount).toBeCloseTo(100, 2);
    expect(groups[0].unratedCount).toBe(1);
  });
});

describe("aggregateDividendRows — attribution preserved (tc-5, partial)", () => {
  it("folds rows by the attribution holdingId it is handed, never re-deriving it", () => {
    // Two dividend rows attributed to the PAYING SECURITY (holdingId 42) — the
    // SQL COALESCE(related_holding_id, portfolio_holding_id) is upstream. The
    // helper must group them together under that security.
    const rows: DividendRow[] = [
      row({ txId: 1, holdingId: 42, holdingName: "AAPL", accountId: 1, amount: 5 }),
      row({ txId: 2, holdingId: 42, holdingName: "AAPL", accountId: 1, amount: 7 }),
      row({ txId: 3, holdingId: 99, holdingName: "MSFT", accountId: 1, amount: 3 }),
    ];
    const { groups } = aggregateDividendRows(rows, {
      groupBy: "holding",
      reportingMode: false,
      pivot: true,
      displayCurrency: "USD",
    });
    const aapl = groups.find((g) => g.label === "AAPL");
    const msft = groups.find((g) => g.label === "MSFT");
    expect(aapl?.amount).toBeCloseTo(12, 2);
    expect(aapl?.rowCount).toBe(2);
    expect(msft?.amount).toBeCloseTo(3, 2);
  });
});

describe("listDividendIncome source guards (tc-3 / tc-5)", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../src/lib/portfolio/dividends.ts"),
    "utf8",
  );

  it("tc-3: reporting path reads stored fields and never imports a render-time FX converter", () => {
    // It SELECTs the stored reporting columns.
    expect(src).toContain("reportingAmount: schema.transactions.reportingAmount");
    expect(src).toContain("reportingCurrency: schema.transactions.reportingCurrency");
    // It does NOT pull in the on-the-fly conversion helpers.
    expect(src).not.toContain("convertReportingSlice");
    expect(src).not.toContain("convertWithRateMap");
  });

  it("tc-5: FINLYNQ-173 attribution (COALESCE related→sleeve + holdingId-matches-either) is intact", () => {
    expect(src).toContain(
      "COALESCE(${schema.transactions.relatedHoldingId}, ${schema.transactions.portfolioHoldingId})",
    );
    expect(src).toContain(
      "${schema.transactions.portfolioHoldingId} = ${filter.holdingId} OR ${schema.transactions.relatedHoldingId} = ${filter.holdingId}",
    );
  });
});
