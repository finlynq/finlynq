/**
 * Booking a bank row through the transaction dialog (2026-11-07, owner report).
 *
 * In the To categorize / To approve tabs the Transfer tab opened on today's
 * date with no amount and no accounts, because only the Transaction tab was
 * filled. Reconcile filled both but always put the row's account in From, and
 * all three linked the bank row to the From leg, which the server refuses for
 * money arriving (links are same-account only), so an incoming transfer was
 * saved while the row stayed put.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bankRowDialogState,
  bankRowLinkTransactionId,
} from "@/components/inbox/bank-row-dialog";

const card = 25;
const chequing = 7;

const payment = {
  accountId: card,
  date: "2026-10-12",
  amount: 137.35,
  currency: "CAD",
  payee: "Payment",
  suggestedCategoryId: null,
};
const purchase = { ...payment, date: "2026-10-16", amount: -45.04, payee: "Value Village" };

function seedOf(state: ReturnType<typeof bankRowDialogState>) {
  if (state.kind !== "transaction-prefill") throw new Error("expected a prefill");
  return { values: state.values, seed: state.transferSeed! };
}

describe("bankRowDialogState", () => {
  it("fills the Transaction tab from the row", () => {
    const { values } = seedOf(bankRowDialogState({ ...purchase, suggestedCategoryId: 12 }));
    expect(values).toEqual({
      accountId: "25",
      categoryId: "12",
      date: "2026-10-16",
      currency: "CAD",
      amount: "-45.04",
      payee: "Value Village",
    });
  });

  it("puts the row's account in To for money arriving", () => {
    const { seed } = seedOf(bankRowDialogState(payment));
    expect(seed.toAccountId).toBe("25");
    expect(seed.fromAccountId).toBeUndefined();
    expect(seed.date).toBe("2026-10-12");
    expect(seed.amount).toBe("137.35");
    expect(seed.note).toBe("Payment");
  });

  it("puts the row's account in From for money leaving, with a positive amount", () => {
    const { seed } = seedOf(bankRowDialogState(purchase));
    expect(seed.fromAccountId).toBe("25");
    expect(seed.toAccountId).toBeUndefined();
    expect(seed.amount).toBe("45.04");
  });

  it("opens on the Transaction tab unless a transfer account is named", () => {
    expect(seedOf(bankRowDialogState(payment)).seed.openInTransfer).toBe(false);
    expect(seedOf(bankRowDialogState(purchase)).seed.openInTransfer).toBe(false);

    const { seed } = seedOf(bankRowDialogState(purchase, { transferAccountId: chequing }));
    expect(seed.openInTransfer).toBe(true);
    expect(seed.fromAccountId).toBe("25");
    expect(seed.toAccountId).toBe("7");
  });

  it("puts a named transfer account in From for money arriving", () => {
    const { seed } = seedOf(bankRowDialogState(payment, { transferAccountId: chequing }));
    expect(seed.fromAccountId).toBe("7");
    expect(seed.toAccountId).toBe("25");
  });
});

describe("bankRowLinkTransactionId", () => {
  const legs = { fromTxId: 501, toTxId: 502, fromAccountId: chequing, toAccountId: card };

  it("links the saved transaction for a plain save", () => {
    expect(bankRowLinkTransactionId(900, { mode: "create", isTransfer: false }, card)).toBe(900);
  });

  it("links the leg on the row's account", () => {
    const ctx = { mode: "create" as const, isTransfer: true, legs };
    expect(bankRowLinkTransactionId(501, ctx, card)).toBe(502);
    expect(bankRowLinkTransactionId(501, ctx, chequing)).toBe(501);
  });

  it("links nothing when neither leg is on the row's account", () => {
    const ctx = { mode: "create" as const, isTransfer: true, legs };
    expect(bankRowLinkTransactionId(501, ctx, 99)).toBeNull();
  });

  it("falls back to the saved id when the legs are unknown", () => {
    expect(bankRowLinkTransactionId(501, { mode: "create", isTransfer: true }, card)).toBe(501);
  });
});

/** Strip comments so a rule quoted in prose can't satisfy a code assertion. */
function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("wiring", () => {
  const tabs = [
    "src/components/inbox/inbox-reconcile-tab.tsx",
    "src/components/inbox/inbox-to-approve-tab.tsx",
    "src/components/inbox/inbox-to-categorize-tab.tsx",
  ];

  it.each(tabs)("%s opens and links through the shared helper", (path) => {
    const code = source(path);
    expect(code).toMatch(/setDialogInitial\(\s*bankRowDialogState\(snap/);
    expect(code).toMatch(/linkSavedToBankRow\(materializeBank, txId, ctx\)/);
    // No hand-built prefill or link POST left behind.
    expect(code).not.toMatch(/kind: "transaction-prefill"/);
    expect(code).not.toMatch(/transactionId: txId/);
  });

  it("the dialog reports both legs and opens on Transfer only when asked", () => {
    const code = source("src/components/transactions/transaction-dialog.tsx");
    expect(code).toMatch(/if \(seed\.openInTransfer\)/);
    expect(code).not.toMatch(/if \(seed\.toAccountId\)/);
    expect(code).toMatch(/toTxId: created\.toTransactionId/);
  });
});
