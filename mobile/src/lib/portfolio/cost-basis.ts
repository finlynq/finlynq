// Cost-basis method: the wording shared by the Portfolio note and the Cost
// basis screen. Mirrors the web's `components/portfolio/cost-basis-method.tsx`;
// keep the two in sync.
//
// Lots are recorded for everyone on every trade either way. The setting only
// decides which figures are shown, so switching never changes a transaction.

export interface CostBasisMethod {
  /** The server's flag: false = simple average, true = lot allocation. */
  enabled: boolean;
  name: string;
  summary: string;
}

export const COST_BASIS_METHODS: readonly CostBasisMethod[] = [
  {
    enabled: false,
    name: "Simple",
    summary: "The average price of every purchase, times the shares you hold.",
  },
  {
    enabled: true,
    name: "Advanced lot allocation",
    summary: "Each sale is matched to specific purchases: first in, first out.",
  },
];

/** The method in a sentence: "Cost basis: simple average". */
export function costBasisNoteLabel(enabled: boolean): string {
  return enabled ? "advanced lot allocation" : "simple average";
}

/** What to say after a switch. `rebuilt` = positions whose lots were just built. */
export function costBasisSavedNote(enabled: boolean, rebuilt?: number): string {
  if (!enabled) return "Back to the simple method. Your lots are kept.";
  const built = rebuilt
    ? ` Lots were built for ${rebuilt} position${rebuilt === 1 ? "" : "s"} that had none.`
    : "";
  return `Advanced lot allocation is on.${built}`;
}

/**
 * A warning for positions whose lots do not add up to the shares held, or null
 * when there is nothing to warn about. Only relevant while lots are in use.
 */
export function costBasisMismatchNote(enabled: boolean, mismatched: number): string | null {
  if (!enabled || !(mismatched > 0)) return null;
  const one = mismatched === 1;
  return (
    `${mismatched} position${one ? " has" : "s have"} lots that do not add up to the shares you hold, ` +
    `so ${one ? "its" : "their"} cost basis may be off. Open ${one ? "it" : "them"} in the Lot inspector ` +
    "on the web app and choose Rebuild lots."
  );
}

/** One worked example, the same numbers the web shows. */
export const COST_BASIS_EXAMPLE = {
  setup: "Buy 100 at 10, buy 100 at 20, sell 100, then buy 100 at 30. You hold 200 shares.",
  rows: [
    { method: "Simple", value: "4,000", why: "average of all three purchases (20) × 200" },
    {
      method: "Advanced lot allocation",
      value: "5,000",
      why: "the sale used the first lot; 100 at 20 and 100 at 30 remain",
    },
  ],
} as const;

export const COST_BASIS_SIMPLE_TEXT =
  "Cost basis is the average price of every purchase you ever made in a holding, multiplied by the " +
  "shares you still hold. It is easy to follow, but shares you have already sold stay in that average, " +
  "so the figure drifts from your broker once you sell part of a position and buy again.";

export const COST_BASIS_ADVANCED_TEXT =
  "Every purchase is kept as its own lot, and each sale is matched to specific lots: first in, first " +
  "out, unless you change it. Cost basis and unrealized gain then come only from the shares you still " +
  "hold, and the realized gain on each sale follows the lots it used. You can change which lots a sale " +
  "used from the Lot inspector on the web app.";

export const COST_BASIS_SWITCH_TEXT =
  "Switching never changes a transaction. Your lots are recorded either way, so you can switch back at " +
  "any time and any matching you chose is kept.";
