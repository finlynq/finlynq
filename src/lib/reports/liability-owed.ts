/**
 * How much a liability account's balance means is OWED (GH #433).
 *
 * Liability balances are stored negative when money is owed. A card that was
 * overpaid has a POSITIVE balance: it is in credit, and that credit reduces
 * what is owed. `Math.abs(balance)` turned that credit into debt, so a $6.16
 * credit was counted as $6.16 owed and the Balance Sheet total and net worth
 * were off by twice the credit.
 *
 * Owed is positive, a credit is negative. Never returns -0.
 */
export function liabilityOwed(balance: number): number {
  const owed = -balance;
  return owed === 0 ? 0 : owed;
}
