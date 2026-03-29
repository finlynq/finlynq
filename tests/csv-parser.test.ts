import { describe, it, expect } from "vitest";
import { parseCSV, csvToRawTransactions, parseAmount, normalizeDate } from "@/lib/csv-parser";

describe("parseCSV", () => {
  it("parses a simple CSV into records", () => {
    const csv = `Name,Age,City
Alice,30,Toronto
Bob,25,Vancouver`;
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Name: "Alice", Age: "30", City: "Toronto" });
    expect(rows[1]).toEqual({ Name: "Bob", Age: "25", City: "Vancouver" });
  });

  it("trims whitespace from headers and values", () => {
    const csv = ` Name , Age
 Alice , 30 `;
    const rows = parseCSV(csv);
    expect(rows[0]).toEqual({ Name: "Alice", Age: "30" });
  });

  it("returns empty array for header-only CSV", () => {
    const csv = `Name,Age`;
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(0);
  });

  it("handles missing values with empty string", () => {
    const csv = `A,B,C
1,2`;
    const rows = parseCSV(csv);
    expect(rows[0]).toEqual({ A: "1", B: "2", C: "" });
  });

  it("returns empty array for empty input", () => {
    expect(parseCSV("")).toHaveLength(0);
    expect(parseCSV("   ")).toHaveLength(0);
  });

  it("strips UTF-8 BOM", () => {
    const csv = `\uFEFFName,Age\nAlice,30`;
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ Name: "Alice", Age: "30" });
  });

  it("handles quoted fields with commas", () => {
    const csv = `Name,Note\nAlice,"has a comma, here"\nBob,simple`;
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].Note).toBe("has a comma, here");
    expect(rows[1].Note).toBe("simple");
  });

  it("handles mixed line endings", () => {
    const csv = "Name,Age\r\nAlice,30\rBob,25\nCarol,28";
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(3);
  });
});

describe("csvToRawTransactions", () => {
  it("maps CSV columns to RawTransaction fields", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags,Quantity,Portfolio holding
2024-01-15,Checking,100.50,Employer,Income,CAD,Salary,,, `;
    const { rows } = csvToRawTransactions(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2024-01-15",
      account: "Checking",
      amount: 100.50,
      payee: "Employer",
      category: "Income",
      currency: "CAD",
      note: "Salary",
      tags: "",
    });
  });

  it("defaults currency to CAD when Currency column is absent", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Note,Tags
2024-01-15,Checking,50,Store,,,`;
    const { rows } = csvToRawTransactions(csv);
    expect(rows[0].currency).toBe("CAD");
  });

  it("puts non-numeric amounts into errors", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags
2024-01-15,Checking,abc,Store,,,, `;
    const { rows, errors } = csvToRawTransactions(csv);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Invalid amount");
  });

  it("parses negative amounts correctly", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags
2024-01-15,Checking,-42.99,Store,Food,CAD,,`;
    const { rows } = csvToRawTransactions(csv);
    expect(rows[0].amount).toBe(-42.99);
  });

  it("reports errors for invalid dates", () => {
    const csv = `Date,Account,Amount,Payee
not-a-date,Checking,50,Store`;
    const { rows, errors } = csvToRawTransactions(csv);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Invalid date");
  });

  it("returns error for empty file", () => {
    const { rows, errors } = csvToRawTransactions("");
    expect(rows).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("handles currency symbols in amounts", () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,Checking,$1500.00,Employer
2024-01-16,Checking,"($42.99)",Store`;
    const { rows } = csvToRawTransactions(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(1500);
    expect(rows[1].amount).toBe(-42.99);
  });
});

describe("parseAmount", () => {
  it("parses standard amounts", () => {
    expect(parseAmount("100.50")).toBe(100.5);
    expect(parseAmount("-42.99")).toBe(-42.99);
  });

  it("handles currency symbols", () => {
    expect(parseAmount("$1,500.00")).toBe(1500);
    expect(parseAmount("€1.234,56")).toBe(1234.56);
    expect(parseAmount("£100.00")).toBe(100);
  });

  it("handles parenthesized negatives", () => {
    expect(parseAmount("(42.99)")).toBe(-42.99);
    expect(parseAmount("($1,000.00)")).toBe(-1000);
  });

  it("handles unicode minus", () => {
    expect(parseAmount("−42.99")).toBe(-42.99);
  });

  it("returns NaN for non-numeric", () => {
    expect(isNaN(parseAmount("abc"))).toBe(true);
    expect(isNaN(parseAmount(""))).toBe(true);
  });
});

describe("normalizeDate", () => {
  it("handles YYYY-MM-DD", () => {
    expect(normalizeDate("2024-01-15")).toBe("2024-01-15");
  });

  it("handles MM/DD/YYYY", () => {
    expect(normalizeDate("01/15/2024")).toBe("2024-01-15");
  });

  it("handles DD/MM/YYYY when day > 12", () => {
    expect(normalizeDate("25/01/2024")).toBe("2024-01-25");
  });

  it("handles MMM DD, YYYY", () => {
    expect(normalizeDate("Jan 15, 2024")).toBe("2024-01-15");
  });

  it("returns null for invalid dates", () => {
    expect(normalizeDate("not-a-date")).toBeNull();
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate("2024-13-45")).toBeNull();
  });
});
