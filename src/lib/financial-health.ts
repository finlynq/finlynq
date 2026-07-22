/**
 * Canonical financial-health calculator (FINLYNQ-94, 2026-05-23).
 *
 * Single source of truth for the 6-component health score consumed by both
 * the REST dashboard (`/api/health-score`) and the MCP HTTP tool
 * (`get_financial_health_score`). Promoted from the MCP tool body
 * (register-tools-pg.ts:1962-2258, issue #235) and extended with the 6th
 * component (Age of Money) that was dropped from the MCP version.
 *
 * Component weights (canonical, do NOT change without a deliberate audit):
 *   Savings Rate      0.25
 *   Debt-to-Income    0.20
 *   Emergency Fund    0.15
 *   Net Worth Trend   0.15
 *   Budget Adherence  0.15
 *   Age of Money      0.10
 *                     ----
 *                     1.00
 *
 * Issue #235 features preserved:
 *   - Components with `excluded: true` are dropped from the weighted average
 *     and the remaining weights renormalize across the kept ones.
 *     `excludedComponents[]` surfaces what was dropped + the reason.
 *   - Liquid assets exclude `is_investment=true` accounts and use a cash-group
 *     whitelist (not substring matching on `group`).
 *   - Net Worth Trend is a real 3M delta with `{ direction, magnitudePct,
 *     descriptor }` structured detail (surfaced as `detailRich` on the MCP
 *     response; the REST `detail` is the human descriptor).
 *   - DTI uses trailing-12-month debt payments / trailing-12-month income
 *     (no 3m × 4 extrapolation).
 *   - Sub-component scores accumulate un-rounded; final score is rounded once.
 *
 * Queries are over plaintext columns (`categories.type`, `accounts.type`,
 * `accounts.group`, `accounts.is_investment`, `transactions.amount`,
 * `transactions.date`, `transactions.currency`, `accounts.currency`,
 * `budgets.amount`, `budgets.month`) — no DEK required. `dek` is accepted as
 * an opt-in parameter for future extensions but is unused today.
 */

import { sql } from "drizzle-orm";
import { calculateAgeOfMoney } from "./age-of-money";
import { getRate } from "./fx-service";
import { tagAmount, type TaggedAmount } from "../../mcp-server/currency-tagging";
import { isCashGroup } from "./accounts/groups";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { execute: (q: ReturnType<typeof sql>) => Promise<any> };

function asRows(result: unknown): Array<Record<string, unknown>> {
  if (result && typeof result === "object") {
    if ("rows" in result && Array.isArray((result as { rows?: unknown }).rows)) {
      return (result as { rows: Array<Record<string, unknown>> }).rows;
    }
    if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  }
  return [];
}

// Cash-group whitelist for the liquid-assets filter — now the shared canonical
// set (GH #307). `isCashGroup` (from accounts/groups) is the single source of
// truth, reused by the cash-flow forecast + chat balance summary. Extend the
// list THERE rather than reverting to a local copy or substring matching.

// Canonical weights (must sum to 1.0).
export const HEALTH_WEIGHTS = {
  savingsRate: 0.25,
  dti: 0.2,
  emergencyFund: 0.15,
  netWorthTrend: 0.15,
  budgetAdherence: 0.15,
  ageOfMoney: 0.1,
} as const;

export type NetWorthTrendDetail = {
  direction: "up" | "down" | "flat";
  magnitudePct: number;
  descriptor: string;
};

export type HealthComponent = {
  name: string;
  score: number;
  weight: number;
  weighted: number;
  detail: string;
  /** Structured detail (only Net Worth Trend today). MCP-surface field. */
  detailRich?: NetWorthTrendDetail;
};

export type HealthExclusion = {
  name: string;
  reason: string;
  detail: string;
};

export type HealthTotals = {
  totalIncome3m: TaggedAmount;
  totalExpenses3m: TaggedAmount;
  totalIncome12m: TaggedAmount;
  totalDebtPayments12m: TaggedAmount;
  totalLiabilities: TaggedAmount;
  liquidAssets: TaggedAmount;
  netWorthToday: TaggedAmount;
  netWorth90DaysAgo: TaggedAmount;
  avgMonthlyExpenses3m: TaggedAmount;
  ageOfMoneyDays: number;
  ageOfMoneyTrendDays: number;
};

export type HealthPayload = {
  score: number;
  grade: "Excellent" | "Good" | "Fair" | "Needs Work";
  components: HealthComponent[];
  excludedComponents: HealthExclusion[];
  reportingCurrency: string;
  totals: HealthTotals;
  /**
   * FINLYNQ-291 — the real headline percentages surfaced as first-class figures
   * on the dashboard. The composite score only ever exposes these as normalized
   * 0-100 sub-scores; here we carry the actual ratios.
   *   - `savingsRatePct`: 3-month (income − expenses) / income, `null` when there
   *     is no income to divide by.
   *   - `dti.pct`: trailing-12-month debt-service / income, `null` with no income.
   *   - `dti.reliable`: mirrors the anomaly backstop that drops DTI from the score
   *     (payments > 1.2× outstanding liabilities). When `false` the raw ratio is
   *     likely inflated by mis-linked transfer legs, so the UI must caveat it
   *     rather than present it as authoritative.
   */
  savingsRatePct: number | null;
  dti: { pct: number | null; reliable: boolean };
};

export type CalculateFinancialHealthArgs = {
  db: DbLike;
  userId: string;
  /** Accepted for future use (decryption queries). Today every query is plaintext. */
  dek: Buffer | null;
  reportingCurrency: string;
};

function gradeFor(score: number): HealthPayload["grade"] {
  return score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Fair" : "Needs Work";
}

/**
 * Compute the 6-component financial health score for `userId`.
 *
 * Caller responsibilities:
 *   - resolve `reportingCurrency` (e.g. via getDisplayCurrency or
 *     resolveReportingCurrency) before calling.
 *   - pass the bound `db` proxy (REST) or the raw adapter db (MCP). Both
 *     speak `execute(sql\`...\`)`.
 *   - `dek` is unused today; pass `null` if not in scope.
 */
export async function calculateFinancialHealth(
  args: CalculateFinancialHealthArgs,
): Promise<HealthPayload> {
  const { db, userId, reportingCurrency } = args;
  const reporting = reportingCurrency.toUpperCase();

  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const threeAgo = new Date(now);
  threeAgo.setMonth(threeAgo.getMonth() - 3);
  const threeStart = `${threeAgo.getFullYear()}-${String(threeAgo.getMonth() + 1).padStart(2, "0")}-01`;
  const twelveAgo = new Date(now);
  twelveAgo.setFullYear(twelveAgo.getFullYear() - 1);
  const twelveStart = twelveAgo.toISOString().split("T")[0];

  // Per-currency FX cache against `today` — one call per distinct currency.
  const fxCache = new Map<string, number>();
  const fxFor = async (ccy: string): Promise<number> => {
    const k = (ccy || reporting).toUpperCase();
    if (fxCache.has(k)) return fxCache.get(k)!;
    const r = await getRate(k, reporting, today, userId);
    fxCache.set(k, r);
    return r;
  };

  // ── 1. Savings Rate (3-month window) ───────────────────────────────────
  const incomeExpenses = asRows(await db.execute(sql`
    SELECT TO_CHAR(t.date::date, 'YYYY-MM') AS month, c.type AS cat_type,
           COALESCE(t.currency, a.currency) AS currency,
           SUM(t.amount) AS total
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.user_id = ${userId} AND t.date >= ${threeStart} AND c.type IN ('E','I')
    GROUP BY TO_CHAR(t.date::date, 'YYYY-MM'), c.type, COALESCE(t.currency, a.currency)
  `)) as Array<{ month: string; cat_type: string; currency: string | null; total: number | string }>;

  let totalIncome = 0;
  let totalExpenses = 0;
  for (const r of incomeExpenses) {
    const fx = await fxFor(String(r.currency ?? reporting));
    const converted = Number(r.total) * fx;
    if (r.cat_type === "I") totalIncome += converted;
    if (r.cat_type === "E") totalExpenses += Math.abs(converted);
  }
  const savingsRateScore =
    totalIncome > 0
      ? Math.min(100, Math.max(0, ((totalIncome - totalExpenses) / totalIncome) * 500))
      : 0;
  const savingsRateDetail =
    totalIncome > 0
      ? `${Math.round(((totalIncome - totalExpenses) / totalIncome) * 100)}% savings rate`
      : "No income data";

  // ── 2. Debt-to-Income (trailing 12 months) ─────────────────────────────
  // Issue #235: annualizing 3-month income distorts in months with skewed
  // payment timing. Compute trailing-12m on both sides directly.
  //
  // FINLYNQ-255: the debt-service NUMERATOR is genuine debt service only —
  // outflows INTO a liability account (`a.type='L' AND amount<0`) that are
  // NOT part of a linked pair. Transfer legs (`link_id`), portfolio/trade legs
  // (`trade_link_id`) and swap legs (`swap_link_id`) all carry a link id and
  // are EXCLUDED: a credit-card PAYMENT is a cash→cc transfer (link_id set),
  // not debt service — the underlying purchases already register as spending
  // elsewhere. Counting those gross double-counted, inflating DTI past 100%.
  // (A robust anomaly backstop below also excludes the whole component when the
  // numerator still exceeds ~1.2× outstanding liabilities.)
  const incomeDebt12m = asRows(await db.execute(sql`
    SELECT c.type AS cat_type,
           COALESCE(t.currency, a.currency) AS currency,
           a.type AS account_type,
           SUM(t.amount) AS total
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.user_id = ${userId} AND t.date >= ${twelveStart}
      AND (c.type = 'I' OR (
        a.type = 'L' AND t.amount < 0
        AND t.link_id IS NULL AND t.trade_link_id IS NULL AND t.swap_link_id IS NULL
      ))
    GROUP BY c.type, COALESCE(t.currency, a.currency), a.type
  `)) as Array<{ cat_type: string | null; currency: string | null; account_type: string | null; total: number | string }>;

  let income12m = 0;
  let debtPayments12m = 0;
  for (const r of incomeDebt12m) {
    const fx = await fxFor(String(r.currency ?? reporting));
    const converted = Number(r.total) * fx;
    if (r.cat_type === "I") {
      income12m += converted;
    } else {
      // a.type = 'L' AND amount < 0 — payment INTO the liability. Flip sign.
      debtPayments12m += Math.abs(converted);
    }
  }
  const dtiRatio = income12m > 0 ? debtPayments12m / income12m : null;
  const dtiScore =
    dtiRatio !== null
      ? Math.min(100, Math.max(0, (1 - dtiRatio) * 100))
      : debtPayments12m === 0
        ? 100
        : 0;
  const dtiDetail =
    dtiRatio !== null
      ? `${Math.round(dtiRatio * 100)}% debt-to-income (12m)`
      : debtPayments12m === 0
        ? "No debt payments (12m)"
        : "No income data (12m)";

  // ── 3. Emergency Fund + 4. Net Worth Trend (account-balance roll-up) ──
  // Today's balances per account.
  const balances = asRows(await db.execute(sql`
    SELECT a.type, a."group", a.currency, a.is_investment,
           COALESCE(SUM(t.amount), 0) AS balance
    FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId}
    WHERE a.user_id = ${userId}
    GROUP BY a.id, a.type, a."group", a.currency, a.is_investment
  `)) as Array<{ type: string; group: string; currency: string | null; is_investment: boolean | null; balance: number | string }>;

  let totalLiabilities = 0;
  let liquidAssets = 0;
  for (const b of balances) {
    const fx = await fxFor(String(b.currency ?? reporting));
    const converted = Number(b.balance) * fx;
    if (b.type === "L") totalLiabilities += Math.abs(converted);
    if (b.type === "A") {
      if (b.is_investment !== true && isCashGroup(b.group)) {
        liquidAssets += converted;
      }
    }
  }

  // FINLYNQ-255: anomaly backstop. Even after excluding transfer legs from the
  // numerator, a data anomaly (mis-signed rows, a refinance/lump event, legacy
  // pre-link_id transfers) can leave 12m debt payments exceeding what could be
  // real debt service — you cannot service materially more than your entire
  // outstanding debt in a year. When the numerator exceeds ~1.2× starting
  // liabilities, EXCLUDE the whole DTI component via the existing renormalizing
  // `excludedComponents` mechanism rather than scoring it a misleading 0.
  const DTI_ANOMALY_MULTIPLE = 1.2;
  const dtiAnomaly =
    totalLiabilities > 0 && debtPayments12m > totalLiabilities * DTI_ANOMALY_MULTIPLE;

  const avgMonthlyExpenses = totalExpenses / 3;
  const emergencyScore =
    avgMonthlyExpenses > 0
      ? Math.min(100, Math.max(0, (liquidAssets / avgMonthlyExpenses / 6) * 100))
      : liquidAssets > 0
        ? 50
        : 0;
  const emergencyDetail =
    avgMonthlyExpenses > 0
      ? `${(liquidAssets / avgMonthlyExpenses).toFixed(1)} months covered`
      : "No expense data";

  // ── 4. Net Worth Trend (3-month delta) ─────────────────────────────────
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000);
  const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().split("T")[0];
  const balancesPast = asRows(await db.execute(sql`
    SELECT a.currency, COALESCE(SUM(t.amount), 0) AS balance
    FROM accounts a LEFT JOIN transactions t ON a.id = t.account_id AND t.user_id = ${userId} AND t.date <= ${ninetyDaysAgoStr}
    WHERE a.user_id = ${userId}
    GROUP BY a.id, a.currency
  `)) as Array<{ currency: string | null; balance: number | string }>;

  let nwToday = 0;
  let nwPast = 0;
  for (const b of balances) {
    const fx = await fxFor(String(b.currency ?? reporting));
    nwToday += Number(b.balance) * fx;
  }
  for (const b of balancesPast) {
    const fx = await fxFor(String(b.currency ?? reporting));
    nwPast += Number(b.balance) * fx;
  }

  // "Not enough history" detection — oldest tx must be ≥60 days back.
  const oldestRow = asRows(await db.execute(sql`
    SELECT MIN(t.date) AS oldest FROM transactions t WHERE t.user_id = ${userId}
  `)) as Array<{ oldest: string | null }>;
  const oldestStr = oldestRow[0]?.oldest ?? null;
  const oldestAgeDays = oldestStr
    ? Math.round((now.getTime() - new Date(oldestStr + "T00:00:00").getTime()) / 86400000)
    : 0;
  const insufficientHistory = !oldestStr || oldestAgeDays < 60;

  const nwAbsBase = Math.max(Math.abs(nwToday), Math.abs(nwPast), 1);
  const nwDelta = nwToday - nwPast;
  const nwMagnitudePct = insufficientHistory ? 0 : Math.round((nwDelta / nwAbsBase) * 1000) / 10;
  const nwDirection: NetWorthTrendDetail["direction"] = insufficientHistory
    ? "flat"
    : Math.abs(nwMagnitudePct) < 0.5
      ? "flat"
      : nwMagnitudePct > 0
        ? "up"
        : "down";
  const nwDescriptor = insufficientHistory
    ? "Not enough history"
    : nwDirection === "flat"
      ? "Flat over the last 3 months"
      : `${nwDirection === "up" ? "Up" : "Down"} ${Math.abs(nwMagnitudePct).toFixed(1)}% over the last 3 months`;
  // Score: -10% magnitude → 0, +10% → 100, flat → 50.
  const nwScore = insufficientHistory ? 0 : Math.min(100, Math.max(0, 50 + nwMagnitudePct * 5));

  // ── 5. Budget Adherence (current month) ────────────────────────────────
  const budgetsData = asRows(await db.execute(sql`
    SELECT b.id, b.amount AS budget,
           COALESCE(ABS(SUM(CASE WHEN t.date >= ${currentMonth + "-01"} AND t.date <= ${currentMonth + "-31"} THEN t.amount ELSE 0 END)), 0) AS spent
    FROM budgets b
    JOIN categories c ON b.category_id = c.id AND c.user_id = ${userId}
    LEFT JOIN transactions t ON t.category_id = c.id AND t.user_id = ${userId}
    WHERE b.month = ${currentMonth} AND b.user_id = ${userId}
    GROUP BY b.id, b.amount
  `)) as Array<{ budget: number | string; spent: number | string }>;

  const budgetOnTrackCount = budgetsData.filter(
    (b) => Number(b.spent) <= Math.abs(Number(b.budget)),
  ).length;
  const budgetScore = budgetsData.length > 0 ? (budgetOnTrackCount / budgetsData.length) * 100 : 0;
  const budgetDetail =
    budgetsData.length > 0 ? `${budgetOnTrackCount}/${budgetsData.length} on track` : "No budgets set";

  // ── 6. Age of Money (FIFO income-to-expense matching) ──────────────────
  let aomScore = 50;
  let aomDetail = "Insufficient data";
  let aomAgeDays = 0;
  let aomTrend = 0;
  try {
    const aom = await calculateAgeOfMoney(userId);
    aomAgeDays = aom.ageInDays;
    aomTrend = aom.trend;
    if (aom.ageInDays > 0) {
      aomScore = Math.min(100, Math.max(0, (aom.ageInDays / 30) * 100));
      aomDetail = `${aom.ageInDays} days`;
      if (aom.trend > 0) aomDetail += ` (+${aom.trend}d trend)`;
      else if (aom.trend < 0) aomDetail += ` (${aom.trend}d trend)`;
    }
  } catch {
    // Keep defaults (50/insufficient) on calculator failure.
  }
  const aomExcluded = aomAgeDays <= 0;

  // ── Compose + renormalize ─────────────────────────────────────────────
  type Candidate = {
    name: string;
    scoreRaw: number;
    weightCanonical: number;
    detail: string;
    detailRich?: NetWorthTrendDetail;
    excluded: boolean;
    excludeReason?: string;
  };

  const candidates: Candidate[] = [
    {
      name: "Savings Rate",
      scoreRaw: savingsRateScore,
      weightCanonical: HEALTH_WEIGHTS.savingsRate,
      detail: savingsRateDetail,
      excluded: false,
    },
    {
      name: "Debt-to-Income",
      scoreRaw: dtiScore,
      weightCanonical: HEALTH_WEIGHTS.dti,
      detail: dtiAnomaly
        ? `Debt payments (${Math.round(debtPayments12m)}) exceed ${DTI_ANOMALY_MULTIPLE}× liabilities (${Math.round(totalLiabilities)}) — likely a data anomaly`
        : dtiDetail,
      excluded: dtiAnomaly,
      excludeReason: dtiAnomaly ? "debt_payments_exceed_liabilities" : undefined,
    },
    {
      name: "Emergency Fund",
      scoreRaw: emergencyScore,
      weightCanonical: HEALTH_WEIGHTS.emergencyFund,
      detail: emergencyDetail,
      excluded: false,
    },
    {
      name: "Net Worth Trend",
      scoreRaw: nwScore,
      weightCanonical: HEALTH_WEIGHTS.netWorthTrend,
      detail: nwDescriptor,
      detailRich: { direction: nwDirection, magnitudePct: nwMagnitudePct, descriptor: nwDescriptor },
      excluded: insufficientHistory,
      excludeReason: insufficientHistory ? "insufficient_history" : undefined,
    },
    {
      name: "Budget Adherence",
      scoreRaw: budgetScore,
      weightCanonical: HEALTH_WEIGHTS.budgetAdherence,
      detail: budgetDetail,
      excluded: budgetsData.length === 0,
      excludeReason: budgetsData.length === 0 ? "no_budgets" : undefined,
    },
    {
      name: "Age of Money",
      scoreRaw: aomScore,
      weightCanonical: HEALTH_WEIGHTS.ageOfMoney,
      detail: aomDetail,
      excluded: aomExcluded,
      excludeReason: aomExcluded ? "insufficient_data" : undefined,
    },
  ];

  const keptWeightSum = candidates
    .filter((c) => !c.excluded)
    .reduce((s, c) => s + c.weightCanonical, 0);

  type ComponentWithRaw = HealthComponent & { weightedRaw: number };
  const kept: ComponentWithRaw[] = candidates
    .filter((c) => !c.excluded)
    .map((c) => {
      const weight = keptWeightSum > 0 ? c.weightCanonical / keptWeightSum : 0;
      const weightedRaw = c.scoreRaw * weight;
      const out: ComponentWithRaw = {
        name: c.name,
        score: Math.round(c.scoreRaw),
        weight: Math.round(weight * 1000) / 1000,
        weighted: Math.round(weightedRaw),
        detail: c.detail,
        weightedRaw,
      };
      if (c.detailRich) out.detailRich = c.detailRich;
      return out;
    });

  const totalScoreRaw = kept.reduce((s, c) => s + c.weightedRaw, 0);
  const totalScore = Math.round(Math.min(100, Math.max(0, totalScoreRaw)));

  const excludedComponents: HealthExclusion[] = candidates
    .filter((c) => c.excluded)
    .map((c) => ({
      name: c.name,
      reason: c.excludeReason ?? "excluded",
      detail: c.detail,
    }));

  const components: HealthComponent[] = kept.map(({ weightedRaw: _wr, ...rest }) => rest);

  // FINLYNQ-291 — standalone headline percentages for the dashboard metrics strip.
  // Savings rate reuses the 3-month income/expense window (same basis as the
  // Savings Rate component); DTI reuses the trailing-12m ratio. `dti.reliable`
  // is the negation of the anomaly backstop so the UI can present a caveated
  // figure instead of a suspect number when payments exceed outstanding debt.
  const savingsRatePct =
    totalIncome > 0
      ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100)
      : null;
  const dtiPct = dtiRatio !== null ? Math.round(dtiRatio * 100) : null;

  return {
    score: totalScore,
    grade: gradeFor(totalScore),
    components,
    excludedComponents,
    reportingCurrency: reporting,
    savingsRatePct,
    dti: { pct: dtiPct, reliable: !dtiAnomaly },
    totals: {
      totalIncome3m: tagAmount(totalIncome, reporting, "reporting"),
      totalExpenses3m: tagAmount(totalExpenses, reporting, "reporting"),
      totalIncome12m: tagAmount(income12m, reporting, "reporting"),
      totalDebtPayments12m: tagAmount(debtPayments12m, reporting, "reporting"),
      totalLiabilities: tagAmount(totalLiabilities, reporting, "reporting"),
      liquidAssets: tagAmount(liquidAssets, reporting, "reporting"),
      netWorthToday: tagAmount(nwToday, reporting, "reporting"),
      netWorth90DaysAgo: tagAmount(nwPast, reporting, "reporting"),
      avgMonthlyExpenses3m: tagAmount(avgMonthlyExpenses, reporting, "reporting"),
      ageOfMoneyDays: aomAgeDays,
      ageOfMoneyTrendDays: aomTrend,
    },
  };
}
