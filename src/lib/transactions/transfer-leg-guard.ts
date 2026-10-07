/**
 * Which money-moving fields a generic `PUT /api/transactions` patch would
 * change on one leg of a transfer pair. Pure.
 *
 * A transfer is two rows sharing a `link_id`: money leaves one account and
 * arrives in the other. Rewriting ONE leg's amount, account, date or currency
 * through the generic route leaves its partner as it was, so the pair no
 * longer agrees (money appears in one account and not the other). The web
 * edits transfers through `PUT /api/transactions/transfer`, which rewrites
 * both legs atomically, but the mobile app's generic Edit saved a single leg
 * here (found in review, 2026-10-07). The route refuses a patch that changes
 * any of these fields; note, tags, payee and category are fine to edit alone.
 *
 * Only fields the patch actually CHANGES count, so a client that resends the
 * whole form after editing just the note isn't refused.
 */
export type TransferLegSnapshot = {
  amount: number;
  accountId: number | null;
  date: string;
  currency: string | null;
  enteredAmount: number | null;
  enteredCurrency: string | null;
};

export type TransferLegPatch = Partial<{
  amount: number;
  accountId: number | null;
  date: string;
  currency: string;
  enteredAmount: number | null;
  enteredCurrency: string | null;
}>;

const moneyChanged = (a: number | null | undefined, b: number | null | undefined) =>
  (a == null) !== (b == null) || (a != null && b != null && Math.abs(a - b) >= 0.005);
const codeChanged = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").toUpperCase() !== (b ?? "").toUpperCase();

/** Names of the guarded fields the patch would change; empty when it's safe. */
export function transferLegChanges(existing: TransferLegSnapshot, patch: TransferLegPatch): string[] {
  const changed: string[] = [];
  if (patch.amount !== undefined && moneyChanged(patch.amount, existing.amount)) changed.push("amount");
  if (patch.accountId !== undefined && patch.accountId !== existing.accountId) changed.push("account");
  if (patch.date !== undefined && patch.date !== existing.date) changed.push("date");
  if (patch.currency !== undefined && codeChanged(patch.currency, existing.currency)) changed.push("currency");
  if (patch.enteredAmount !== undefined && moneyChanged(patch.enteredAmount, existing.enteredAmount)) {
    changed.push("entered amount");
  }
  if (patch.enteredCurrency !== undefined && codeChanged(patch.enteredCurrency, existing.enteredCurrency)) {
    changed.push("entered currency");
  }
  return changed;
}
