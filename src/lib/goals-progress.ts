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
import { and, eq, inArray, sql } from "drizzle-orm";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { getLatestFxRate } from "@/lib/fx-service";

export type GoalProgressInput = {
  id: number;
  currency: string | null;
  targetAmount: number;
  deadline: string | null;
  accountIds: number[];
};

export type GoalProgressOutput = {
  goalId: number;
  currentAmount: number;
  progress: number;
  remaining: number;
  monthlyNeeded: number;
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

  const accountMeta: Map<number, { currency: string; isInvestment: boolean }> =
    allAccountIds.length > 0
      ? new Map(
          (
            await db
              .select({
                id: schema.accounts.id,
                currency: schema.accounts.currency,
                isInvestment: schema.accounts.isInvestment,
              })
              .from(schema.accounts)
              .where(
                and(
                  eq(schema.accounts.userId, userId),
                  inArray(schema.accounts.id, allAccountIds),
                ),
              )
          ).map((a) => [a.id, { currency: a.currency, isInvestment: !!a.isInvestment }]),
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
    const goalCurrency = (g.currency ?? "CAD").toUpperCase();
    let currentAmount = 0;
    for (const accountId of g.accountIds) {
      const meta = accountMeta.get(accountId);
      if (!meta) continue; // account got deleted under us; skip silently
      const valueInAccountCcy = meta.isInvestment
        ? holdingsByAccount.get(accountId)?.value ?? 0
        : cashByAccount.get(accountId) ?? 0;
      const fx = await getFx(meta.currency, goalCurrency);
      currentAmount += valueInAccountCcy * fx;
    }

    const progress =
      g.targetAmount > 0
        ? Math.min((currentAmount / g.targetAmount) * 100, 100)
        : 0;
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
      progress: Math.round(progress * 10) / 10,
      remaining: Math.round(remaining * 100) / 100,
      monthlyNeeded,
    });
  }

  return out;
}
