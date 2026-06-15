/**
 * Oversell guard (FINLYNQ-162) — pure helpers for the web sell-form
 * confirmation when a sell quantity exceeds the current long position.
 *
 * Short positions are a SUPPORTED feature (`holding_lots.side`): selling more
 * than held opens a short. These helpers DO NOT block — they only let the UI
 * surface an advisory "this will open a short of N units" confirmation. No
 * business logic lives here; the canonical sign-correct rows still come from
 * `src/lib/portfolio/operations.ts`.
 */

/** True when `sellQty` exceeds the available long position `heldQty`. */
export function isOversell(sellQty: number, heldQty: number): boolean {
  if (!Number.isFinite(sellQty) || !Number.isFinite(heldQty)) return false;
  if (sellQty <= 0) return false;
  // A position at or below zero (flat / already short) is not the "selling more
  // than you hold" case this guard targets — only warn when there is long
  // inventory being exceeded.
  if (heldQty <= 0) return false;
  return sellQty > heldQty;
}

/**
 * Units of NEW short exposure a sell would open: the amount of the sell that
 * exceeds the long position. Returns 0 when the sell is within the position.
 */
export function shortAmount(sellQty: number, heldQty: number): number {
  if (!isOversell(sellQty, heldQty)) return 0;
  return sellQty - heldQty;
}
