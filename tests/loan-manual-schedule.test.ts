/**
 * A loan's own schedule (2026-10-12): per-payment interest overrides on the
 * calculated schedule, and a complete manual schedule that replaces it.
 *
 * Three things are pinned here:
 *   1. the calculator's behaviour for both,
 *   2. the fixed-layout CSV (template out, upload in, no mapping),
 *   3. that EVERY surface building a schedule from a stored loan applies the
 *      loan's own rows. A surface that forgets shows the calculated schedule
 *      while the Loans page shows the user's, and balances then disagree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLoanSchedule,
  loanScheduleExtras,
  LoanValidationError,
  normalizeInterestOverrides,
  normalizeManualSchedule,
} from "@/lib/loan-calculator";
import {
  parseScheduleCsv,
  scheduleTemplateRows,
  SCHEDULE_CSV_COLUMNS,
} from "@/lib/loans/manual-schedule";
import { serializeCsv } from "@/lib/csv-export";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const base = { principal: 12000, annualRate: 6, termMonths: 24, startDate: "2026-01-15" };

describe("interest overrides on a calculated schedule", () => {
  const plain = buildLoanSchedule(base);
  const second = plain.schedule[1];

  it("replaces the interest of that payment only, and flags the row", () => {
    const s = buildLoanSchedule({ ...base, interestOverrides: { [second.date]: 87 } });
    expect(s.scheduleMode).toBe("calculated");
    expect(s.schedule[1].interest).toBe(87);
    expect(s.schedule[1].interestOverridden).toBe(true);
    expect(s.schedule[0].interest).toBe(plain.schedule[0].interest);
    expect(s.schedule[0].interestOverridden).toBeUndefined();
  });

  // The payment is what the user really paid; more of it going to interest
  // means less going to principal, and every later balance is higher for it.
  it("keeps the payment, so the principal and later balances follow", () => {
    const s = buildLoanSchedule({ ...base, interestOverrides: { [second.date]: 87 } });
    expect(s.schedule[1].payment).toBe(second.payment);
    expect(s.schedule[1].principal).toBeCloseTo(second.payment - 87, 2);
    expect(s.schedule[1].balance).toBeGreaterThan(second.balance);
    expect(s.schedule[2].interest).toBeGreaterThan(plain.schedule[2].interest);
  });

  it("an override of 0 is honoured, not treated as missing", () => {
    const s = buildLoanSchedule({ ...base, interestOverrides: { [second.date]: 0 } });
    expect(s.schedule[1].interest).toBe(0);
    expect(s.schedule[1].interestOverridden).toBe(true);
  });

  it("an override for a date that is not a payment date changes nothing", () => {
    const s = buildLoanSchedule({ ...base, interestOverrides: { "2026-02-16": 500 } });
    expect(s.schedule.map((r) => r.interest)).toEqual(plain.schedule.map((r) => r.interest));
  });

  it("with no overrides the schedule is exactly what it was", () => {
    const s = buildLoanSchedule({ ...base, interestOverrides: null, manualSchedule: null });
    expect(s.schedule).toEqual(plain.schedule);
    expect(s.totalInterest).toBe(plain.totalInterest);
  });
});

describe("manual schedule", () => {
  const rows = [
    { date: "2026-02-15", payment: 587, interest: 87 },
    { date: "2026-03-15", payment: 587, interest: 87 },
    { date: "2026-04-15", payment: 600, interest: 87 },
  ];

  it("replaces the calculation and derives principal and balance", () => {
    const s = buildLoanSchedule({ ...base, manualSchedule: rows });
    expect(s.scheduleMode).toBe("manual");
    expect(s.schedule).toHaveLength(3);
    expect(s.schedule.map((r) => r.principal)).toEqual([500, 500, 513]);
    expect(s.schedule.map((r) => r.balance)).toEqual([11500, 11000, 10487]);
    expect(s.totalInterest).toBe(261);
    expect(s.totalPayments).toBe(1774);
  });

  it("ignores the rate, term and any interest overrides", () => {
    const a = buildLoanSchedule({ ...base, manualSchedule: rows });
    const b = buildLoanSchedule({
      ...base,
      annualRate: 99,
      termMonths: 3,
      interestOverrides: { "2026-02-15": 1 },
      manualSchedule: rows,
    });
    expect(b.schedule).toEqual(a.schedule);
  });

  it("reports the payment that occurs most often", () => {
    expect(buildLoanSchedule({ ...base, manualSchedule: rows }).paymentPerPeriod).toBe(587);
  });

  it("reports what the rows leave unpaid when they stop short of payoff", () => {
    const s = buildLoanSchedule({ ...base, manualSchedule: rows });
    expect(s.residualValue).toBe(10487);
    expect(s.payoffDate).toBe("2026-04-15");
  });

  it("stops the balance at zero on a final over-payment, and dates the payoff there", () => {
    const s = buildLoanSchedule({
      principal: 1000,
      annualRate: 5,
      startDate: "2026-01-01",
      manualSchedule: [
        { date: "2026-02-01", payment: 600, interest: 10 },
        { date: "2026-03-01", payment: 600, interest: 5 },
        { date: "2026-04-01", payment: 50, interest: 0 },
      ],
    });
    expect(s.schedule[1].balance).toBe(0);
    expect(s.schedule[1].principal).toBe(410);
    expect(s.payoffDate).toBe("2026-03-01");
  });

  it("lets the balance grow when a payment did not cover its interest", () => {
    const s = buildLoanSchedule({
      principal: 1000,
      annualRate: 5,
      startDate: "2026-01-01",
      manualSchedule: [{ date: "2026-02-01", payment: 20, interest: 50 }],
    });
    expect(s.schedule[0].principal).toBe(-30);
    expect(s.schedule[0].balance).toBe(1030);
  });

  it("spreads each row's interest across the calendar months it spans", () => {
    const s = buildLoanSchedule({ ...base, manualSchedule: rows });
    const total = s.monthlyAccrual.reduce((sum, m) => sum + m.interest, 0);
    expect(total).toBeCloseTo(261, 1);
    expect(s.monthlyAccrual[0].month).toBe("2026-01");
  });

  it("accepts rows in any order and sorts them", () => {
    const s = buildLoanSchedule({ ...base, manualSchedule: [rows[2], rows[0], rows[1]] });
    expect(s.schedule.map((r) => r.date)).toEqual(["2026-02-15", "2026-03-15", "2026-04-15"]);
  });
});

describe("validation is a 400, never a 500", () => {
  const bad: Array<[string, unknown]> = [
    ["no rows", []],
    ["not an array", { date: "2026-02-15" }],
    ["an impossible date", [{ date: "2026-02-30", payment: 1, interest: 0 }]],
    ["a date in another format", [{ date: "02/15/2026", payment: 1, interest: 0 }]],
    ["a negative payment", [{ date: "2026-02-15", payment: -1, interest: 0 }]],
    ["a negative interest", [{ date: "2026-02-15", payment: 1, interest: -1 }]],
    ["a non-number", [{ date: "2026-02-15", payment: "abc", interest: 0 }]],
    [
      "the same date twice",
      [
        { date: "2026-02-15", payment: 1, interest: 0 },
        { date: "2026-02-15", payment: 2, interest: 0 },
      ],
    ],
  ];
  for (const [name, input] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => normalizeManualSchedule(input)).toThrow(LoanValidationError);
    });
  }

  it("refuses bad interest overrides the same way", () => {
    expect(() => normalizeInterestOverrides({ "2026-13-01": 5 })).toThrow(LoanValidationError);
    expect(() => normalizeInterestOverrides({ "2026-02-15": -5 })).toThrow(LoanValidationError);
    expect(() => normalizeInterestOverrides([1, 2])).toThrow(LoanValidationError);
    expect(normalizeInterestOverrides(null)).toEqual({});
    expect(normalizeInterestOverrides({ "2026-02-15": 87.456 })).toEqual({ "2026-02-15": 87.46 });
  });
});

describe("loanScheduleExtras reads every row shape", () => {
  const manual = [{ date: "2026-02-15", payment: 587, interest: 87 }];
  const overrides = { "2026-02-15": 87 };

  it("Drizzle shape", () => {
    expect(loanScheduleExtras({ manualSchedule: manual, interestOverrides: overrides })).toMatchObject({
      manualSchedule: manual,
      interestOverrides: overrides,
    });
  });

  it("raw SQL shape", () => {
    expect(loanScheduleExtras({ manual_schedule: manual, interest_overrides: overrides })).toMatchObject({
      manualSchedule: manual,
      interestOverrides: overrides,
    });
  });

  it("JSON that arrived as text", () => {
    const got = loanScheduleExtras({
      manual_schedule: JSON.stringify(manual),
      interest_overrides: JSON.stringify(overrides),
    });
    expect(got).toMatchObject({ manualSchedule: manual, interestOverrides: overrides });
  });

  it("nothing stored means calculated", () => {
    for (const row of [{}, { manual_schedule: null, interest_overrides: null }, { manualSchedule: [] }]) {
      expect(loanScheduleExtras(row)).toMatchObject({ manualSchedule: null, interestOverrides: null });
    }
  });

  it("unreadable JSON degrades to calculated instead of throwing", () => {
    expect(loanScheduleExtras({ manual_schedule: "{not json" })).toMatchObject({
      manualSchedule: null,
      interestOverrides: null,
    });
  });
});

describe("schedule CSV: the template is the format", () => {
  const schedule = buildLoanSchedule(base).schedule;
  const template = serializeCsv(
    scheduleTemplateRows(schedule),
    SCHEDULE_CSV_COLUMNS.map((c) => ({ header: c, accessor: (r: Record<string, string | number>) => r[c] })),
    { bom: false },
  );

  it("the downloaded template uploads back unchanged", () => {
    const parsed = parseScheduleCsv(template);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows).toEqual(
      schedule.map((r) => ({ date: r.date, payment: r.payment, interest: r.interest })),
    );
    // And building from those rows reproduces the schedule the user downloaded.
    // The file carries amounts to the cent while the calculation keeps
    // fractions of a cent, so balances may drift by cents, never by more.
    const rebuilt = buildLoanSchedule({ ...base, manualSchedule: parsed.rows }).schedule;
    rebuilt.forEach((r, i) => expect(Math.abs(r.balance - schedule[i].balance)).toBeLessThan(0.25));
  });

  it("reads only date, payment and interest; principal and balance are reference", () => {
    const parsed = parseScheduleCsv("date,payment,interest,principal,balance\n2026-02-15,587,87,99999,99999\n");
    expect(parsed).toEqual({ ok: true, rows: [{ date: "2026-02-15", payment: 587, interest: 87 }] });
  });

  it("survives what a spreadsheet does on save: BOM, CRLF, quotes, thousands separators, blank lines", () => {
    const csv = '﻿Date,Payment,Interest\r\n2026-02-15,"1,587.50",$87.00\r\n\r\n2026-03-15,587,87\r\n';
    const parsed = parseScheduleCsv(csv);
    expect(parsed).toEqual({
      ok: true,
      rows: [
        { date: "2026-02-15", payment: 1587.5, interest: 87 },
        { date: "2026-03-15", payment: 587, interest: 87 },
      ],
    });
  });

  it("accepts columns in another order", () => {
    const parsed = parseScheduleCsv("interest,date,payment\n87,2026-02-15,587\n");
    expect(parsed).toEqual({ ok: true, rows: [{ date: "2026-02-15", payment: 587, interest: 87 }] });
  });

  // A spreadsheet re-saves dates in the computer's own style. One cell cannot
  // say which, but a schedule's dates always rise, and only one reading does.
  it("reads month-first dates", () => {
    const parsed = parseScheduleCsv("date,payment,interest\n2/15/2026,587,87\n3/15/2026,587,87\n");
    expect(parsed.ok && parsed.rows.map((r) => r.date)).toEqual(["2026-02-15", "2026-03-15"]);
  });

  it("reads day-first dates", () => {
    const parsed = parseScheduleCsv("date,payment,interest\n15/02/2026,587,87\n15/03/2026,587,87\n");
    expect(parsed.ok && parsed.rows.map((r) => r.date)).toEqual(["2026-02-15", "2026-03-15"]);
  });

  // 7/9, 7/10, 7/11 is the 7th of Sep, Oct, Nov for one user and three days
  // in July for another. Only one of those is a payment schedule.
  it("picks the reading that looks like a schedule when a date could be either", () => {
    const dayFirst = parseScheduleCsv("date,payment,interest\n7/9/2026,1,0\n7/10/2026,1,0\n7/11/2026,1,0\n");
    expect(dayFirst.ok && dayFirst.rows.map((r) => r.date)).toEqual(["2026-09-07", "2026-10-07", "2026-11-07"]);
    const monthFirst = parseScheduleCsv("date,payment,interest\n2/7/2026,1,0\n3/7/2026,1,0\n4/7/2026,1,0\n");
    expect(monthFirst.ok && monthFirst.rows.map((r) => r.date)).toEqual(["2026-02-07", "2026-03-07", "2026-04-07"]);
  });

  // Wrong dates are worse than a refused upload, so a real tie is not guessed.
  it("refuses dates that make a plausible schedule both ways", () => {
    // 5 Jan and 12 Jan (weekly), or 1 May and 1 Dec.
    const tie = parseScheduleCsv("date,payment,interest\n1/5/2026,1,0\n1/12/2026,1,0\n");
    expect(tie.ok).toBe(false);
    if (!tie.ok) expect(tie.errors[0]).toContain("YYYY-MM-DD");
    // A single row can always be read both ways.
    expect(parseScheduleCsv("date,payment,interest\n3/4/2026,1,0\n").ok).toBe(false);
  });

  it("accepts a date that reads the same both ways", () => {
    const parsed = parseScheduleCsv("date,payment,interest\n5/5/2026,1,0\n");
    expect(parsed.ok && parsed.rows[0].date).toBe("2026-05-05");
  });

  it("names the missing columns and points at the template", () => {
    const parsed = parseScheduleCsv("when,amount\n2026-02-15,587\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[0]).toContain("date, payment, interest");
      expect(parsed.errors[0]).toContain("template");
    }
  });

  it("reports every bad line with its line number, not just the first", () => {
    const parsed = parseScheduleCsv("date,payment,interest\n2026-02-15,abc,87\n2026-03-15,587,\n2026-04-15,587,87\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([
        "Line 2: payment must be a number, 0 or more.",
        "Line 3: interest must be a number, 0 or more.",
      ]);
    }
  });

  it("refuses an empty file, a header-only file, and unreadable dates", () => {
    expect(parseScheduleCsv("").ok).toBe(false);
    expect(parseScheduleCsv("date,payment,interest\n").ok).toBe(false);
    const dates = parseScheduleCsv("date,payment,interest\nFeb 15,587,87\n");
    expect(dates.ok).toBe(false);
    if (!dates.ok) expect(dates.errors[0]).toContain("YYYY-MM-DD");
  });

  it("refuses a repeated date", () => {
    const parsed = parseScheduleCsv("date,payment,interest\n2026-02-15,587,87\n2026-02-15,587,87\n");
    expect(parsed.ok).toBe(false);
  });
});

describe("every surface applies the loan's own schedule (static wiring)", () => {
  // Minimum number of places in each file that hand the stored rows to the
  // calculator. A new schedule build that omits them has to be added here.
  const expected: Record<string, number> = {
    "src/app/api/loans/route.ts": 3,
    // The interest writer and the dashboard check both get their rows here.
    "src/lib/loans/interest-check.ts": 1,
    "src/lib/loans/schedule-store.ts": 2,
    "src/lib/health/debt-service.ts": 1,
    "src/lib/financial-health.ts": 1,
    "mcp-server/tools/loans.ts": 5,
    "mcp-server/register-core-tools.ts": 2,
  };
  for (const [file, min] of Object.entries(expected)) {
    it(`${file} spreads loanScheduleExtras into its schedule builds`, () => {
      const calls = read(file).match(/loanScheduleExtras\(/g) ?? [];
      expect(calls.length).toBeGreaterThanOrEqual(min);
    });
  }

  // Raw SQL has to name the columns or `loanScheduleExtras` gets nothing and
  // silently falls back to the calculated schedule.
  it("every raw loans SELECT that feeds a schedule also selects the stored rows", () => {
    for (const file of ["mcp-server/tools/loans.ts", "mcp-server/register-core-tools.ts", "src/lib/financial-health.ts"]) {
      const selects = read(file).match(/SELECT[^;`]*?FROM loans/g) ?? [];
      const scheduleSelects = selects.filter((q) => /residual_value/.test(q));
      expect(scheduleSelects.length, file).toBeGreaterThan(0);
      for (const q of scheduleSelects) {
        expect(q, `${file}: ${q.slice(0, 60)}`).toContain("manual_schedule");
        expect(q, `${file}: ${q.slice(0, 60)}`).toContain("interest_overrides");
        expect(q, `${file}: ${q.slice(0, 60)}`).toContain("payment_overrides");
        expect(q, `${file}: ${q.slice(0, 60)}`).toContain("interest_method");
        expect(q, `${file}: ${q.slice(0, 60)}`).toContain("interest_amount");
      }
    }
  });

  it("REST and MCP both change a schedule through saveLoanSchedule", () => {
    expect(read("src/app/api/loans/schedule/route.ts")).toContain("saveLoanSchedule(");
    expect(read("mcp-server/tools/loans.ts")).toContain("saveLoanSchedule(");
  });

  it("the migration and schema-pg.ts declare the same two columns", () => {
    const sql = read("scripts/migrations/20261012c_loans_manual_schedule.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS manual_schedule JSONB");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS interest_overrides JSONB");
    const schema = read("src/db/schema-pg.ts");
    expect(schema).toContain('jsonb("manual_schedule")');
    expect(schema).toContain('jsonb("interest_overrides")');
  });
});
