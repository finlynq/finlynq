/**
 * Edited payments on a calculated loan schedule (2026-11-09, owner request).
 *
 * A different payment on one row (more, less, or 0 for a skipped one) keeps
 * that row's interest CALCULATED from the balance owed; the principal is what
 * is left of the payment, and every later row and the payoff date follow.
 * Before this, a different payment meant switching to a manual schedule and
 * typing every row's interest by hand.
 *
 * Pinned here: the calculator, the stored-row reader, the one write path
 * (`saveLoanSchedule`, with `@/db` mocked), and the column's migration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dbState = vi.hoisted(() => ({
  loan: null as Record<string, unknown> | null,
  saved: null as Record<string, unknown> | null,
}));

vi.mock("@/db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    get: async () => dbState.loan,
  };
  return {
    db: {
      select: () => chain,
      update: () => ({
        set: (values: Record<string, unknown>) => {
          dbState.saved = values;
          return { where: async () => undefined };
        },
      }),
    },
    schema: { loans: { id: "id", userId: "user_id" } },
  };
});

import {
  buildLoanSchedule,
  loanScheduleExtras,
  LoanValidationError,
  normalizePaymentOverrides,
} from "@/lib/loan-calculator";
import { saveLoanSchedule, readLoanSchedule } from "@/lib/loans/schedule-store";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const base = { principal: 12000, annualRate: 6, termMonths: 24, startDate: "2026-01-15" };
const plain = buildLoanSchedule(base);
const regular = plain.monthlyPayment;

describe("an edited payment keeps the interest calculated", () => {
  it("a bigger payment: same interest on that row, more principal, less interest after, earlier payoff", () => {
    const row = plain.schedule[2];
    const s = buildLoanSchedule({ ...base, paymentOverrides: { [row.date]: 2000 } });
    const edited = s.schedule[2];
    expect(edited.payment).toBe(2000);
    expect(edited.interest).toBe(row.interest); // balance before this row is unchanged
    expect(edited.principal).toBeCloseTo(2000 - row.interest, 2);
    expect(edited.paymentOverridden).toBe(true);
    expect(edited.interestOverridden).toBeUndefined();
    // The next row's interest is on a smaller balance.
    expect(s.schedule[3].interest).toBeLessThan(plain.schedule[3].interest);
    expect(s.schedule[3].payment).toBe(regular);
    expect(s.schedule.length).toBeLessThan(plain.schedule.length);
    expect(s.totalInterest).toBeLessThan(plain.totalInterest);
    expect(s.payoffDate < plain.payoffDate).toBe(true);
    // The summary's payment is still the loan's regular one.
    expect(s.monthlyPayment).toBe(regular);
    expect(s.scheduleMode).toBe("calculated");
  });

  it("a skipped payment (0): the interest is added to the balance and the loan runs longer", () => {
    const row = plain.schedule[0];
    const s = buildLoanSchedule({ ...base, paymentOverrides: { [row.date]: 0 } });
    expect(s.schedule[0].payment).toBe(0);
    expect(s.schedule[0].interest).toBe(60); // 12000 * 6% / 12
    expect(s.schedule[0].principal).toBe(-60);
    expect(s.schedule[0].balance).toBe(12060);
    expect(s.schedule[1].interest).toBeGreaterThan(plain.schedule[1].interest);
    expect(s.schedule.length).toBeGreaterThan(plain.schedule.length);
  });

  it("a payment above what is owed pays the loan off on that row and no further", () => {
    const row = plain.schedule[5];
    const s = buildLoanSchedule({ ...base, paymentOverrides: { [row.date]: 50000 } });
    expect(s.schedule).toHaveLength(6);
    const last = s.schedule[5];
    expect(last.balance).toBe(0);
    expect(last.payment).toBeCloseTo(plain.schedule[4].balance + row.interest, 2);
  });

  it("replaces the regular payment AND the extra payment", () => {
    const withExtra = buildLoanSchedule({ ...base, extraPayment: 100 });
    const row = withExtra.schedule[1];
    const s = buildLoanSchedule({ ...base, extraPayment: 100, paymentOverrides: { [row.date]: 700 } });
    expect(s.schedule[1].payment).toBe(700);
    expect(s.schedule[1].extraPayment).toBe(0);
    expect(s.schedule[2].extraPayment).toBe(100);
  });

  it("with an interest edit on the same row, the principal is the payment minus that interest", () => {
    const row = plain.schedule[1];
    const s = buildLoanSchedule({
      ...base,
      paymentOverrides: { [row.date]: 800 },
      interestOverrides: { [row.date]: 50 },
    });
    expect(s.schedule[1]).toMatchObject({ payment: 800, interest: 50, principal: 750 });
    expect(s.schedule[1]).toMatchObject({ paymentOverridden: true, interestOverridden: true });
  });

  it("works for flat-interest loans too (the flat interest stays)", () => {
    const flat = { ...base, interestMethod: "flat", interestAmount: 50 };
    const row = buildLoanSchedule(flat).schedule[0];
    const s = buildLoanSchedule({ ...flat, paymentOverrides: { [row.date]: 1050 } });
    expect(s.schedule[0]).toMatchObject({ payment: 1050, interest: 50, principal: 1000 });
  });

  it("a date that is not a payment date changes nothing", () => {
    const s = buildLoanSchedule({ ...base, paymentOverrides: { "2026-02-16": 5000 } });
    expect(s.schedule).toEqual(plain.schedule);
  });

  it("a manual schedule ignores edited payments", () => {
    const manualSchedule = [{ date: "2026-02-15", payment: 600, interest: 60 }];
    const s = buildLoanSchedule({ ...base, manualSchedule, paymentOverrides: { "2026-02-15": 5000 } });
    expect(s.schedule[0].payment).toBe(600);
  });
});

describe("normalizePaymentOverrides", () => {
  it("rounds to cents and accepts 0", () => {
    expect(normalizePaymentOverrides({ "2026-02-15": 600.456, "2026-03-15": 0 })).toEqual({
      "2026-02-15": 600.46,
      "2026-03-15": 0,
    });
  });
  it("refuses a negative payment or a bad date", () => {
    expect(() => normalizePaymentOverrides({ "2026-02-15": -1 })).toThrow(LoanValidationError);
    expect(() => normalizePaymentOverrides({ "2026-02-30": 1 })).toThrow(/real date/);
    expect(() => normalizePaymentOverrides([1])).toThrow(/Payment overrides/);
  });
});

describe("loanScheduleExtras reads payment_overrides in every row shape", () => {
  const payments = { "2026-02-15": 900 };
  it("Drizzle, raw SQL and JSON-as-text", () => {
    expect(loanScheduleExtras({ paymentOverrides: payments }).paymentOverrides).toEqual(payments);
    expect(loanScheduleExtras({ payment_overrides: payments }).paymentOverrides).toEqual(payments);
    expect(loanScheduleExtras({ payment_overrides: JSON.stringify(payments) }).paymentOverrides).toEqual(payments);
    expect(loanScheduleExtras({}).paymentOverrides).toBeNull();
    expect(loanScheduleExtras({ payment_overrides: [1] }).paymentOverrides).toBeNull();
  });
});

describe("saveLoanSchedule stores edited payments", () => {
  const loanRow = (extra: Record<string, unknown> = {}) => ({
    id: 7,
    userId: "u1",
    principal: base.principal,
    annualRate: base.annualRate,
    termMonths: base.termMonths,
    startDate: base.startDate,
    paymentAmount: null,
    paymentFrequency: "monthly",
    extraPayment: 0,
    residualValue: null,
    interestMethod: "rate",
    interestAmount: null,
    manualSchedule: null,
    interestOverrides: null,
    paymentOverrides: null,
    ...extra,
  });
  beforeEach(() => {
    dbState.loan = loanRow();
    dbState.saved = null;
  });

  it("merges a new payment and returns the recalculated schedule", async () => {
    dbState.loan = loanRow({ paymentOverrides: { [plain.schedule[0].date]: 700 } });
    const date = plain.schedule[3].date;
    const res = await saveLoanSchedule("u1", 7, { paymentOverrides: { [date]: 1500 } });
    expect(dbState.saved?.paymentOverrides).toEqual({ [plain.schedule[0].date]: 700, [date]: 1500 });
    expect(res.paymentOverrides).toEqual(dbState.saved?.paymentOverrides);
    expect(res.summary.schedule[3]).toMatchObject({ payment: 1500, paymentOverridden: true });
  });

  it("a null amount removes one edit; the last one removed stores NULL", async () => {
    const date = plain.schedule[3].date;
    dbState.loan = loanRow({ paymentOverrides: { [date]: 1500 } });
    const res = await saveLoanSchedule("u1", 7, { paymentOverrides: { [date]: null } });
    expect(dbState.saved?.paymentOverrides).toBeNull();
    expect(res.summary.schedule).toEqual(plain.schedule);
  });

  it("keeps interest edits untouched, and clearPaymentOverrides drops only the payments", async () => {
    const d = plain.schedule[1].date;
    dbState.loan = loanRow({ paymentOverrides: { [d]: 900 }, interestOverrides: { [d]: 55 } });
    await saveLoanSchedule("u1", 7, { clearPaymentOverrides: true });
    expect(dbState.saved).toMatchObject({ paymentOverrides: null, interestOverrides: { [d]: 55 } });
  });

  it("refuses an edit on a date that the new payments push past the payoff, naming it", async () => {
    const later = plain.schedule[20].date;
    dbState.loan = loanRow({ paymentOverrides: { [later]: 600 } });
    await expect(
      saveLoanSchedule("u1", 7, { paymentOverrides: { [plain.schedule[2].date]: 20000 } }),
    ).rejects.toThrow(new RegExp(`paid off on ${plain.schedule[2].date}.*${later}`));
    expect(dbState.saved).toBeNull();
  });

  it("refuses a date that is not a payment date", async () => {
    await expect(saveLoanSchedule("u1", 7, { paymentOverrides: { "2026-02-16": 900 } })).rejects.toThrow(
      /not a payment date/,
    );
    expect(dbState.saved).toBeNull();
  });

  it("refuses payment edits on a manual schedule", async () => {
    dbState.loan = loanRow({ manualSchedule: [{ date: "2026-02-15", payment: 600, interest: 60 }] });
    await expect(saveLoanSchedule("u1", 7, { paymentOverrides: { "2026-02-15": 900 } })).rejects.toThrow(
      /manual schedule/,
    );
  });

  it("switching to a manual schedule drops the edited payments", async () => {
    dbState.loan = loanRow({ paymentOverrides: { [plain.schedule[0].date]: 700 } });
    await saveLoanSchedule("u1", 7, { manualSchedule: [{ date: "2026-02-15", payment: 600, interest: 60 }] });
    expect(dbState.saved?.paymentOverrides).toBeNull();
  });

  it("readLoanSchedule returns them and applies them", async () => {
    const d = plain.schedule[0].date;
    dbState.loan = loanRow({ paymentOverrides: { [d]: 0 } });
    const res = await readLoanSchedule("u1", 7);
    expect(res.paymentOverrides).toEqual({ [d]: 0 });
    expect(res.summary.schedule[0]).toMatchObject({ payment: 0, balance: 12060 });
  });
});

describe("wiring", () => {
  it("the migration and schema-pg.ts declare the column", () => {
    expect(read("scripts/migrations/20261109b_loans_payment_overrides.sql")).toContain(
      "ADD COLUMN IF NOT EXISTS payment_overrides JSONB",
    );
    expect(read("src/db/schema-pg.ts")).toContain('jsonb("payment_overrides")');
  });

  it("REST accepts the change and MCP exposes set_payment through saveLoanSchedule", () => {
    const route = read("src/app/api/loans/schedule/route.ts");
    expect(route).toContain("paymentOverrides:");
    expect(route).toContain("clearPaymentOverrides:");
    const mcp = read("mcp-server/tools/loans.ts");
    expect(mcp).toContain('z.literal("set_payment")');
    expect(mcp).toContain("clearPaymentOverrides: true");
  });

  it("the loans list and the panel's amortization read both select the column", () => {
    const loans = read("src/app/api/loans/route.ts");
    expect(loans.match(/paymentOverrides: schema\.loans\.paymentOverrides/g)?.length).toBe(2);
  });
});
