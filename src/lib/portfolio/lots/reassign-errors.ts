/**
 * Wording for a refused lot reassignment. Pure. Shared by the REST route
 * (`/api/portfolio/holdings/[holdingId]/lots/reassign`) and MCP
 * `manage_lots(op:"reassign")`, so both surfaces explain a refusal the same way.
 * `coveredShortMessage` is also used by the whole-ticker `/lots/allocate`
 * route and the allocation matrix.
 */

import type { ReassignError } from "./write-hooks";

export function reassignErrorMessage(err: ReassignError): string {
  switch (err.code) {
    case "close_tx_not_found":
      return "Closure transaction not found for this holding";
    case "no_closures":
      return "That transaction has no lot closures to reassign";
    case "not_reassignable":
      return `Only plain sell closures can be reassigned (this is '${err.closeKind}')`;
    case "qty_mismatch":
      return err.soldShort > 0
        ? `The chosen quantities (${err.got}) must total the sale's ${err.expected} shares, ` +
            `${err.soldShort} of them sold short beyond the shares held (enter those as lot 0)`
        : `The chosen quantities (${err.got}) must total the closure quantity (${err.expected})`;
    case "lot_not_in_scope":
      return `Lot #${err.lotId} is not in this holding/account — reassignment is same-account only`;
    case "lot_bought_after_sale":
      return err.alreadyTaken > 0
        ? `Lot #${err.lotId} was bought on ${err.lotOpenDate}, after this sale on ${err.closeDate}. ` +
            `The sale already takes ${err.alreadyTaken} shares from it (trades entered out of date order), ` +
            `so it can keep up to that many but cannot take more. Rebuilding the lots re-matches it in date order.`
        : `Lot #${err.lotId} was bought on ${err.lotOpenDate}, after this sale on ${err.closeDate}. ` +
            `A sale can only use shares bought on or before its date.`;
    case "short_already_covered":
      return coveredShortMessage(err);
  }
}

/**
 * A sale sold more than was held (opening a short) and a later purchase has
 * already closed some of that short. Re-matching the sale would delete the
 * short together with that purchase's closing of it, which nothing replays,
 * so it is refused. A rebuild replays every trade in date order and gets it
 * right.
 */
export function coveredShortMessage(err: {
  closeTxId?: number;
  shortQty: number;
  coveredQty: number;
}): string {
  const sale = err.closeTxId != null ? `Sale #${err.closeTxId}` : "This sale";
  return (
    `${sale} sold ${err.shortQty} more shares than were held, and a later purchase has already ` +
    `closed ${err.coveredQty} of them. Changing its lots here would undo that, so it isn't allowed. ` +
    `Rebuild the lots for this holding instead: it replays every trade in date order ` +
    `(and resets any lots you matched by hand).`
  );
}
