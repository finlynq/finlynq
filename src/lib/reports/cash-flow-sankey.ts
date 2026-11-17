/**
 * The cash flow diagram's columns (Reports → Cash Flow), worked out once so the
 * chart only draws them.
 *
 * Three columns: every income source flows into ONE income pool in the middle,
 * and the pool flows out to each expense category. What is left over is a
 * "Surplus" node on the right; a period that spent more than it earned gets a
 * "Deficit" node on the left, so both sides always add up to the pool.
 *
 * Small items are folded into "Other income" / "Other spending" so the labels
 * stay readable, and the folded amount still counts: before this the chart
 * kept only the 10 largest expense categories and dropped the rest, which made
 * the leftover look bigger than it was.
 */

export type CashFlowItem = { name: string; value: number };

export type CashFlowNodeKind = "income" | "expense" | "other" | "surplus" | "deficit";

export type CashFlowNode = CashFlowItem & { kind: CashFlowNodeKind };

export type CashFlowColumns = {
  /** Left column: income sources, then "Deficit" when spending exceeded income. */
  sources: CashFlowNode[];
  /** Right column: expense categories, then "Surplus" when income exceeded spending. */
  uses: CashFlowNode[];
  totalIncome: number;
  totalExpenses: number;
  /** The middle node: max(totalIncome, totalExpenses). Both side columns add up to it. */
  pool: number;
  surplus: number;
  deficit: number;
};

export const SURPLUS_LABEL = "Surplus";
export const DEFICIT_LABEL = "Deficit";
export const OTHER_INCOME_LABEL = "Other income";
export const OTHER_SPENDING_LABEL = "Other spending";

/** Below this share of the pool an item is folded into "Other", however few items there are. */
export const MIN_SHARE = 0.01;

/**
 * Largest first, positive values only. More than `maxItems` items, or items
 * under `minShare` of `pool`, are folded into one `otherLabel` node.
 */
export function foldSmallItems(
  items: CashFlowItem[],
  { maxItems, pool, otherLabel, kind }: { maxItems: number; pool: number; otherLabel: string; kind: "income" | "expense" },
): CashFlowNode[] {
  const sorted = items.filter((i) => Number.isFinite(i.value) && i.value > 0).sort((a, b) => b.value - a.value);
  const big = sorted.filter((i) => !(pool > 0 && i.value / pool < MIN_SHARE));
  const small = sorted.slice(big.length); // sorted descending, so the small ones are the tail

  let keep = big;
  let rest = small;
  if (big.length + (small.length > 0 ? 1 : 0) > maxItems) {
    keep = big.slice(0, maxItems - 1);
    rest = sorted.slice(keep.length);
  }
  const nodes: CashFlowNode[] = keep.map((i) => ({ ...i, kind }));
  if (rest.length === 1) {
    // One leftover item isn't worth an "Other" node: show it by name.
    nodes.push({ ...rest[0], kind });
  } else if (rest.length > 1) {
    nodes.push({ name: otherLabel, value: rest.reduce((s, i) => s + i.value, 0), kind: "other" });
  }
  return nodes;
}

export function buildCashFlowColumns(
  income: CashFlowItem[],
  expenses: CashFlowItem[],
  { maxSources = 7, maxUses = 10 }: { maxSources?: number; maxUses?: number } = {},
): CashFlowColumns {
  const sum = (xs: CashFlowItem[]) => xs.reduce((s, x) => s + (Number.isFinite(x.value) && x.value > 0 ? x.value : 0), 0);
  const totalIncome = sum(income);
  const totalExpenses = sum(expenses);
  const pool = Math.max(totalIncome, totalExpenses);
  const surplus = Math.max(0, totalIncome - totalExpenses);
  const deficit = Math.max(0, totalExpenses - totalIncome);

  const sources = foldSmallItems(income, { maxItems: maxSources, pool, otherLabel: OTHER_INCOME_LABEL, kind: "income" });
  const uses = foldSmallItems(expenses, { maxItems: maxUses, pool, otherLabel: OTHER_SPENDING_LABEL, kind: "expense" });
  if (deficit > 0) sources.push({ name: DEFICIT_LABEL, value: deficit, kind: "deficit" });
  if (surplus > 0) uses.push({ name: SURPLUS_LABEL, value: surplus, kind: "surplus" });

  return { sources, uses, totalIncome, totalExpenses, pool, surplus, deficit };
}
