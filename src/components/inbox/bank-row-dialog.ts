/**
 * Booking a bank row through the TransactionDialog: what the dialog opens
 * with, and which saved transaction gets linked back to the row. Shared by the
 * three inbox tabs that do this (Reconcile, To approve, To categorize).
 *
 * Both dialog tabs are filled from the row (2026-11-07, owner report). The
 * Transfer tab used to open on today's date with no amount and no accounts in
 * To approve / To categorize, and Reconcile always put the row's account in
 * From. The row's account now goes on the side the money moved through: From
 * for money leaving it (negative amount), To for money arriving (positive, e.g.
 * a card payment). The amount is entered positive, as the Transfer tab expects.
 *
 * A transfer has two legs and a bank row links to the leg on ITS OWN account
 * (reconcile links are same-account only, FINLYNQ-211). The tabs used to link
 * the From leg every time, which the server refuses for money arriving, so the
 * transfer was saved and the row stayed where it was.
 */

import type {
  TransactionDialogInitialState,
  TransactionSavedContext,
} from "@/components/transactions/transaction-dialog";

export interface DialogBankRow {
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  payee?: string | null;
  suggestedCategoryId?: number | null;
}

/**
 * The dialog's opening state for a bank row. `transferAccountId` is the
 * account on the other side of the transfer (a matched `create_transfer` rule);
 * passing it opens the dialog on the Transfer tab.
 */
export function bankRowDialogState(
  row: DialogBankRow,
  opts: { transferAccountId?: number } = {},
): TransactionDialogInitialState {
  const rowAccount = String(row.accountId);
  const other = opts.transferAccountId != null ? String(opts.transferAccountId) : undefined;
  const moneyLeaves = row.amount < 0;
  return {
    kind: "transaction-prefill",
    values: {
      accountId: rowAccount,
      categoryId: row.suggestedCategoryId != null ? String(row.suggestedCategoryId) : "",
      date: row.date,
      currency: row.currency,
      amount: String(row.amount),
      payee: row.payee ?? "",
    },
    transferSeed: {
      fromAccountId: moneyLeaves ? rowAccount : other,
      toAccountId: moneyLeaves ? other : rowAccount,
      date: row.date,
      amount: String(Math.abs(row.amount)),
      note: row.payee ?? "",
      openInTransfer: other != null,
    },
  };
}

/**
 * The transaction to link to the bank row after the dialog saved: the saved
 * transaction itself, or for a new transfer the leg on the row's account.
 * Null when the transfer was booked between two other accounts.
 */
export function bankRowLinkTransactionId(
  savedTxId: number,
  ctx: TransactionSavedContext,
  bankAccountId: number,
): number | null {
  if (!ctx.isTransfer || !ctx.legs) return savedTxId;
  if (ctx.legs.fromAccountId === bankAccountId) return ctx.legs.fromTxId;
  if (ctx.legs.toAccountId === bankAccountId) return ctx.legs.toTxId;
  return null;
}

/**
 * Primary-links what the dialog saved to the bank row, so the row leaves its
 * tab. Returns a message for the user when the row could not be linked (the
 * save itself already went through), else null.
 */
export async function linkSavedToBankRow(
  bank: { id: string; accountId: number },
  savedTxId: number,
  ctx: TransactionSavedContext,
): Promise<string | null> {
  const transactionId = bankRowLinkTransactionId(savedTxId, ctx, bank.accountId);
  if (transactionId == null) {
    return "The transfer was saved, but neither side of it is this row's account, so the row is still waiting to be booked.";
  }
  try {
    const res = await fetch("/api/reconcile/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId,
        bankTransactionId: bank.id,
        linkType: "primary",
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return `Saved, but the row could not be linked to it: ${body.error ?? `HTTP ${res.status}`}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
