import { describe, it, expect } from "vitest";
import { parseMoneyProCsv } from "./index";
import {
  isMoneyProCsv,
  parseMoneyProDate,
  moneyProRowsToRawTransactions,
  MONEY_PRO_HEADERS,
} from "./transform";

// Faithful to the real export (the .numbers we reverse-engineered): unsigned
// "HK$" amounts, sign in `Transaction Type`, single-row Money Transfers, a
// day-first date with time, hierarchical Category, Class = "Personal Daily".
const REAL_CSV = `Date,Amount,Account,Amount received,Account (to),Balance,Category,Description,Transaction Type,Agent,Check #,Class
"3/9/2025, 20:30","HK$0.00","(Credit Card Account A)","","","HK$10,000.00","","","Opening Balance","","",""
"3/9/2025, 20:30","HK$2,131.64","(Credit Card Account A)","","","HK$7,868.36","Entertainment: Travel","Car Rental","Expense","","",""
"27/10/2025, 15:04","HK$2,131.64","(Bank Card Account H)","HK$2,131.64","(Credit Card Account A)","HK$0.00","","Pay off","Money Transfer","","","Personal Daily"
"2/11/2025, 20:31","HK$100.00","(Credit Card Account A)","","","HK$9,900.00","Misc.","LATE CHARGE","Expense","","",""
"2/11/2025, 20:32","HK$45.24","(Credit Card Account A)","","","HK$9,854.76","Misc.","INTEREST","Expense","","",""
"13/11/2025, 01:39","HK$145.24","(Bank Card Account H)","HK$145.24","(Credit Card Account A)","HK$0.00","","Pay off","Money Transfer","","","Personal Daily"
"1/1/2026, 18:58","HK$100.00","(Credit Card Account A)","","","HK$10,100.00","Others","NORMAL WAIVE LATE CHR","Income","","","Personal Daily"
`;

describe("parseMoneyProDate", () => {
  it("parses day-first dates and drops the time", () => {
    expect(parseMoneyProDate("27/10/2025, 15:04")).toBe("2025-10-27");
    expect(parseMoneyProDate("3/9/2025, 20:30")).toBe("2025-09-03");
    expect(parseMoneyProDate("1/1/2026, 18:58")).toBe("2026-01-01");
  });
  it("works without a time component", () => {
    expect(parseMoneyProDate("13/11/2025")).toBe("2025-11-13");
  });
  it("returns null on garbage", () => {
    expect(parseMoneyProDate("not a date")).toBeNull();
    expect(parseMoneyProDate("13/13/2025")).toBeNull();
  });
});

describe("isMoneyProCsv", () => {
  it("detects the Money Pro header signature", () => {
    expect(isMoneyProCsv([...MONEY_PRO_HEADERS])).toBe(true);
  });
  it("rejects a generic bank CSV", () => {
    expect(isMoneyProCsv(["Date", "Description", "Amount", "Balance"])).toBe(false);
  });
});

describe("parseMoneyProCsv (real export)", () => {
  const { transactions, errors } = parseMoneyProCsv(REAL_CSV, {
    defaultCurrency: "HKD",
  });

  it("parses cleanly with no errors", () => {
    expect(errors).toEqual([]);
  });

  it("expands 7 rows into 9 transactions (2 transfers each emit 2 legs)", () => {
    // opening(1) + expense(1) + transfer(2) + expense(1) + expense(1) + transfer(2) + income(1)
    expect(transactions.length).toBe(9);
  });

  it("derives sign from Transaction Type, not the amount string", () => {
    const carRental = transactions.find((t) => t.payee === "Car Rental");
    expect(carRental).toMatchObject({
      date: "2025-09-03",
      account: "Credit Card Account A",
      amount: -2131.64, // Expense → negative
      category: "Entertainment: Travel",
      currency: "HKD",
    });

    const income = transactions.find((t) => t.payee === "NORMAL WAIVE LATE CHR");
    expect(income?.amount).toBe(100); // Income → positive
    expect(income?.category).toBe("Others");
  });

  it("strips HK$ + thousands separators and detects HKD from the symbol", () => {
    const late = transactions.find((t) => t.payee === "LATE CHARGE");
    expect(late?.amount).toBe(-100);
    expect(late?.currency).toBe("HKD");
  });

  it("emits an Opening Balance transaction from the Balance column", () => {
    const opening = transactions.find((t) => t.payee === "Opening Balance");
    expect(opening).toMatchObject({
      date: "2025-09-03",
      account: "Credit Card Account A",
      amount: 10000, // value comes from Balance, not Amount (which is 0)
      currency: "HKD",
    });
  });

  it("expands a single Money Transfer row into two linked legs", () => {
    const legs = transactions.filter((t) => t.linkId === "moneypro-transfer-3");
    expect(legs.length).toBe(2);
    const source = legs.find((l) => l.amount < 0)!;
    const dest = legs.find((l) => l.amount > 0)!;
    expect(source).toMatchObject({
      account: "Bank Card Account H",
      amount: -2131.64,
      category: "Transfer",
      payee: "Transfer to Credit Card Account A",
    });
    expect(dest).toMatchObject({
      account: "Credit Card Account A",
      amount: 2131.64,
      category: "Transfer",
      payee: "Transfer from Bank Card Account H",
    });
    // Both legs share the link id.
    expect(source.linkId).toBe(dest.linkId);
  });

  it("maps Class → tags and stamps the csv source tag", () => {
    const transferLeg = transactions.find((t) => t.linkId === "moneypro-transfer-3")!;
    expect(transferLeg.tags).toContain("Personal Daily");
    expect(transferLeg.tags).toContain("source:csv");
    // Expense row had no Class — still gets the source tag.
    const late = transactions.find((t) => t.payee === "LATE CHARGE")!;
    expect(late.tags).toBe("source:csv");
  });
});

describe("error handling", () => {
  it("reports unknown Transaction Type instead of guessing a sign", () => {
    const csv = `Date,Amount,Account,Amount received,Account (to),Balance,Category,Description,Transaction Type,Agent,Check #,Class
"1/1/2025","HK$50.00","(Cash)","","","HK$50.00","","Mystery","Adjustment","","",""`;
    const { transactions, errors } = parseMoneyProCsv(csv, { defaultCurrency: "HKD" });
    expect(transactions).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0].reason).toMatch(/Unknown Transaction Type "Adjustment"/);
  });

  it("supports European decimal-comma amounts when asked", () => {
    const rows = [
      {
        Date: "5/1/2018",
        Amount: "1.234,56 €",
        Account: "Girokonto",
        "Amount received": "",
        "Account (to)": "",
        Balance: "",
        Category: "Gehalt",
        Description: "Salary",
        "Transaction Type": "Income",
        Agent: "",
        "Check #": "",
        Class: "",
      },
    ];
    const { transactions } = moneyProRowsToRawTransactions(rows, {
      decimalComma: true,
      defaultCurrency: "EUR",
    });
    expect(transactions[0].amount).toBe(1234.56);
    expect(transactions[0].currency).toBe("EUR");
  });
});
