/**
 * DEK-free cash-snapshot range builder (plan/net-worth-cash-snapshots.md Phase 3).
 *
 * Stores per-account daily CASH balances in `portfolio_snapshots`
 * (source='cash', one row per (account, day)) translated to the user's
 * reporting currency at EACH DAY'S historical FX rate — consistent with the
 * investment side, which already reads from stored snapshots. Without this,
 * the chart re-translated a live cumulative at TODAY'S rate on every load, so a
 * USD cash balance from 2023 drifted with current USD→CAD instead of standing
 * at its historical value.
 *
 * Key property: a cash balance is `cumulative SUM(transactions.amount)` + cached
 * FX — it needs NO DEK (unlike investment, which needs the DEK to decrypt
 * holding symbols for pricing). So this builder runs in the background cron and
 * the chart-load self-heal with no DEK, and is the cash twin of
 * `buildDailySnapshot` (which no-ops without a DEK).
 *
 * Single cumulative walk per account; writes the same idempotent UPSERT as
 * builder.ts on the `(user_id, snap_date, COALESCE(account_id, -1))` unique
 * index. NEVER writes the NULL whole-portfolio aggregate (that stays
 * investment-only — it feeds /portfolio TWRR/MWRR).
 */

import { db, schema } from "@/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  getCashDailyDeltasByAccount,
  getCashTxFingerprint,
} from "@/lib/queries";
import { getRate, prewarmRates } from "@/lib/fx-service";
import { resolveReportingCurrency } from "../../../../mcp-server/reporting-currency";
import { upsertCashSnapshotMeta } from "@/lib/portfolio/snapshots/cash-meta";
import { withOp } from "@/lib/diagnostics/op-context";

/**
 * Hard floor on how far back the walk will ever go — mirrors
 * `EARLIEST_REBUILD_DATE` in rebuild.ts (kept as a local literal so this file
 * has no import back onto rebuild.ts, which imports US). A single garbage/epoch-
 * dated cash row otherwise sends the day-by-day walk on a multi-decade march.
 * No supported account predates this floor.
 */
const EARLIEST_CASH_DATE = "2015-01-01";

export interface BuildCashSnapshotsInput {
  userId: string;
  /**
   * Start of the build window. `null`/omitted → full history (the account's
   * earliest cash tx, floored to EARLIEST_CASH_DATE). A concrete date bounds a
   * partial refresh (e.g. the cron's recent 90-day window). Either way the
   * effective start is clamped UP to the earliest cash tx so we never write
   * leading zero rows.
   */
  fromDate?: string | null;
  toDate: string; // YYYY-MM-DD
  reportingCurrency: string;
  /** Restrict to a single cash account (per-account chart rebuild). */
  accountId?: number;
}

export interface BuildCashSnapshotsResult {
  accountsProcessed: number;
  rowsWritten: number;
  gapsFilled: boolean;
}

function addDayUTC(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Account ids to EXCLUDE from the cash build: any account carrying a
 * `portfolio_holdings` row (legacy `account_id` link) or a `holding_accounts`
 * pairing — even an `is_investment=false` account that still has holdings (the
 * historically-misconfigured demo Brokerage). `buildDailySnapshot` writes an
 * investment (`source='cron'`) row for such accounts on the SAME
 * `(user, date, account_id)` unique key; a `source='cash'` row would collide
 * and flip the source by race. Skipping them also matches the dashboard-hero
 * is_investment partition. plan/net-worth-cash-snapshots.md Risk 1.
 */
async function holdingsAccountIds(userId: string): Promise<Set<number>> {
  const set = new Set<number>();
  const fromHoldings = await db
    .selectDistinct({ accountId: schema.portfolioHoldings.accountId })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.userId, userId),
        isNotNull(schema.portfolioHoldings.accountId),
      ),
    )
    .all();
  for (const r of fromHoldings) if (r.accountId != null) set.add(Number(r.accountId));
  const fromHa = await db
    .selectDistinct({ accountId: schema.holdingAccounts.accountId })
    .from(schema.holdingAccounts)
    .where(eq(schema.holdingAccounts.userId, userId))
    .all();
  for (const r of fromHa) set.add(Number(r.accountId));
  return set;
}

/**
 * Delete orphaned `source='cash'` snapshot rows — rows for accounts that should
 * have NO cash snapshots because they carry no cash transactions in scope (the
 * transactions were deleted, or the account was archived). `keepAccountIds` is
 * the set the cash builder is about to (re)write from live deltas; ANY other
 * account with a cash snapshot is stale.
 *
 * Unbounded by date: a transaction-less account has no legitimate cash snapshot
 * on ANY day. Scoped to `accountId` for a per-account rebuild; when
 * `keepAccountIds` is empty (no cash deltas at all) it removes every (scoped)
 * cash snapshot the user has. The UPSERT walk can only ever (over)write accounts
 * that HAVE deltas, so this delete is the ONLY reaper for stale cash balances —
 * without it a fully-deleted account's balance lingers forever and keeps feeding
 * the "Net Worth / Balance Over Time" chart's historical line.
 */
async function deleteOrphanCashSnapshots(
  userId: string,
  keepAccountIds: Set<number>,
  accountId?: number,
): Promise<void> {
  const accountScope = accountId != null ? sql` AND account_id = ${accountId}` : sql``;
  if (keepAccountIds.size === 0) {
    await db.execute(sql`
      DELETE FROM portfolio_snapshots
      WHERE user_id = ${userId} AND source = 'cash' AND account_id IS NOT NULL${accountScope}
    `);
    return;
  }
  const keepList = sql.join([...keepAccountIds].map((id) => sql`${id}`), sql`, `);
  await db.execute(sql`
    DELETE FROM portfolio_snapshots
    WHERE user_id = ${userId} AND source = 'cash' AND account_id IS NOT NULL${accountScope}
      AND account_id NOT IN (${keepList})
  `);
}

export async function buildCashSnapshots(
  input: BuildCashSnapshotsInput,
): Promise<BuildCashSnapshotsResult> {
  const { userId, accountId } = input;
  const reporting = input.reportingCurrency.trim().toUpperCase();
  const toDate = input.toDate;

  // Accounts with holdings are owned by the investment builder — skip them.
  const excluded = await holdingsAccountIds(userId);

  // Per-account per-day deltas over ALL history (the pre-start prefix folds into
  // the running cumulative on day 1, same pattern as buildNetWorthHistory).
  const deltas = await getCashDailyDeltasByAccount(userId, accountId);

  // Group deltas by account, dropping holdings accounts; track the global
  // earliest cash-tx date so the walk never writes leading zero rows.
  const byAccount = new Map<
    number,
    { currency: string; days: Array<{ date: string; delta: number }> }
  >();
  let earliestDelta: string | null = null;
  for (const d of deltas) {
    const accId = Number(d.accountId);
    if (Number.isNaN(accId)) continue;
    if (excluded.has(accId)) continue;
    let entry = byAccount.get(accId);
    if (!entry) {
      entry = { currency: String(d.currency).toUpperCase(), days: [] };
      byAccount.set(accId, entry);
    }
    entry.days.push({ date: d.date, delta: Number(d.delta) });
    if (earliestDelta == null || d.date < earliestDelta) earliestDelta = d.date;
  }

  // ─── Authoritative orphan cleanup ──────────────────────────────────────────
  // Reap any `source='cash'` snapshot row for an account NOT in `byAccount`
  // (no cash transactions in scope). Runs BEFORE the early-return so the
  // all-deleted case (byAccount empty) is cleaned too — the UPSERT walk below
  // only ever (re)writes accounts that HAVE deltas, so without this the stale
  // balance lingers forever and keeps feeding the chart's historical line.
  await deleteOrphanCashSnapshots(userId, new Set(byAccount.keys()), accountId);

  if (byAccount.size === 0 || earliestDelta == null) {
    return { accountsProcessed: 0, rowsWritten: 0, gapsFilled: false };
  }

  // Resolve the effective start: caller window (or full history), floored to
  // EARLIEST_CASH_DATE, then clamped UP to the earliest cash tx (no leading
  // zero rows) and DOWN to toDate.
  let start = input.fromDate ?? earliestDelta;
  if (start < EARLIEST_CASH_DATE) start = EARLIEST_CASH_DATE;
  if (start < earliestDelta) start = earliestDelta;
  if (start > toDate) start = toDate;

  // Pre-build the grid date list once (shared across accounts).
  const gridDates: string[] = [];
  {
    let d = start;
    let guard = 0;
    const MAX_DAYS = 30 * 366;
    while (d <= toDate && guard < MAX_DAYS) {
      gridDates.push(d);
      guard++;
      if (d === toDate) break;
      d = addDayUTC(d);
    }
  }

  // Best-effort prewarm: front-load each non-reporting currency's per-day
  // historical rate concurrently so the serial walk below hits a warm cache.
  // (getRate triangulates from→USD and to→USD, so warm both legs.) Bounded by
  // the FX fetchers' 4s timeout + negative cache (2026-06-03).
  const distinctCurrencies = new Set<string>([reporting]);
  for (const { currency } of byAccount.values()) distinctCurrencies.add(currency);
  if (distinctCurrencies.size > 1) {
    try {
      await prewarmRates([...distinctCurrencies], gridDates, userId);
    } catch {
      /* prewarm is purely an optimization — the walk re-fetches on miss */
    }
  }

  // Per-run FX cache keyed by (from>to@day); also remembers whether the lookup
  // FELL BACK so each row carries its OWN gaps_filled (NOT a sticky global).
  const fxCache = new Map<string, { rate: number; fellBack: boolean }>();
  let anyGaps = false;
  const fx = async (
    from: string,
    to: string,
    day: string,
  ): Promise<{ rate: number; fellBack: boolean }> => {
    if (from === to) return { rate: 1, fellBack: false };
    const key = `${from}>${to}@${day}`;
    const cached = fxCache.get(key);
    if (cached) return cached;
    let out: { rate: number; fellBack: boolean };
    try {
      const rate = await getRate(from, to, day, userId);
      out = rate ? { rate, fellBack: false } : { rate: 1, fellBack: true };
    } catch {
      out = { rate: 1, fellBack: true };
    }
    if (out.fellBack) anyGaps = true;
    fxCache.set(key, out);
    return out;
  };

  let accountsProcessed = 0;
  let rowsWritten = 0;

  for (const [accId, entry] of byAccount) {
    accountsProcessed++;
    entry.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Fold the pre-start prefix into the opening cumulative.
    let ptr = 0;
    let running = 0;
    while (ptr < entry.days.length && entry.days[ptr].date < start) {
      running += entry.days[ptr].delta;
      ptr++;
    }

    for (const day of gridDates) {
      // Fold in every delta on-or-before this grid day.
      while (ptr < entry.days.length && entry.days[ptr].date <= day) {
        running += entry.days[ptr].delta;
        ptr++;
      }
      const { rate, fellBack } = await fx(entry.currency, reporting, day);
      const mv = running * rate;
      // Verbatim UPSERT shape from builder.ts (COALESCE conflict target — the
      // unique index is an expression index, so Drizzle's onConflictDoUpdate on
      // bare columns finds no matching constraint). source='cash',
      // cost_basis=mv, net_contribution=0.
      await db.execute(sql`
        INSERT INTO portfolio_snapshots (
          user_id, snap_date, account_id, market_value, cost_basis,
          net_contribution, currency, gaps_filled, source
        ) VALUES (
          ${userId}, ${day}, ${accId}, ${mv}, ${mv},
          ${0}, ${reporting}, ${fellBack}, ${"cash"}
        )
        ON CONFLICT (user_id, snap_date, COALESCE(account_id, -1))
        DO UPDATE SET
          market_value = EXCLUDED.market_value,
          cost_basis = EXCLUDED.cost_basis,
          net_contribution = EXCLUDED.net_contribution,
          currency = EXCLUDED.currency,
          gaps_filled = EXCLUDED.gaps_filled,
          source = EXCLUDED.source
      `);
      rowsWritten++;
    }
  }

  return { accountsProcessed, rowsWritten, gapsFilled: anyGaps };
}

/**
 * Convenience orchestrator used by the rebuild endpoint, the cron, and the
 * chart-load self-heal: resolve the user's reporting currency, build cash
 * snapshots over the window, and (optionally) stamp the staleness watermark.
 *
 * When `stampMeta` is true the fingerprint is captured BEFORE the build, so a
 * cash write arriving mid-build leaves `meta < live` → the next chart load
 * re-heals (the watermark NEVER claims fresh for state the build didn't
 * include). Pass `stampMeta:false` for a partial refresh that must stay stale
 * (the cron's recent-window pass — see Phase 4) so a deep back-dated edit isn't
 * hidden from the full-history self-heal.
 */
export function rebuildCashSnapshots(opts: {
  userId: string;
  toDate: string;
  fromDate?: string | null;
  accountId?: number;
  stampMeta?: boolean;
}): Promise<BuildCashSnapshotsResult> {
  // Attribute the cash rebuild + its queries to 'rebuild:cash' (diagnostics).
  return withOp("rebuild:cash", () => rebuildCashSnapshotsImpl(opts));
}

async function rebuildCashSnapshotsImpl(opts: {
  userId: string;
  toDate: string;
  fromDate?: string | null;
  accountId?: number;
  stampMeta?: boolean;
}): Promise<BuildCashSnapshotsResult> {
  const reportingCurrency = await resolveReportingCurrency(db, opts.userId, undefined);
  const fp = opts.stampMeta ? await getCashTxFingerprint(opts.userId) : null;
  const result = await buildCashSnapshots({
    userId: opts.userId,
    fromDate: opts.fromDate ?? null,
    toDate: opts.toDate,
    reportingCurrency,
    accountId: opts.accountId,
  });
  if (opts.stampMeta && fp) {
    await upsertCashSnapshotMeta(opts.userId, fp, opts.toDate);
  }
  return result;
}
