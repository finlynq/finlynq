/**
 * FX Conversion classification — lot-engine integration.
 *
 * An FX Conversion is a same-account move between two different cash
 * sleeves (e.g., $1,755 CAD → $1,300 USD inside one Brokerage account).
 * It's recorded as a `link_id`-paired pair of rows, both targeting cash
 * sleeves (`portfolio_holdings.is_cash = TRUE`), with an optional third
 * row for an FX fee on a user-selected sleeve.
 *
 * The lot engine recognizes this shape and DOES NOT write any holding_lots
 * or holding_lot_closures rows — cash sleeves don't carry tax-lot cost
 * basis. The cash sleeve quantities move via the rows themselves (each
 * leg's `amount` debits or credits its respective sleeve).
 *
 * This module is intentionally tiny — it exists so the write-hook
 * classifier can branch cleanly:
 *   - `isFxConversionPair(...)`  — classifier predicate
 *   - `fxConversionHook(...)`    — explicit no-op acknowledger; we run it
 *                                  for symmetry and to log a structured
 *                                  diagnostic if something looks off
 *                                  (e.g., currencies match on both legs).
 *
 * See plan/portfolio-operations-refactor for the full operation set.
 */

import type { TxRowForLots } from "./types";

export interface FxLegInfo {
  /** is_cash flag on the leg's portfolio holding. */
  isCash: boolean;
  /** Currency code on the leg's portfolio holding. */
  currency: string;
}

/**
 * Classifier predicate. Returns true when BOTH legs are cash sleeves
 * (regardless of whether currencies differ — a CAD→CAD pair would still
 * register as FX shape; in practice the form layer prevents same-currency
 * FX, but the engine doesn't enforce it).
 */
export function isFxConversionPair(
  source: FxLegInfo,
  dest: FxLegInfo,
): boolean {
  return source.isCash && dest.isCash;
}

/**
 * Hook for an FX-conversion link_id pair. No lot row writes — both legs
 * are cash sleeves which don't carry cost basis. We perform a sanity
 * check and log if the two legs share a currency (typically a user
 * mistake; the form should have routed this through a different operation).
 *
 * Returns a structured result so the write-hook dispatcher can record
 * "FX pair recognized, no lot effects" for audit.
 */
export function fxConversionHook(
  sourceTx: TxRowForLots,
  destTx: TxRowForLots,
  source: FxLegInfo,
  dest: FxLegInfo,
): { noLotEffects: true; warning?: string } {
  let warning: string | undefined;
  if (source.currency === dest.currency) {
    warning =
      `FX conversion pair with matching currencies (${source.currency}) — ` +
      `source tx=${sourceTx.id}, dest tx=${destTx.id}. Likely a recording mistake.`;
  }
  return { noLotEffects: true, warning };
}
