// Transfer-pair detection for editing. A transfer is two legs sharing a
// `link_id`; editing one leg through the generic PUT /api/transactions would
// leave the other behind, so a transfer is edited as a PAIR through
// PUT /api/transactions/transfer. Mirrors the web's rule
// (transactions-workspace.tsx `startEdit`): the row has a linkId, exactly ONE
// sibling shares it, and the two legs sit in DIFFERENT accounts. Anything else
// (orphaned leg, multi-leg imports, same-account conversions) keeps the
// generic single-row edit. Pure, so it is unit-testable.
import type { LinkedTransaction, Transaction } from "../../../shared/types";
import { isPortfolioRow } from "./portfolio/edit-routing";

/** Everything the transfer form needs to edit a pair (AddTransaction route param). */
export interface TransferEditSeed {
  /** The leg that was opened; either leg id identifies the pair on PUT. */
  transactionId: number;
  fromAccountId: number;
  toAccountId: number;
  fromCurrency: string;
  toCurrency: string;
  /** What left the From account (|source leg amount|), From currency. */
  enteredAmount: number;
  /** What arrived in the To account (destination leg amount), To currency. */
  receivedAmount: number;
  date: string;
  /** The pair's note; null when it only came back encrypted (cold DEK), so the
   *  form must not send it back unless the user types a new one. */
  note: string | null;
}

/** Envelope-encrypted value served as-is because the DEK was cold. */
export function looksEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && /^s?v1:/.test(value);
}

/** The pair's note: the first readable non-empty one; null if only ciphertext. */
function pairNote(notes: Array<string | null | undefined>): string | null {
  const readable = notes.filter((n) => !looksEncrypted(n));
  const filled = readable.find((n) => !!n && n.trim().length > 0);
  if (filled) return filled as string;
  return readable.length === notes.length ? "" : null;
}

/**
 * The transfer pair `tx` belongs to, or null when it should keep the generic
 * edit. `siblings` = GET /api/transactions/linked?linkId=…&excludeId=tx.id.
 */
export function resolveTransferPair(tx: Transaction, siblings: LinkedTransaction[]): TransferEditSeed | null {
  if (!tx.linkId || siblings.length !== 1) return null;
  const partner = siblings[0];
  if (tx.accountId == null || partner.accountId == null || tx.accountId === partner.accountId) return null;
  // Portfolio operations pair their legs too, but are edited as portfolio ops.
  if (isPortfolioRow(tx) || isPortfolioRow(partner)) return null;
  // The negative leg is the source. Two legs with the same sign aren't a transfer.
  if ((tx.amount < 0) === (partner.amount < 0)) return null;

  const txIsSource = tx.amount < 0;
  const source = txIsSource
    ? { accountId: tx.accountId, currency: tx.currency, amount: tx.amount, note: tx.note }
    : { accountId: partner.accountId, currency: partner.currency, amount: partner.amount, note: partner.note };
  const dest = txIsSource
    ? { accountId: partner.accountId, currency: partner.currency, amount: partner.amount, note: partner.note }
    : { accountId: tx.accountId, currency: tx.currency, amount: tx.amount, note: tx.note };

  return {
    transactionId: tx.id,
    fromAccountId: source.accountId,
    toAccountId: dest.accountId,
    fromCurrency: source.currency,
    toCurrency: dest.currency,
    enteredAmount: Math.abs(source.amount),
    receivedAmount: Math.abs(dest.amount),
    date: txIsSource ? tx.date : partner.date,
    note: pairNote([source.note, dest.note]),
  };
}
