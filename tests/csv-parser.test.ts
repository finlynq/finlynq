import { describe, it, expect } from "vitest";
import { parseCSV, csvToRawTransactions } from "@/lib/csv-parser";

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
});

describe("csvToRawTransactions", () => {
  it("maps CSV columns to RawTransaction fields", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags,Quantity,Portfolio holding
2024-01-15,Checking,100.50,Employer,Income,CAD,Salary,,, `;
    const txns = csvToRawTransactions(csv);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
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
    const txns = csvToRawTransactions(csv);
    expect(txns[0].currency).toBe("CAD");
  });

  it("uses empty string when Currency column is present but empty", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags
2024-01-15,Checking,50,Store,,,, `;
    const txns = csvToRawTransactions(csv);
    // row["Currency"] is "" (empty string), ?? doesn't trigger for ""
    expect(txns[0].currency).toBe("");
  });

  it("parses amount as 0 for non-numeric values", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags
2024-01-15,Checking,abc,Store,,,, `;
    const txns = csvToRawTransactions(csv);
    expect(txns[0].amount).toBe(0);
  });

  it("parses negative amounts correctly", () => {
    const csv = `Date,Account,Amount,Payee,Categorization,Currency,Note,Tags
2024-01-15,Checking,-42.99,Store,Food,CAD,,`;
    const txns = csvToRawTransactions(csv);
    expect(txns[0].amount).toBe(-42.99);
  });
});
