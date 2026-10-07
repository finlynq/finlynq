import { looksEncrypted, resolveTransferPair } from "../lib/transfer-pair";
import type { LinkedTransaction, Transaction } from "../../../shared/types";

const LINK = "5b0c6a3e-1f2d-4c3b-9a8e-7d6f5e4c3b2a";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 10,
    date: "2026-09-14",
    accountId: 1,
    categoryId: 5,
    currency: "USD",
    amount: -100,
    quantity: null,
    portfolioHolding: null,
    note: "Savings top-up",
    payee: "Transfer to Euro Savings",
    tags: "",
    isBusiness: 0,
    splitPerson: null,
    splitRatio: null,
    importHash: null,
    fitId: null,
    linkId: LINK,
    kind: "transfer",
    ...overrides,
  };
}

function sibling(overrides: Partial<LinkedTransaction> = {}): LinkedTransaction {
  return {
    id: 11,
    date: "2026-09-14",
    accountId: 2,
    categoryId: 5,
    currency: "EUR",
    amount: 91.37,
    quantity: null,
    portfolioHoldingId: null,
    note: "Savings top-up",
    linkId: LINK,
    ...overrides,
  };
}

describe("resolveTransferPair", () => {
  it("reads From from the negative leg and To from the positive one", () => {
    expect(resolveTransferPair(tx(), [sibling()])).toEqual({
      transactionId: 10,
      fromAccountId: 1,
      toAccountId: 2,
      fromCurrency: "USD",
      toCurrency: "EUR",
      enteredAmount: 100,
      receivedAmount: 91.37,
      date: "2026-09-14",
      note: "Savings top-up",
    });
  });

  it("orients the same way when the destination leg was the one opened", () => {
    const opened = tx({ id: 11, accountId: 2, currency: "EUR", amount: 91.37 });
    const partner = sibling({ id: 10, accountId: 1, currency: "USD", amount: -100 });
    expect(resolveTransferPair(opened, [partner])).toMatchObject({
      transactionId: 11,
      fromAccountId: 1,
      toAccountId: 2,
      fromCurrency: "USD",
      toCurrency: "EUR",
      enteredAmount: 100,
      receivedAmount: 91.37,
    });
  });

  it("is not a pair without a linkId, or with zero or several siblings", () => {
    expect(resolveTransferPair(tx({ linkId: null }), [sibling()])).toBeNull();
    expect(resolveTransferPair(tx(), [])).toBeNull();
    expect(resolveTransferPair(tx(), [sibling(), sibling({ id: 12 })])).toBeNull();
  });

  it("is not a pair when both legs sit in one account or share a sign", () => {
    expect(resolveTransferPair(tx(), [sibling({ accountId: 1 })])).toBeNull();
    expect(resolveTransferPair(tx(), [sibling({ accountId: null })])).toBeNull();
    expect(resolveTransferPair(tx(), [sibling({ amount: -91.37 })])).toBeNull();
  });

  it("leaves portfolio operations to the portfolio form", () => {
    expect(resolveTransferPair(tx({ kind: "brokerage_deposit_out" }), [sibling()])).toBeNull();
    expect(resolveTransferPair(tx(), [sibling({ portfolioHoldingId: 7 })])).toBeNull();
    expect(resolveTransferPair(tx(), [sibling({ quantity: 3 })])).toBeNull();
  });

  it("only uses a note it can read", () => {
    // The partner's note is the one the server wrote on both legs.
    expect(resolveTransferPair(tx({ note: "" }), [sibling({ note: "From partner" })])?.note).toBe("From partner");
    expect(resolveTransferPair(tx({ note: "" }), [sibling({ note: "" })])?.note).toBe("");
    // Cold DEK: encrypted on the partner, nothing readable → unknown (null).
    expect(resolveTransferPair(tx({ note: "" }), [sibling({ note: "v1:abc:def" })])?.note).toBeNull();
    expect(resolveTransferPair(tx({ note: "Mine" }), [sibling({ note: "v1:abc:def" })])?.note).toBe("Mine");
  });

  it("recognises envelope ciphertext", () => {
    expect(looksEncrypted("v1:aaa:bbb")).toBe(true);
    expect(looksEncrypted("sv1:aaa")).toBe(true);
    expect(looksEncrypted("v1 rent")).toBe(false);
    expect(looksEncrypted(null)).toBe(false);
  });
});
