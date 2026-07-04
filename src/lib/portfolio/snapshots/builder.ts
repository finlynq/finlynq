/**
 * Daily snapshot builder — Phase 3 of plan/portfolio-lots-and-performance.md.
 *
 * For a given (user, date), persists one portfolio_snapshots row per
 * investment account PLUS one whole-portfolio aggregate (account_id
 * NULL). Reuses the Phase 1 / Phase 2 holdings-value aggregator to
 * stay aligned with the rest of the portfolio UI.
 *
 * Idempotent on the (user_id, snap_date, COALESCE(account_id, -1))
 * unique index — re-running for the same day is safe.
 *
 * Reporting-currency choice: snapshot lands in the user's CURRENT
 * reporting currency. Historical snapshots taken under a different
 * reporting ccy keep that ccy verbatim; the chart surfaces the
 * discontinuity via a tooltip.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { resolveReportingCurrency } from "../../../../mcp-server/reporting-currency";
import { getRate } from "@/lib/fx-service";
import { isInternalSwapKind } from "../aggregation-predicates";

export interface BuildDailySnapshotInput {
  userId: string;
  date: string;       // YYYY-MM-DD
  dek: Buffer | null; // needed for decryptNamedRows inside getHoldingsValueByAccount
}

export interface BuildDailySnapshotResult {
  userId: string;
  date: string;
  perAccountRows: number;
  aggregateRow: boolean;
  gapsFilled: boolean;
}

export async function buildDailySnapshot(
  input: BuildDailySnapshotInput,
): Promise<BuildDailySnapshotResult> {
  const { userId, date, dek } = input;

  // Post Stream D Phase 4 holding symbols are ENCRYPTED. Without a DEK,
  // getHoldingsValueByAccount can't decrypt a symbol to price it and falls back
  // to $1/unit — so a DEK-less build would write garbage market values for
  // stock holdings AND clobber good DEK-built snapshots via the UPSERT. Writing
  // nothing is strictly better. Snapshots are therefore built only from
  // DEK-bearing paths: the manual "Rebuild investment history" button and the
  // chart-load self-heal (GET /api/net-worth-history), both of which pass the
  // session DEK. A DEK-less caller (the nightly cron, the backfill script post
  // Stream D) is a no-op. plan/net-worth-over-time.md Part B.
  if (!dek) {
    return { userId, date, perAccountRows: 0, aggregateRow: false, gapsFilled: false };
  }

  const reportingCurrency = await resolveReportingCurrency(db, userId, undefined);

  // Per-account market value + cost basis (in account currency).
  const perAccount = await getHoldingsValueByAccount(userId, dek, {
    asOfDate: date,
  });

  // Per-account net contribution for the day, bucketed from the same-day legs
  // below (the receiving leg of each transfer pair). NOTE: a prior version also
  // ran `computeNetContributions()` here purely "for parity / future MWRR" and
  // then DISCARDED the result — that was one wasted DB round-trip per day, which
  // added up across a multi-year rebuild walk, so it has been removed.
  const perAccountContribution = new Map<number, number>();
  // Map cash flows back to account_id via the source transactions.
  // computeNetContributions doesn't return accountId today (sign-only),
  // so re-query for the same window to attribute. Cheap, single-day.
  const sameDayLegs = await db
    .select({
      accountId: schema.transactions.accountId,
      enteredAmount: schema.transactions.enteredAmount,
      amount: schema.transactions.amount,
      linkId: schema.transactions.linkId,
      tradeLinkId: schema.transactions.tradeLinkId,
      quantity: schema.transactions.quantity,
      kind: schema.transactions.kind,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.date, date),
      ),
    );
  for (const leg of sameDayLegs) {
    if (!leg.linkId || leg.accountId == null) continue;
    // Issue #128 (Phase 2 update, 2026-05-26): buy/sell paired cash legs
    // aren't contributions — they're internal swaps within the account.
    // Use `kind` discriminator for Phase 2+ rows; legacy `(amount=0 OR
    // quantity=0)` predicate covers pre-migration rows.
    if (leg.kind === "buy_cash_leg" || leg.kind === "sell_cash_leg") continue;
    // FINLYNQ-254: FX-conversion legs (fx_from/fx_to/fx_fee — a currency swap
    // inside ONE account) and in-kind transfer legs (a security moved between
    // the user's OWN accounts) are INTERNAL swaps, not external contributions.
    // Counting them stamped a phantom net_contribution (an FX residual, or one
    // orphaned leg of an inter-account move) onto the day, which fed the
    // Modified-Dietz chaining as a spurious flow and inflated TWRR. Skip them
    // so a transfer at unchanged prices reads as ~0% for the day.
    if (isInternalSwapKind(leg.kind)) continue;
    if (leg.tradeLinkId != null && (leg.amount === 0 || leg.quantity === 0)) continue;
    const value = Number(leg.enteredAmount ?? leg.amount ?? 0);
    if (value === 0) continue;
    // contribution INTO an account = positive on the receiving leg.
    // Mirror the snapshot's positive convention (the table stores
    // net_contribution as POSITIVE for inflows).
    perAccountContribution.set(
      leg.accountId,
      (perAccountContribution.get(leg.accountId) ?? 0) + value,
    );
  }

  // ─── FX cache for account-ccy → reporting-ccy ───
  const fxCache = new Map<string, number>();
  let gapsFilled = false;
  const fx = async (from: string, to: string): Promise<number> => {
    if (from === to) return 1;
    const key = `${from}>${to}`;
    if (fxCache.has(key)) return fxCache.get(key)!;
    try {
      const rate = await getRate(from, to, date, userId);
      fxCache.set(key, rate || 1);
      if (!rate) gapsFilled = true;
      return rate || 1;
    } catch {
      fxCache.set(key, 1);
      gapsFilled = true;
      return 1;
    }
  };

  // ─── Build every row for the day, then write them in ONE multi-row INSERT ───
  // Previously this issued one `db.execute(INSERT … ON CONFLICT)` PER account in
  // a loop plus a separate aggregate INSERT — ~N+1 serial DB round-trips per day,
  // which dominated a multi-year rebuild walk (each day idle-waiting on Postgres,
  // not CPU- or network-bound). We now collect the per-account rows + the
  // whole-portfolio aggregate and persist them in a SINGLE statement (1
  // round-trip/day). Numeric results are identical — only the round-trip count
  // changes.
  let totalMv = 0;
  let totalCb = 0;
  let totalContrib = 0;
  const accountRows: Array<{ accountId: number; mv: number; cb: number; contribution: number }> = [];

  for (const [accountId, v] of perAccount) {
    const fxRate = await fx(v.currency, reportingCurrency);
    const mv = v.value * fxRate;
    const cb = v.costBasis * fxRate;
    const contribution = (perAccountContribution.get(accountId) ?? 0) * fxRate;
    accountRows.push({ accountId, mv, cb, contribution });
    totalMv += mv;
    totalCb += cb;
    totalContrib += contribution;
  }

  // `gapsFilled` is only finalized after every fx() call above, so it is a
  // per-DAY quality flag now applied uniformly to all of the day's rows. (The
  // aggregate row always used this final value; per-account rows previously
  // carried whatever the flag happened to be mid-loop — an incidental artifact
  // of insert order, not a designed per-account signal.)
  const valueTuples = [
    ...accountRows.map(
      (r) =>
        sql`(${userId}, ${date}, ${r.accountId}, ${r.mv}, ${r.cb}, ${r.contribution}, ${reportingCurrency}, ${gapsFilled}, ${'cron'})`,
    ),
    // Whole-portfolio aggregate (account_id NULL → COALESCE(-1) in the index).
    sql`(${userId}, ${date}, NULL, ${totalMv}, ${totalCb}, ${totalContrib}, ${reportingCurrency}, ${gapsFilled}, ${'cron'})`,
  ];

  // The unique index is the EXPRESSION index (user_id, snap_date,
  // COALESCE(account_id, -1)) — a Drizzle onConflictDoUpdate on the bare columns
  // finds no matching constraint, so we keep raw SQL with the COALESCE conflict
  // target. Per-account ids are distinct and the aggregate is NULL→-1, so no two
  // rows in this single statement share a conflict key (which would otherwise
  // trip "ON CONFLICT … cannot affect row a second time").
  await db.execute(sql`
    INSERT INTO portfolio_snapshots (
      user_id, snap_date, account_id, market_value, cost_basis,
      net_contribution, currency, gaps_filled, source
    ) VALUES ${sql.join(valueTuples, sql`, `)}
    ON CONFLICT (user_id, snap_date, COALESCE(account_id, -1))
    DO UPDATE SET
      market_value = EXCLUDED.market_value,
      cost_basis = EXCLUDED.cost_basis,
      net_contribution = EXCLUDED.net_contribution,
      currency = EXCLUDED.currency,
      gaps_filled = EXCLUDED.gaps_filled
  `);

  // Suppress unused-import warning — gte is referenced for future windowed builds.
  void gte;

  return {
    userId,
    date,
    perAccountRows: accountRows.length,
    aggregateRow: true,
    gapsFilled,
  };
}
