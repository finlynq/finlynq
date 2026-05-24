/**
 * FX Conversion classification — lot-engine integration.
 *
 * An FX Conversion is a same-account move between two different cash
 * sleeves (e.g., $1,755 CAD → $1,300 USD inside one Brokerage account).
 * It's recorded as a `link_id`-paired pair of rows, both targeting cash
 * sleeves (`portfolio_holdings.is_cash = TRUE`), with an optional third
 * row for an FX fee on a user-selected sleeve.
 *
 * Phase 5c (2026-05-26) — cash sleeves now carry per-inflow lots so the
 * realized-gain aggregator can compute currency-on-currency FX gains over
 * time. An FX conversion now:
 *   - source leg (qty<0): FIFO-closes cash lots on the source sleeve with
 *     `closeKind='fx_conversion'`. Each closure's per-share cost = 1 and
 *     proceeds = 1 in the source currency, so the in-currency realized
 *     gain is 0; the USD / base-currency gain comes from the difference
 *     between the lot's FX rate at open and the closure's FX rate at close
 *     (filled in by `augmentWithBaseCurrency()`).
 *   - dest leg (qty>0): opens a fresh cash lot on the dest sleeve at qty
 *     units, cost-per-share = 1 in the dest currency.
 *
 * Classifier:
 *   - `isFxConversionPair(...)`  — classifier predicate (unchanged)
 *   - `fxConversionHook(...)`    — replaced by `applyLotEffectsForLinkPair`
 *                                  invoking cashHooks directly; kept here
 *                                  as a deprecated shim with a structured
 *                                  warning if same-currency.
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
 * Sanity check for an FX-conversion link_id pair. Logs a structured
 * warning if both legs share a currency (typically a user mistake; the
 * form should have routed this through a different operation).
 *
 * Phase 5c (2026-05-26): cash-lot writes now happen in
 * `applyLotEffectsForLinkPair` via `openCashLotHook` / `closeCashLotsHook`.
 * This function is a no-op classifier shim retained for the dispatcher
 * to record "FX pair recognized" alongside the new lot writes.
 */
export function fxConversionHook(
  sourceTx: TxRowForLots,
  destTx: TxRowForLots,
  source: FxLegInfo,
  dest: FxLegInfo,
): { noLotEffects: false; warning?: string } {
  let warning: string | undefined;
  if (source.currency === dest.currency) {
    warning =
      `FX conversion pair with matching currencies (${source.currency}) — ` +
      `source tx=${sourceTx.id}, dest tx=${destTx.id}. Likely a recording mistake.`;
  }
  return { noLotEffects: false, warning };
}
