/**
 * The cash flow diagram's columns (Reports → Cash Flow), worked out once so the
 * chart only draws them.
 *
 * Three columns: every income source flows into ONE income pool in the middle,
 * and the pool flows out to each expense category. What is left over is a
 * "Surplus" node on the right; a period that spent more than it earned gets a
 * "Deficit" node on the left, so both sides always add up to the pool.
 *
 * Two levels: "category" shows each category; "group" shows each category
 * group, and a group listed in `expanded` is replaced by its own categories
 * (kept together, in the group's place and colour).
 *
 * Small items are folded into "Other income" / "Other spending" so the labels
 * stay readable, and the folded amount still counts: before this the chart
 * kept only the 10 largest expense categories and dropped the rest, which made
 * the leftover look bigger than it was. An expanded group is never folded.
 */

export type CashFlowItem = { name: string; value: number; group?: string | null };

export type CashFlowLevel = "group" | "category";

export type CashFlowNodeKind = "income" | "expense" | "other" | "surplus" | "deficit";

export type CashFlowNode = {
  name: string;
  value: number;
  kind: CashFlowNodeKind;
  /** Unique within its column; the chart keys bands and clicks on it. */
  key: string;
  /** The category group this node belongs to (category level / expanded children). */
  group?: string;
  /** "group": a collapsed group node; "child": a category shown because its group is expanded. */
  role?: "group" | "child";
  /** How many categories a group node holds (group nodes only). */
  childCount?: number;
  /** Nodes with the same colourKey share a colour (an expanded group's categories share it). */
  colourKey: string;
};

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
export const UNGROUPED_LABEL = "Ungrouped";

/** Below this share of the pool an item is folded into "Other", however few items there are. */
export const MIN_SHARE = 0.01;

const positive = (v: number) => Number.isFinite(v) && v > 0;

/** The key a group is expanded under: one set holds both columns' groups. */
export function groupKey(side: "income" | "expense", group: string): string {
  return `${side}:${group}`;
}

/** A unit is what folding and ordering work on: one node, or an expanded group's categories. */
type Unit = { value: number; nodes: CashFlowNode[]; pinned: boolean };

function unitsFor(
  items: CashFlowItem[],
  side: "income" | "expense",
  level: CashFlowLevel,
  expanded: ReadonlySet<string>,
): Unit[] {
  const clean = items.filter((i) => positive(i.value));
  if (level === "category") {
    return clean.map((i) => {
      const group = i.group?.trim() || undefined;
      return {
        value: i.value,
        pinned: false,
        nodes: [{ name: i.name, value: i.value, kind: side, key: `c:${i.name}`, group, colourKey: `c:${i.name}` }],
      };
    });
  }
  const byGroup = new Map<string, CashFlowItem[]>();
  for (const i of clean) {
    const g = i.group?.trim() || UNGROUPED_LABEL;
    const list = byGroup.get(g) ?? [];
    list.push(i);
    byGroup.set(g, list);
  }
  const units: Unit[] = [];
  for (const [g, children] of byGroup) {
    const value = children.reduce((s, c) => s + c.value, 0);
    if (children.length > 1 && expanded.has(groupKey(side, g))) {
      const nodes = [...children]
        .sort((a, b) => b.value - a.value)
        .map((c) => ({
          name: c.name,
          value: c.value,
          kind: side,
          key: `c:${g}:${c.name}`,
          group: g,
          role: "child" as const,
          colourKey: `g:${g}`,
        }));
      units.push({ value, pinned: true, nodes });
    } else {
      units.push({
        value,
        pinned: false,
        nodes: [{ name: g, value, kind: side, key: `g:${g}`, group: g, role: "group", childCount: children.length, colourKey: `g:${g}` }],
      });
    }
  }
  return units;
}

/**
 * Largest first. Units under `minShare` of `pool`, or past `maxItems` (an
 * expanded group counts as one), are folded into one `otherLabel` node.
 * Expanded groups are never folded.
 */
function foldUnits(units: Unit[], { maxItems, pool, otherLabel }: { maxItems: number; pool: number; otherLabel: string }): CashFlowNode[] {
  const sorted = [...units].sort((a, b) => b.value - a.value);
  const isSmall = (u: Unit) => !u.pinned && pool > 0 && u.value / pool < MIN_SHARE;
  const big = sorted.filter((u) => !isSmall(u));
  const small = sorted.filter(isSmall);

  let keep = big;
  let rest = small;
  if (big.length + (small.length > 0 ? 1 : 0) > maxItems) {
    // Keep pinned units first, then the largest others, leaving one slot for "Other".
    const pinned = big.filter((u) => u.pinned);
    const others = big.filter((u) => !u.pinned);
    const room = Math.max(0, maxItems - 1 - pinned.length);
    const kept = new Set([...pinned, ...others.slice(0, room)]);
    keep = big.filter((u) => kept.has(u));
    rest = sorted.filter((u) => !kept.has(u));
  }
  const nodes = keep.flatMap((u) => u.nodes);
  if (rest.length === 1) {
    // One leftover isn't worth an "Other" node: show it by name.
    nodes.push(...rest[0].nodes);
  } else if (rest.length > 1) {
    const value = rest.reduce((s, u) => s + u.value, 0);
    nodes.push({ name: otherLabel, value, kind: "other", key: "other", colourKey: "other" });
  }
  return nodes;
}

/** Kept for callers that fold a flat list (category level, nothing expanded). */
export function foldSmallItems(
  items: CashFlowItem[],
  { maxItems, pool, otherLabel, kind }: { maxItems: number; pool: number; otherLabel: string; kind: "income" | "expense" },
): CashFlowNode[] {
  return foldUnits(unitsFor(items, kind, "category", new Set()), { maxItems, pool, otherLabel });
}

export function buildCashFlowColumns(
  income: CashFlowItem[],
  expenses: CashFlowItem[],
  {
    maxSources = 7,
    maxUses = 10,
    level = "category",
    expanded = new Set<string>(),
  }: { maxSources?: number; maxUses?: number; level?: CashFlowLevel; expanded?: ReadonlySet<string> } = {},
): CashFlowColumns {
  const sum = (xs: CashFlowItem[]) => xs.reduce((s, x) => s + (positive(x.value) ? x.value : 0), 0);
  const totalIncome = sum(income);
  const totalExpenses = sum(expenses);
  const pool = Math.max(totalIncome, totalExpenses);
  const surplus = Math.max(0, totalIncome - totalExpenses);
  const deficit = Math.max(0, totalExpenses - totalIncome);

  const sources = foldUnits(unitsFor(income, "income", level, expanded), { maxItems: maxSources, pool, otherLabel: OTHER_INCOME_LABEL });
  const uses = foldUnits(unitsFor(expenses, "expense", level, expanded), { maxItems: maxUses, pool, otherLabel: OTHER_SPENDING_LABEL });
  if (deficit > 0) sources.push({ name: DEFICIT_LABEL, value: deficit, kind: "deficit", key: "deficit", colourKey: "deficit" });
  if (surplus > 0) uses.push({ name: SURPLUS_LABEL, value: surplus, kind: "surplus", key: "surplus", colourKey: "surplus" });

  return { sources, uses, totalIncome, totalExpenses, pool, surplus, deficit };
}

/** Whether any category in the data has a group, i.e. whether the group level means anything. */
export function hasGroups(items: CashFlowItem[]): boolean {
  return items.some((i) => positive(i.value) && !!i.group?.trim());
}
