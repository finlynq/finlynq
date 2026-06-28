import { describe, it, expect } from "vitest";
import { parseGenericCsv, suggestGenericCsvMapping, genericCsvHeaders } from "./index";
import {
  isGenericCsv,
  parseFlexibleDate,
  genericCsvRowsToRawTransactions,
  type GenericCsvMapping,
} from "./transform";

// A faithful slice of the real "full ledger" export: ISO dates, a signed
// amount, an explicit currency column (HKD + CNY), many accounts, single-row
// transfers via account_to, an (OPENING BALANCE) and an (AUDIT) row, and an
// uncategorized row.
const REAL_CSV = `date,amount,currency,account,note,category,account_to
2018-06-13,-5984.59,HKD,CreditCard_04,Opening balance #0001,(OPENING BALANCE),
2018-06-13,-357.96,HKD,CreditCard_04,Game purchase #0002,Gaming,
2018-06-15,-250.00,HKD,CreditCard_04,Transaction #0016,,Wallet_03
2018-06-17,565.00,CNY,BankAccount_02,Other #0029,Other,
2018-07-17,-324.50,HKD,CreditCard_04,Audited row #0183,(AUDIT),
2018-08-22,-0.21,HKD,BankAccount_01,Transaction #0434,,
`;

const FULL_MAPPING: GenericCsvMapping = {
  date: "date",
  amount: "amount",
  currency: "currency",
  account: "account",
  note: "note",
  category: "category",
  accountTo: "account_to",
};

describe("parseFlexibleDate", () => {
  it("parses ISO dates", () => {
    expect(parseFlexibleDate("2018-06-13")).toBe("2018-06-13");
    expect(parseFlexibleDate("2025-09-03T15:04")).toBe("2025-09-03");
  });
  it("parses day-first slash dates and disambiguates", () => {
    expect(parseFlexibleDate("13/06/2018")).toBe("2018-06-13");
    expect(parseFlexibleDate("27/10/2025, 15:04")).toBe("2025-10-27");
  });
  it("honors mdy order", () => {
    expect(parseFlexibleDate("06/13/2018", "mdy")).toBe("2018-06-13");
  });
  it("returns null on garbage", () => {
    expect(parseFlexibleDate("not a date")).toBeNull();
    expect(parseFlexibleDate("13/13/2025")).toBeNull();
  });
});

describe("suggestGenericCsvMapping / isGenericCsv", () => {
  it("auto-maps the canonical header set", () => {
    const headers = genericCsvHeaders(REAL_CSV);
    const { mapping, missingRequired } = suggestGenericCsvMapping(headers);
    expect(missingRequired).toEqual([]);
    expect(mapping).toMatchObject(FULL_MAPPING);
    expect(isGenericCsv(headers)).toBe(true);
  });

  it("tolerates renamed/extra columns via aliases", () => {
    const { mapping, missingRequired } = suggestGenericCsvMapping([
      "Posted Date",
      "Memo",
      "Value",
      "CCY",
      "Account Name",
      "Destination Account",
      "Extra Junk",
    ]);
    expect(missingRequired).toEqual([]);
    expect(mapping.date).toBe("Posted Date");
    expect(mapping.amount).toBe("Value");
    expect(mapping.account).toBe("Account Name");
    expect(mapping.currency).toBe("CCY");
    expect(mapping.note).toBe("Memo");
    expect(mapping.accountTo).toBe("Destination Account");
  });

  it("reports missing required fields instead of throwing", () => {
    const { missingRequired } = suggestGenericCsvMapping(["foo", "bar"]);
    expect(missingRequired.sort()).toEqual(["account", "amount", "date"]);
    expect(isGenericCsv(["foo", "bar"])).toBe(false);
  });
});

describe("parseGenericCsv (real export slice)", () => {
  const { transactions, errors } = parseGenericCsv(REAL_CSV, FULL_MAPPING);

  it("parses cleanly with no errors", () => {
    expect(errors).toEqual([]);
  });

  it("expands 6 rows into 7 transactions (one transfer emits 2 legs)", () => {
    expect(transactions.length).toBe(7);
  });

  it("keeps the signed amount and per-row currency for ordinary rows", () => {
    const gaming = transactions.find((t) => t.payee === "Game purchase #0002");
    expect(gaming).toMatchObject({
      date: "2018-06-13",
      account: "CreditCard_04",
      amount: -357.96,
      category: "Gaming",
      currency: "HKD",
    });
    const other = transactions.find((t) => t.payee === "Other #0029");
    expect(other).toMatchObject({ amount: 565, currency: "CNY", category: "Other" });
  });

  it("expands a single account_to row into two linked legs", () => {
    const legs = transactions.filter((t) => t.linkId === "generic-transfer-3");
    expect(legs.length).toBe(2);
    const source = legs.find((l) => l.amount < 0)!;
    const dest = legs.find((l) => l.amount > 0)!;
    expect(source).toMatchObject({
      account: "CreditCard_04",
      amount: -250,
      category: "Transfer",
      payee: "Transfer to Wallet_03",
    });
    expect(dest).toMatchObject({
      account: "Wallet_03",
      amount: 250,
      category: "Transfer",
      payee: "Transfer from CreditCard_04",
    });
    expect(source.linkId).toBe(dest.linkId);
  });

  it("maps (OPENING BALANCE) → an Opening Balance transaction", () => {
    const opening = transactions.find((t) => t.category === "Opening Balance");
    expect(opening).toMatchObject({
      account: "CreditCard_04",
      amount: -5984.59,
      currency: "HKD",
    });
  });

  it("maps (AUDIT) → an Adjustment transaction", () => {
    const audit = transactions.find((t) => t.category === "Adjustment");
    expect(audit).toMatchObject({ account: "CreditCard_04", amount: -324.5 });
  });

  it("keeps uncategorized non-transfer rows (category undefined)", () => {
    const uncat = transactions.find((t) => t.payee === "Transaction #0434");
    expect(uncat?.category).toBeUndefined();
    expect(uncat?.amount).toBe(-0.21);
  });

  it("stamps the csv source tag on every row", () => {
    expect(transactions.every((t) => t.tags === "source:csv")).toBe(true);
  });
});

// A slice carrying the cross-currency transfer columns: a same-currency
// transfer (amount_received / currency_to empty) and a true FX transfer
// (HKD out → GBP in with an explicit received amount).
const FX_CSV = `date,amount,currency,account,note,category,account_to,amount_received,currency_to
2024-03-26,-5000.00,HKD,BankAccount_01,Transaction #0005,,HSBC_One_HKD,,
2024-03-27,-5000.00,HKD,HSBC_One_HKD,Transaction #0007,,HSBC_One_GBP,502.18,GBP
2024-03-27,-1.00,GBP,HSBC_One_GBP,Travel #0008,Travel: General,,,
`;

const FX_MAPPING: GenericCsvMapping = {
  date: "date",
  amount: "amount",
  currency: "currency",
  account: "account",
  note: "note",
  category: "category",
  accountTo: "account_to",
  amountTo: "amount_received",
  currencyTo: "currency_to",
};

describe("cross-currency (FX) transfers", () => {
  it("auto-maps amount_received / currency_to via aliases", () => {
    const headers = genericCsvHeaders(FX_CSV);
    const { mapping, missingRequired } = suggestGenericCsvMapping(headers);
    expect(missingRequired).toEqual([]);
    expect(mapping.amountTo).toBe("amount_received");
    expect(mapping.currencyTo).toBe("currency_to");
  });

  it("records each FX leg in its own currency (HKD out, GBP in)", () => {
    const { transactions, errors } = parseGenericCsv(FX_CSV, FX_MAPPING);
    expect(errors).toEqual([]);
    const legs = transactions.filter((t) => t.payee.startsWith("Transfer") && t.note === "Transaction #0007");
    expect(legs.length).toBe(2);
    const out = legs.find((l) => l.amount < 0)!;
    const inn = legs.find((l) => l.amount > 0)!;
    expect(out).toMatchObject({ account: "HSBC_One_HKD", amount: -5000, currency: "HKD" });
    expect(inn).toMatchObject({ account: "HSBC_One_GBP", amount: 502.18, currency: "GBP" });
    expect(out.linkId).toBe(inn.linkId);
  });

  it("still mirrors the source amount for a same-currency transfer (no received amount)", () => {
    const { transactions } = parseGenericCsv(FX_CSV, FX_MAPPING);
    const legs = transactions.filter((t) => t.note === "Transaction #0005");
    expect(legs.length).toBe(2);
    const inn = legs.find((l) => l.amount > 0)!;
    expect(inn).toMatchObject({ account: "HSBC_One_HKD", amount: 5000, currency: "HKD" });
  });

  it("rejects an FX transfer whose received amount is out of range", () => {
    const rows = [
      {
        date: "2024-03-27",
        amount: "-5000.00",
        currency: "HKD",
        account: "A",
        note: "x",
        category: "",
        account_to: "B",
        amount_received: "5000000000000", // 5e12 — past the 1e12 sanity bound
        currency_to: "GBP",
      },
    ];
    const { transactions, errors } = genericCsvRowsToRawTransactions(rows, FX_MAPPING);
    expect(transactions).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0].reason).toMatch(/received amount out of range/i);
  });
});

describe("options", () => {
  it("skips opening balances when includeOpeningBalance is false", () => {
    const { transactions } = parseGenericCsv(REAL_CSV, FULL_MAPPING, {
      includeOpeningBalance: false,
    });
    expect(transactions.find((t) => t.category === "Opening Balance")).toBeUndefined();
  });

  it("falls back to defaultCurrency when no currency column is mapped", () => {
    const noCurMapping: GenericCsvMapping = { ...FULL_MAPPING, currency: undefined };
    const rows = [
      { date: "2020-01-01", amount: "-12.50", account: "Cash", note: "Coffee", category: "Food", account_to: "" },
    ];
    const { transactions } = genericCsvRowsToRawTransactions(rows, noCurMapping, {
      defaultCurrency: "EUR",
    });
    expect(transactions[0].currency).toBe("EUR");
  });

  it("supports European decimal-comma amounts", () => {
    const rows = [
      { date: "2020-01-01", amount: "1.234,56", account: "Giro", note: "Salary", category: "Income", account_to: "" },
    ];
    const { transactions } = genericCsvRowsToRawTransactions(rows, FULL_MAPPING, {
      decimalComma: true,
      defaultCurrency: "EUR",
    });
    expect(transactions[0].amount).toBe(1234.56);
  });
});
