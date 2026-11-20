/**
 * Shared goal-progress aggregator.
 *
 * Used by REST `GET /api/goals` and MCP HTTP `get_goals`. Computes
 * `currentAmount` (in goal currency), `progress` (0..100, 1dp),
 * `remaining` (cents), and `monthlyNeeded` per goal.
 *
 * Per-account branching follows CLAUDE.md "Account balance for accounts with
 * holdings = `holdings.value`, NOT `b.balance + holdings.value`":
 *   - `accounts.is_investment=true` ⇒ market value from
 *     `getHoldingsValueByAccount` (cash sleeve already inside `holdings.value`
 *     via the currency-as-holding pattern).
 *   - cash accounts ⇒ SUM(transactions.amount).
 *
 * Each per-account contribution is FX-converted into the goal currency before
 * summing — multi-currency goals (e.g. CAD goal linked to a USD account)
 * report a meaningful progress ratio. Triangulated through USD by the FX
 * engine; same-currency hits the `from === to => 1.0` short-circuit.
 *
 * Pure aggregation: no name decryption needed. Numeric only. Safe to call
 * with `dek=null` if the caller can supply one (REST does; MCP HTTP does too)
 * — `getHoldingsValueByAccount` will fall back to nulls for any name/symbol
 * it can't decrypt and still compute market value via the encrypted-name
 * lookup path.
 */

import { db, schema } from "@/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { getLatestFxRate } from "@/lib/fx-service";
import { dayBefore, normalizeProgressMode, type GoalProgressMode } from "@/lib/goals/progress-mode";

export type GoalProgressInput = {
  id: number;
  /** Goal type; `debt_payoff` measures paid-down debt instead of saved balance. */
  type?: string | null;
  currency: string | null;
  targetAmount: number;
  deadline: string | null;
  accountIds: number[];
  /** GH #423: 'balance' (default) or 'growth' since `startDate`. */
  progressMode?: string | null;
  /** Growth goals only: the first day counted (YYYY-MM-DD). */
  startDate?: string | null;
};

export type GoalProgressOutput = {
  goalId: number;
  /** Balance goals: the linked balance. Growth goals: growth since the start date (can be negative). */
  currentAmount: number;
  progress: number;
  remaining: number;
  monthlyNeeded: number;
  progressMode: GoalProgressMode;
  /** The linked accounts' balance now, in the goal currency (= currentAmount for a balance goal). */
  balanceNow: number;
  /** Growth goals: the balance at the end of the day before the start date. Null for balance goals. */
  startAmount: number | null;
};

/**
 * Compute progress for a batch of goals belonging to one user. Issues a
 * fixed number of queries regardless of goal count (account meta + cash sums
 * + holdings snapshot + an FX cache).
 */
export async function computeGoalProgress(
  userId: string,
  dek: Buffer | null,
  goals: GoalProgressInput[],
): Promise<Map<number, GoalProgressOutput>> {
  const out = new Map<number, GoalProgressOutput>();
  if (!goals.length) return out;

  const allAccountIds = Array.from(
    new Set(goals.flatMap((g) => g.accountIds)),
  );

  const accountMeta: Map<
    number,
    { currency: string; isInvestment: boolean; isLiability: boolean }
  > =
    allAccountIds.length > 0
      ? new Map(
          (
            await db
              .select({
                id: schema.accounts.id,
                currency: schema.accounts.currency,
                isInvestment: schema.accounts.isInvestment,
                type: schema.accounts.type,
              })
              .from(schema.accounts)
              .where(
                and(
                  eq(schema.accounts.userId, userId),
                  inArray(schema.accounts.id, allAccountIds),
                ),
              )
          ).map((a) => [
            a.id,
            {
              currency: a.currency,
              isInvestment: !!a.isInvestment,
              isLiability: a.type === "L",
            },
          ]),
        )
      : new Map();

  // Pull the holdings-value snapshot once. Internally it computes per-account
  // market value with full per-currency cost-basis bucketing (issue #129) and
  // cash-leg substitution (issue #96).
  const holdingsByAccount = await getHoldingsValueByAccount(userId, dek);

  // Per-account cash-flow basis (cash accounts only). One query, grouped by
  // accountId.
  const cashByAccount = new Map<number, number>();
  if (allAccountIds.length > 0) {
    const cashRows = await db
      .select({
        accountId: schema.transactions.accountId,
        total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)::float8`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.accountId, allAccountIds),
        ),
      )
      .groupBy(schema.transactions.accountId);
    for (const r of cashRows) {
      if (r.accountId == null) continue;
      cashByAccount.set(r.accountId, Number(r.total ?? 0));
    }
  }

  // GH #423 — growth goals also need each linked account's balance at the end
  // of the day before their start date. Same basis as "now": ledger sum for a
  // cash account, holdings valued at that date for an investment account. One
  // pass per distinct start date (most users have one or two).
  const startBalances = new Map<string, Map<number, number>>(); // startDate -> accountId -> value
  const growthGoals = goals.filter(
    (g) => normalizeProgressMode(g.progressMode) === "growth" && g.startDate,
  );
  for (const startDate of new Set(growthGoals.map((g) => g.startDate as string))) {
    const ids = Array.from(
      new Set(growthGoals.filter((g) => g.startDate === startDate).flatMap((g) => g.accountIds)),
    );
    const byAccount = new Map<number, number>();
    const cashIds = ids.filter((id) => accountMeta.get(id) && !accountMeta.get(id)!.isInvestment);
    if (cashIds.length > 0) {
      const rows = await db
        .select({
          accountId: schema.transactions.accountId,
          total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)::float8`,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            inArray(schema.transactions.accountId, cashIds),
            lt(schema.transactions.date, startDate),
          ),
        )
        .groupBy(schema.transactions.accountId);
      for (const r of rows) if (r.accountId != null) byAccount.set(r.accountId, Number(r.total ?? 0));
    }
    if (ids.some((id) => accountMeta.get(id)?.isInvestment)) {
      const atStart = await getHoldingsValueByAccount(userId, dek, { asOfDate: dayBefore(startDate) });
      for (const id of ids) {
        if (accountMeta.get(id)?.isInvestment) byAccount.set(id, atStart.get(id)?.value ?? 0);
      }
    }
    startBalances.set(startDate, byAccount);
  }

  // FX cache shared across goals — most users have ≤3 distinct currencies.
  const fxCache = new Map<string, number>();
  const getFx = async (from: string, to: string): Promise<number> => {
    if (from === to) return 1;
    const key = `${from}->${to}`;
    if (fxCache.has(key)) return fxCache.get(key)!;
    const rate = await getLatestFxRate(from, to, userId);
    fxCache.set(key, rate);
    return rate;
  };

  for (const g of goals) {
    // `goals.currency` is NOT NULL, so this fallback only covers a caller that
    // omits it. USD, never CAD (FINLYNQ-183 — the app-wide default).
    const goalCurrency = (g.currency ?? "USD").toUpperCase();
    const mode = normalizeProgressMode(g.progressMode);
    const growth = mode === "growth" && !!g.startDate;
    const atStart = growth ? startBalances.get(g.startDate as string) : undefined;
    let currentAmount = 0;
    let startAmount = 0;
    let linksLiability = false;
    for (const accountId of g.accountIds) {
      const meta = accountMeta.get(accountId);
      if (!meta) continue; // account got deleted under us; skip silently
      if (meta.isLiability) linksLiability = true;
      const valueInAccountCcy = meta.isInvestment
        ? holdingsByAccount.get(accountId)?.value ?? 0
        : cashByAccount.get(accountId) ?? 0;
      const fx = await getFx(meta.currency, goalCurrency);
      currentAmount += valueInAccountCcy * fx;
      // Both ends at today's rate, so a currency move alone is not growth.
      if (atStart) startAmount += (atStart.get(accountId) ?? 0) * fx;
    }
    const balanceNow = currentAmount;

    // Growth goals count only what changed since the start date. A liability
    // paid down reads as positive growth on its own, so the debt_payoff flip
    // below is for balance goals only.
    if (growth) currentAmount = balanceNow - startAmount;

    // debt_payoff goals linked to a liability account measure the debt itself:
    // the summed balance is negative (what is still owed), and progress is the
    // part of the target already paid off, so a freshly-linked loan reads 0%
    // rather than -100%. Gated on an actual liability link — a debt goal with
    // no accounts (manual tracking) or one saving toward the payoff in an
    // asset account keeps the ordinary saved-balance rule; inverting those
    // read "nothing owed" and reported them 100% complete on day one.
    if (!growth && g.type === "debt_payoff" && linksLiability) {
      const owed = Math.max(-currentAmount, 0);
      currentAmount = Math.max(g.targetAmount - owed, 0);
    }

    const progress =
      g.targetAmount > 0
        ? Math.min((currentAmount / g.targetAmount) * 100, 100)
        : 0;
    // A growth goal whose accounts shrank since the start reads 0%, not negative.
    const shownProgress = growth ? Math.max(progress, 0) : progress;
    const remaining = Math.max(g.targetAmount - currentAmount, 0);

    let monthlyNeeded = 0;
    if (g.deadline && remaining > 0) {
      const now = new Date();
      const deadline = new Date(g.deadline + "T00:00:00");
      const monthsLeft = Math.max(
        (deadline.getFullYear() - now.getFullYear()) * 12 +
          deadline.getMonth() -
          now.getMonth(),
        1,
      );
      monthlyNeeded = Math.round((remaining / monthsLeft) * 100) / 100;
    }

    out.set(g.id, {
      goalId: g.id,
      currentAmount: Math.round(currentAmount * 100) / 100,
      progress: Math.round(shownProgress * 10) / 10,
      remaining: Math.round(remaining * 100) / 100,
      monthlyNeeded,
      progressMode: growth ? "growth" : "balance",
      balanceNow: Math.round(balanceNow * 100) / 100,
      startAmount: growth ? Math.round(startAmount * 100) / 100 : null,
    });
  }

  return out;
}
