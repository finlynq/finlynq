/**
 * Rounding leftovers in a position, treated as zero. Pure and client-safe.
 *
 * Statements quote units to a few decimals while purchases (reinvested income,
 * fractional fund units) carry more, so selling "everything" can leave a few
 * hundred-thousandths of a unit behind, or overshoot by as much. Measured on
 * prod (2026-10-14): six fund positions sat between 0.000013 and 0.000049
 * units, half of them negative, and showed as "-0", flagged Short, with an
 * average cost of -C$8.8M and -100% unrealized. Cash and crypto only carried
 * floating-point noise (below 1e-9).
 *
 * A position is dust when:
 *   - it is floating-point noise (|qty| < 1e-9), or
 *   - it is cash and below half a cent (it rounds to 0.00), or
 *   - it holds fewer than 0.0001 units AND is worth less than 5 cents at its
 *     price. The value test keeps a genuinely small holding of something
 *     expensive (0.00005 BTC, a sliver of BRK.A) from ever being hidden. With
 *     no price the value counts as 0, so the unit test alone decides.
 *
 * Used where the portfolio overview sets each holding's quantity, so every
 * view built on it (All Holdings, Holdings by Account, the totals, mobile)
 * sees a closed position. Realized gains are untouched: they are a flow.
 */

/** Floating-point noise: the lot engine's own dust epsilon. */
export const DUST_NOISE_QTY = 1e-9;
/** Below this many units a position may be a rounding leftover. */
export const DUST_MAX_QTY = 1e-4;
/** …and only if it is worth less than this, in its quote currency. */
export const DUST_MAX_VALUE = 0.05;
/** Cash: half a cent, i.e. it displays as 0.00. */
export const DUST_MAX_CASH = 0.005;

export function isDustQuantity(
  qty: number,
  opts: { price?: number | null; isCash?: boolean } = {},
): boolean {
  if (!Number.isFinite(qty)) return false;
  const units = Math.abs(qty);
  if (units < DUST_NOISE_QTY) return true;
  if (opts.isCash) return units < DUST_MAX_CASH;
  if (units >= DUST_MAX_QTY) return false;
  const price = opts.price != null && Number.isFinite(opts.price) ? Math.abs(opts.price) : 0;
  return units * price < DUST_MAX_VALUE;
}
