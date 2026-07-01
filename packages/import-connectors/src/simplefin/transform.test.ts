import { describe, it, expect } from "vitest";
import {
  simplefinToRawTransactions,
  epochToISODate,
  type SimpleFinAccountsResponse,
} from "./transform";

// Faithful to the SimpleFIN /accounts shape (protocol.html): two accounts,
// signed decimal-STRING amounts (outflow negative), epoch `posted`, a
// `pending` row to skip, `payee`/`description`/`memo` variants, a non-fiat
// (URL) currency that must fall back, and one out-of-range amount.
const RESPONSE: SimpleFinAccountsResponse = {
  errors: ["Connection to Bank X is degraded"],
  accounts: [
    {
      org: { name: "Demo Bank", domain: "mybank.com" },
      id: "ACT-checking-1",
      name: "Checking",
      currency: "USD",
      balance: "1234.56",
      "balance-date": 1704067200, // 2024-01-01
      transactions: [
        {
          id: "TX-1",
          posted: 1704153600, // 2024-01-02
          amount: "-33.90",
          description: "COFFEE SHOP",
          payee: "Blue Bottle",
          memo: "card ending 1234",
          mcc: "5812",
        },
        {
          id: "TX-2",
          posted: 1704240000, // 2024-01-03
          amount: "1500.00",
          description: "PAYROLL",
        },
        {
          id: "TX-pending",
          posted: 1704326400,
          amount: "-9.99",
          description: "PENDING CHARGE",
          pending: true,
        },
        {
          id: "TX-huge",
          posted: 1704412800,
          amount: "1e29",
          description: "GARBAGE",
        },
      ],
    },
    {
      id: "ACT-crypto-1",
      name: "Crypto Wallet",
      currency: "https://mysite.com/simplefin/currencies/bitcoin",
      transactions: [
        {
          id: "TX-3",
          posted: 1704153600,
          amount: -0.5,
          description: "buy",
        },
      ],
    },
  ],
};

describe("simplefinToRawTransactions", () => {
  const result = simplefinToRawTransactions(RESPONSE, { defaultCurrency: "USD" });

  it("groups rows per account by external id + name", () => {
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0].externalId).toBe("ACT-checking-1");
    expect(result.accounts[0].name).toBe("Checking");
    expect(result.accounts[1].externalId).toBe("ACT-crypto-1");
  });

  it("skips pending rows and counts them", () => {
    expect(result.skippedPending).toBe(1);
    const ids = result.accounts[0].rows.map((r) => r.fitId);
    expect(ids).not.toContain("TX-pending");
  });

  it("drops out-of-range amounts and surfaces provider errors", () => {
    const ids = result.accounts[0].rows.map((r) => r.fitId);
    expect(ids).not.toContain("TX-huge");
    // provider error + the rejected-row error
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some((e) => e.includes("out of range"))).toBe(true);
  });

  it("maps posted epoch → YYYY-MM-DD, keeps signed amount, sets fitId", () => {
    const tx1 = result.accounts[0].rows.find((r) => r.fitId === "TX-1")!;
    expect(tx1.date).toBe("2024-01-02");
    expect(tx1.amount).toBe(-33.9);
    expect(tx1.fitId).toBe("TX-1");
  });

  it("keeps payee plaintext, preferring payee over description", () => {
    const tx1 = result.accounts[0].rows.find((r) => r.fitId === "TX-1")!;
    expect(tx1.payee).toBe("Blue Bottle");
    // memo differs from payee → carried as note
    expect(tx1.note).toBe("card ending 1234");
    const tx2 = result.accounts[0].rows.find((r) => r.fitId === "TX-2")!;
    expect(tx2.payee).toBe("PAYROLL"); // falls back to description
  });

  it("carries the account currency onto each row", () => {
    const tx1 = result.accounts[0].rows.find((r) => r.fitId === "TX-1")!;
    expect(tx1.currency).toBe("USD");
  });

  it("maps mcc to a rule-matchable tag", () => {
    const tx1 = result.accounts[0].rows.find((r) => r.fitId === "TX-1")!;
    expect(tx1.tags).toBe("mcc:5812");
    const tx2 = result.accounts[0].rows.find((r) => r.fitId === "TX-2")!;
    expect(tx2.tags).toBeUndefined(); // no mcc → no tag
  });

  it("falls back to defaultCurrency for non-ISO (URL) currencies", () => {
    expect(result.accounts[1].currency).toBe("USD");
    expect(result.accounts[1].rows[0].currency).toBe("USD");
    expect(result.accounts[1].rows[0].amount).toBe(-0.5);
  });

  it("parses balance + balance-date", () => {
    expect(result.accounts[0].balance).toBe(1234.56);
    expect(result.accounts[0].balanceDate).toBe("2024-01-01");
    expect(result.accounts[1].balance).toBeNull();
  });

  it("can include pending rows when asked", () => {
    const withPending = simplefinToRawTransactions(RESPONSE, { includePending: true });
    const ids = withPending.accounts[0].rows.map((r) => r.fitId);
    expect(ids).toContain("TX-pending");
    expect(withPending.skippedPending).toBe(0);
  });
});

describe("epochToISODate", () => {
  it("converts epoch seconds to a UTC date", () => {
    expect(epochToISODate(1704153600)).toBe("2024-01-02");
  });
  it("returns empty string for non-positive/non-finite input", () => {
    expect(epochToISODate(0)).toBe("");
    expect(epochToISODate(NaN)).toBe("");
  });
});
