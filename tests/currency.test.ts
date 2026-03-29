import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatNumber,
  formatDate,
  getCurrentMonth,
  getMonthLabel,
} from "@/lib/currency";

describe("formatCurrency", () => {
  it("formats positive CAD amount", () => {
    const result = formatCurrency(1234.56, "CAD");
    expect(result).toContain("1,234.56");
  });

  it("formats negative amount", () => {
    const result = formatCurrency(-500.1, "CAD");
    expect(result).toContain("500.10");
  });

  it("defaults to CAD", () => {
    const result = formatCurrency(100);
    expect(result).toContain("100.00");
  });

  it("formats USD", () => {
    const result = formatCurrency(99.9, "USD");
    expect(result).toContain("99.90");
  });

  it("handles zero", () => {
    const result = formatCurrency(0, "CAD");
    expect(result).toContain("0.00");
  });
});

describe("formatNumber", () => {
  it("formats with 2 decimal places", () => {
    expect(formatNumber(1234.5)).toBe("1,234.50");
  });

  it("formats zero", () => {
    expect(formatNumber(0)).toBe("0.00");
  });
});

describe("formatDate", () => {
  it("formats a date string", () => {
    const result = formatDate("2024-03-15");
    expect(result).toContain("2024");
    expect(result).toContain("15");
  });
});

describe("getCurrentMonth", () => {
  it("returns YYYY-MM format", () => {
    const result = getCurrentMonth();
    expect(result).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("getMonthLabel", () => {
  it("returns human-readable month label", () => {
    const result = getMonthLabel("2024-03");
    expect(result).toContain("2024");
  });
});
