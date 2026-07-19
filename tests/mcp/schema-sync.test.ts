import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveReportingCurrency } from "../../mcp-server/reporting-currency";
import { buildLoanSchedule, LoanValidationError } from "@/lib/loan-calculator";

describe("FINLYNQ-132 schema and currency contract", () => {
  it("inherits CHF from settings when subscription currency is omitted", async () => {
    const execute = vi.fn(async () => ({ rows: [{ value: "CHF" }] }));
    const currency = await resolveReportingCurrency({ execute }, "user-1", undefined);

    expect(currency).toBe("CHF");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit subscription/reporting currency authoritative", async () => {
    const execute = vi.fn();
    const currency = await resolveReportingCurrency({ execute }, "user-1", "CHF");

    expect(currency).toBe("CHF");
    expect(execute).not.toHaveBeenCalled();
  });

  it("falls back to CAD only when display currency is unavailable", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const currency = await resolveReportingCurrency({ execute }, "user-1", undefined);

    expect(currency).toBe("CAD");
  });

  it("rejects a loan without term_months or payment_amount", () => {
    expect(() =>
      buildLoanSchedule({
        principal: 18000,
        annualRate: 6.99,
        termMonths: null,
        startDate: "2025-08-01",
        paymentAmount: null,
      }),
    ).toThrow(LoanValidationError);
  });

  it("keeps the authoritative examples aligned with runtime names", () => {
    const doc = readFileSync(resolve(__dirname, "../../docs/mcp-schema-contract.md"), "utf8");

    expect(doc).toContain('"annual_rate": 6.99');
    expect(doc).toContain('"start_date": "2025-08-01"');
    expect(doc).toContain("interest_rate");
    expect(doc).toContain("PUT /api/settings/display-currency");
    expect(doc).toContain("inherits `settings.display_currency`");
  });
});
