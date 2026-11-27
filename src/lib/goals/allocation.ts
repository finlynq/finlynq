/**
 * Per-link goal allocations (GH #462, 2026-11-27). Pure, client-safe.
 *
 * A goal links accounts through `goal_accounts`. Until now every link counted
 * the WHOLE account, so two goals sharing one savings account each counted its
 * full balance (or full growth) and the money was counted twice. A link can now
 * say how much of the account it counts:
 *
 *   null        the whole account (every link before this; the default)
 *   'percent'   value % of what the account counts (0 < value <= 100)
 *   'amount'    up to `value`, in the GOAL's currency, never more than the
 *               account actually counts and never below 0
 *
 * "What the account counts" is the same figure the goal used before: its
 * balance for a balance goal, its growth since the start date for a growth
 * goal, already converted into the goal's currency. The allocation is applied
 * AFTER that conversion, which is why an amount is in the goal's currency.
 *
 * Over-allocation is a WARNING, never a refusal: a balance can always drop
 * below what the goals claim (a withdrawal), so refusing on save would only
 * move the problem. `summarizeAccountClaims` works out, per account, how much
 * the active goals claim against what it holds.
 */

export const GOAL_ALLOCATION_KINDS = ["amount", "percent"] as const;
export type GoalAllocationKind = (typeof GOAL_ALLOCATION_KINDS)[number];
export type GoalAllocation = { kind: GoalAllocationKind; value: number };

export function isGoalAllocationKind(v: unknown): v is GoalAllocationKind {
  return typeof v === "string" && (GOAL_ALLOCATION_KINDS as readonly string[]).includes(v);
}

/**
 * Why a link's allocation can't be saved, or null when it can. `kind` null or
 * undefined means "the whole account" and then no value may be sent.
 */
export function allocationRefusal(
  kind: string | null | undefined,
  value: number | null | undefined,
): string | null {
  const hasValue = value !== null && value !== undefined;
  if (kind === null || kind === undefined) {
    return hasValue ? "An allocation value needs an allocation kind (amount or percent)." : null;
  }
  if (!isGoalAllocationKind(kind)) return `"${kind}" is not an allocation kind (use amount or percent).`;
  if (!hasValue || !Number.isFinite(value)) {
    return kind === "percent" ? "Enter the percentage of the account to count." : "Enter the amount of the account to count.";
  }
  if (kind === "percent" && (value <= 0 || value > 100)) {
    return "A percentage allocation must be more than 0 and at most 100.";
  }
  if (kind === "amount" && value <= 0) return "An amount allocation must be more than 0.";
  return null;
}

/** Read a stored (kind, value) pair. Anything incomplete or invalid is the whole account. */
export function readAllocation(kind: unknown, value: unknown): GoalAllocation | null {
  if (!isGoalAllocationKind(kind)) return null;
  const n = typeof value === "number" ? value : value == null ? NaN : Number(value);
  if (allocationRefusal(kind, n) !== null) return null;
  return { kind, value: n };
}

/**
 * The part of `value` (what the account counts, in the goal's currency) that a
 * link with this allocation counts toward its goal.
 *   whole    value, unchanged (can be negative: an overdrawn account or a growth goal that shrank)
 *   percent  value × pct / 100
 *   amount   clamp(value, 0, amount): never more than the account counts, never negative
 */
export function allocatedValue(value: number, allocation: GoalAllocation | null): number {
  if (!allocation) return value;
  if (allocation.kind === "percent") return (value * allocation.value) / 100;
  return Math.min(Math.max(value, 0), allocation.value);
}

/**
 * What one link claims of its account, in the ACCOUNT's currency.
 *   amount   the configured amount (converted), even when the account holds
 *            less: that is exactly the shortfall the warning is for
 *   percent  what the link counts now; its percentage adds to the account's
 *            percent total only for a balance goal (a growth goal's percent is
 *            of the growth, not of the account)
 *   whole    what the link counts now, and 100% for a balance goal
 */
export function linkClaim(args: {
  allocation: GoalAllocation | null;
  /** What the link counts, account currency (after the allocation). */
  countedInAccountCurrency: number;
  /** The allocation amount converted into the account currency (amount kind only). */
  amountInAccountCurrency?: number;
  /** True for a balance goal, false for a growth goal. */
  measuresBalance: boolean;
}): { claim: number; percent: number | null } {
  const { allocation, measuresBalance } = args;
  if (allocation?.kind === "amount") {
    return { claim: Math.max(args.amountInAccountCurrency ?? allocation.value, 0), percent: null };
  }
  const claim = Math.max(args.countedInAccountCurrency, 0);
  if (!measuresBalance) return { claim, percent: null };
  return { claim, percent: allocation ? allocation.value : 100 };
}

export type AccountClaimRow = {
  accountId: number;
  goalId: number;
  /** The account's balance now, account currency. */
  balance: number;
  /** What this link claims (see `linkClaim`), account currency. */
  claim: number;
  /** Percent of the account this link claims, or null. */
  percent: number | null;
};

export type AccountClaimSummary = {
  accountId: number;
  /** The account's balance now, account currency. */
  balance: number;
  /** Sum of every active goal's claim on the account, account currency. */
  claimed: number;
  /** What no goal claims: max(balance, 0) − claimed. Negative when over-allocated. */
  unallocated: number;
  /** Sum of the balance goals' percentages (a whole-account link is 100). */
  percentClaimed: number;
  overAllocated: boolean;
  goalIds: number[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per account: how much the goals claim against what it holds. Over-allocated
 * when the claims add up to more than the balance (a cent of slack for
 * rounding), or the percentages to more than 100% (two goals each counting
 * the whole account is 200%).
 */
export function summarizeAccountClaims(rows: readonly AccountClaimRow[]): Map<number, AccountClaimSummary> {
  const out = new Map<number, AccountClaimSummary>();
  for (const r of rows) {
    const s = out.get(r.accountId) ?? {
      accountId: r.accountId,
      balance: r.balance,
      claimed: 0,
      unallocated: 0,
      percentClaimed: 0,
      overAllocated: false,
      goalIds: [],
    };
    s.claimed += Math.max(r.claim, 0);
    if (r.percent != null) s.percentClaimed += r.percent;
    if (!s.goalIds.includes(r.goalId)) s.goalIds.push(r.goalId);
    out.set(r.accountId, s);
  }
  for (const s of out.values()) {
    const available = Math.max(s.balance, 0);
    s.balance = round2(s.balance);
    s.claimed = round2(s.claimed);
    s.unallocated = round2(available - s.claimed);
    s.percentClaimed = Math.round(s.percentClaimed * 100) / 100;
    s.overAllocated = s.percentClaimed > 100.0001 || s.claimed > available + 0.005;
  }
  return out;
}
