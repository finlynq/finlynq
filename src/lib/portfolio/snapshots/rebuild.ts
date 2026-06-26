/**
 * Shared snapshot-rebuild walk loop (plan/net-worth-over-time.md Part B).
 *
 * Re-materializes daily `portfolio_snapshots` for one user from `fromDate`
 * (default: their earliest transaction) to `toDate` (default: today), one day
 * per `buildDailySnapshot` call (idempotent UPSERT). Extracted from
 * scripts/backfill-portfolio-snapshots.ts so the manual rebuild endpoint and
 * the auto-rebuild drain cron share the exact same logic as the admin script.
 *
 * `dek` may be null — market value needs no decrypted names.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { buildDailySnapshot } from "@/lib/portfolio/snapshots/builder";
import { rebuildCashSnapshots } from "@/lib/portfolio/snapshots/cash-builder";
import { withOp } from "@/lib/diagnostics/op-context";

export interface RebuildResult {
  fromDate: string;
  toDate: string;
  daysProcessed: number;
  gapsFilledDays: number;
}

/**
 * Per-user rebuild progress, observable from a FRESH mount / browser reload.
 *
 * Lives on `globalThis` (same HMR-resilient pattern as the DB adapter + MCP tx
 * cache) so it survives Next.js HMR AND a browser reload on the single-instance
 * deploy — no DB migration needed. The manual rebuild route now runs the walk
 * fire-and-forget and reports `{ daysProcessed, totalDays }` here per day; the
 * status endpoint reads this registry so both mount points can poll it and show
 * an in-flight rebuild that a reload would otherwise lose (FINLYNQ-205).
 */
export interface RebuildProgress {
  running: boolean;
  daysProcessed: number;
  totalDays: number;
  startedAt: number; // epoch ms
  finishedAt: number | null; // epoch ms, set when the walk ends (ok or error)
  lastResult: RebuildResult | null;
  error: string | null;
}

/**
 * Hard floor on how far back a rebuild will ever walk. A single garbage-dated
 * row — e.g. an opening-balance transaction left at the Unix epoch (1970-01-01)
 * because no date was entered — otherwise makes `MIN(transactions.date)` point
 * to 1970 and sends the day-by-day walk on a ~20,000-day march: it pegs CPU,
 * writes thousands of meaningless pre-history snapshots, and hits MAX_DAYS
 * before it ever reaches the real holdings. No supported account predates this
 * floor, so the start date is clamped up to it regardless of where `from` came
 * from (caller param, dirty marker, or the MIN(date) probe).
 */
export const EARLIEST_REBUILD_DATE = "2015-01-01";

// HMR-safe per-user in-flight + progress registry. Shared by the manual rebuild
// endpoint and the chart-load self-heal so a double-click / concurrent chart
// loads don't spawn overlapping walks for the same user. A user is "in flight"
// iff a registry entry exists with `running === true` — the entry lingers after
// completion (running:false + lastResult) so a status poll right after a rebuild
// finishes can still report the "Rebuilt N days" summary (FINLYNQ-205).
const g = globalThis as typeof globalThis & {
  __pfRebuildProgress?: Map<string, RebuildProgress>;
};
function progressMap(): Map<string, RebuildProgress> {
  if (!g.__pfRebuildProgress) g.__pfRebuildProgress = new Map();
  return g.__pfRebuildProgress;
}

/**
 * Returns true and marks the user in-flight (seeding a fresh progress entry), or
 * false if a rebuild is already running. The entry starts at 0/0 days; the walk
 * fills in `totalDays` + `daysProcessed` via `reportRebuildProgress`.
 */
export function tryBeginRebuild(userId: string): boolean {
  const m = progressMap();
  const cur = m.get(userId);
  if (cur?.running) return false;
  m.set(userId, {
    running: true,
    daysProcessed: 0,
    totalDays: 0,
    startedAt: Date.now(),
    finishedAt: null,
    lastResult: null,
    error: null,
  });
  return true;
}

/** Update the live day counters mid-walk. No-op if the user has no entry. */
export function reportRebuildProgress(
  userId: string,
  daysProcessed: number,
  totalDays: number,
): void {
  const cur = progressMap().get(userId);
  if (!cur) return;
  cur.daysProcessed = daysProcessed;
  cur.totalDays = totalDays;
}

/**
 * Mark the walk finished. Records the terminal `lastResult` (or `error`) and
 * flips `running` to false; the entry LINGERS so the next status poll surfaces
 * the completion summary before the row is eventually overwritten by the next
 * rebuild. Pass `result` on success, `error` on failure.
 */
export function endRebuild(
  userId: string,
  outcome?: { result?: RebuildResult; error?: string },
): void {
  const cur = progressMap().get(userId);
  if (!cur) return;
  cur.running = false;
  cur.finishedAt = Date.now();
  if (outcome?.result) {
    cur.lastResult = outcome.result;
    cur.daysProcessed = outcome.result.daysProcessed;
    if (cur.totalDays === 0) cur.totalDays = outcome.result.daysProcessed;
  }
  if (outcome?.error) cur.error = outcome.error;
}

export function isRebuildInFlight(userId: string): boolean {
  return progressMap().get(userId)?.running === true;
}

/** Snapshot of the user's current/last rebuild for the status endpoint. */
export function getRebuildProgress(userId: string): RebuildProgress | null {
  const cur = progressMap().get(userId);
  return cur ? { ...cur } : null;
}

/**
 * Cross-user snapshot of every current/last investment rebuild in the registry,
 * newest-activity first. Read-only — backs the /admin/system "Server Health"
 * view so an operator can see which users' snapshot rebuilds are (or just were)
 * burning CPU. The registry is per-process + in-memory, so this only reflects
 * the running server (cleared on restart), same as the other diagnostic buffers.
 */
export function getAllRebuildProgress(): Array<RebuildProgress & { userId: string }> {
  return [...progressMap().entries()]
    .map(([userId, p]) => ({ userId, ...p }))
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
}

// Parallel in-flight guard for the DEK-free CASH rebuild. Separate from the
// investment set so a long investment rebuild doesn't block a cash self-heal
// (and vice-versa); shared by the rebuild endpoint, the cron, and the
// chart-load cash self-heal so they don't double-build for the same user.
const gc = globalThis as typeof globalThis & { __pfCashRebuildInFlight?: Set<string> };
function cashInFlightSet(): Set<string> {
  if (!gc.__pfCashRebuildInFlight) gc.__pfCashRebuildInFlight = new Set();
  return gc.__pfCashRebuildInFlight;
}

/** Returns true and marks the user cash-in-flight, or false if one is running. */
export function tryBeginCashRebuild(userId: string): boolean {
  const s = cashInFlightSet();
  if (s.has(userId)) return false;
  s.add(userId);
  return true;
}

export function endCashRebuild(userId: string): void {
  cashInFlightSet().delete(userId);
}

export function isCashRebuildInFlight(userId: string): boolean {
  return cashInFlightSet().has(userId);
}

/** Cross-user list of in-flight cash rebuilds (for the /admin/system view). */
export function getCashRebuildsInFlight(): string[] {
  return [...cashInFlightSet()];
}

function addDayUTC(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day span between two `YYYY-MM-DD` strings (>= 1 when from <= to). */
export function dayspanInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.floor((b - a) / 86_400_000) + 1;
}

/**
 * Account ids that currently hold positions: the union of the legacy
 * `portfolio_holdings.account_id` link and the `holding_accounts` pairing —
 * exactly the set `buildDailySnapshot` (via getHoldingsValueByAccount) can write
 * an investment snapshot for. DEK-free (ids only). Mirrors `holdingsAccountIds`
 * in cash-builder.ts (kept local to avoid an import cycle: cash-builder imports
 * THIS module's in-flight guards).
 */
async function getHoldingAccountIds(userId: string): Promise<Set<number>> {
  const set = new Set<number>();
  const fromHoldings = await db
    .selectDistinct({ accountId: schema.portfolioHoldings.accountId })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.userId, userId),
        isNotNull(schema.portfolioHoldings.accountId),
      ),
    );
  for (const r of fromHoldings) if (r.accountId != null) set.add(Number(r.accountId));
  const fromHa = await db
    .selectDistinct({ accountId: schema.holdingAccounts.accountId })
    .from(schema.holdingAccounts)
    .where(eq(schema.holdingAccounts.userId, userId));
  for (const r of fromHa) set.add(Number(r.accountId));
  return set;
}

/**
 * Delete orphaned INVESTMENT snapshot rows (`source <> 'cash'` — the builder's
 * `'cron'` rows). `keepAccountIds` is the set of accounts that still hold
 * positions:
 *   - empty  → no positions anywhere; delete EVERY non-cash row INCLUDING the
 *     whole-portfolio NULL aggregate (the portfolio is gone, so is its history).
 *   - non-empty → delete only PER-ACCOUNT rows whose account no longer holds
 *     positions; the NULL aggregate is preserved (the walk keeps it current).
 * The UPSERT walk can only (over)write accounts that still have holdings, so
 * this is the only reaper for stale investment balances left behind when an
 * account's holdings/transactions are deleted.
 */
async function deleteInvestmentOrphanSnapshots(
  userId: string,
  keepAccountIds: Set<number>,
): Promise<void> {
  if (keepAccountIds.size === 0) {
    await db.execute(sql`
      DELETE FROM portfolio_snapshots
      WHERE user_id = ${userId} AND source <> 'cash'
    `);
    return;
  }
  const keepList = sql.join([...keepAccountIds].map((id) => sql`${id}`), sql`, `);
  await db.execute(sql`
    DELETE FROM portfolio_snapshots
    WHERE user_id = ${userId} AND source <> 'cash' AND account_id IS NOT NULL
      AND account_id NOT IN (${keepList})
  `);
}

export function rebuildPortfolioSnapshots(
  userId: string,
  fromDate?: string | null,
  toDate?: string | null,
  dek?: Buffer | null,
  onProgress?: (daysProcessed: number, totalDays: number) => void,
): Promise<RebuildResult> {
  // Attribute the whole walk (and every query it runs) to the
  // 'rebuild:investment' operation so the diagnostics rollup shows how much
  // wall-clock/CPU the net-worth rebuild consumes (the #1 background consumer).
  return withOp("rebuild:investment", () =>
    rebuildPortfolioSnapshotsImpl(userId, fromDate, toDate, dek, onProgress),
  );
}

async function rebuildPortfolioSnapshotsImpl(
  userId: string,
  fromDate?: string | null,
  toDate?: string | null,
  dek?: Buffer | null,
  onProgress?: (daysProcessed: number, totalDays: number) => void,
): Promise<RebuildResult> {
  const to = toDate ?? new Date().toISOString().slice(0, 10);

  // Discover the rebuild start when no explicit `from` is given. Use the
  // EARLIEST of (first transaction, first existing snapshot) so the walk +
  // orphan cleanup below cover any stale snapshot history. This is critical when
  // the user has DELETED transactions: MIN(transactions.date) alone would be
  // NULL — collapsing `from` to today — and the historical stale snapshot rows
  // would never be revisited (the chart keeps showing a phantom balance line).
  let from = fromDate ?? null;
  if (!from) {
    const txRow = await db
      .select({ minDate: sql<string | null>`MIN(${schema.transactions.date})` })
      .from(schema.transactions)
      .where(eq(schema.transactions.userId, userId));
    const snapRow = await db
      .select({ minDate: sql<string | null>`MIN(${schema.portfolioSnapshots.snapDate})` })
      .from(schema.portfolioSnapshots)
      .where(eq(schema.portfolioSnapshots.userId, userId));
    const candidates = [txRow[0]?.minDate ?? null, snapRow[0]?.minDate ?? null].filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
    from = candidates.length ? candidates.sort()[0] : to;
  }
  // Hard floor: never walk before EARLIEST_REBUILD_DATE, no matter where `from`
  // came from. Guards against epoch/garbage-dated rows producing a runaway
  // multi-decade walk (see the constant's doc comment).
  if (from && from < EARLIEST_REBUILD_DATE) from = EARLIEST_REBUILD_DATE;
  // Clamp a from-date past today to today (single-day rebuild).
  if (from > to) from = to;

  // Total days in the (clamped) walk — drives the determinate progress bar.
  const totalDays = dayspanInclusive(from, to);
  // Publish the denominator BEFORE the first (potentially slow, cold-cache) day
  // so the status registry immediately reports a determinate "day 0 of N". The
  // per-day onProgress below only fires AFTER each buildDailySnapshot returns, so
  // without this the UI sits on the indeterminate "starting…" state for the
  // entire duration of day 1 — which on a large, cold-cache account (many
  // holdings × historical pricing) is minutes, making a healthy run look hung
  // (FINLYNQ-205).
  onProgress?.(0, totalDays);

  // Accounts that currently hold positions (union of the legacy account_id link
  // and the holding_accounts pairing). buildDailySnapshot only ever writes
  // per-account investment rows for these; anything else with a non-cash
  // snapshot row is an ORPHAN (its holdings/transactions were deleted) that the
  // idempotent UPSERT can never overwrite — see deleteInvestmentOrphanSnapshots.
  const holdingAccountIds = await getHoldingAccountIds(userId);

  let daysProcessed = 0;
  let gapsFilledDays = 0;
  if (holdingAccountIds.size === 0) {
    // No positions remain anywhere → there is NO legitimate investment history.
    // Skip the walk (it would only write a zero whole-portfolio aggregate per
    // day) and purge every non-cash snapshot row (per-account AND the NULL
    // aggregate). This is the "deleted every holding" authoritative reset.
    await deleteInvestmentOrphanSnapshots(userId, holdingAccountIds);
    onProgress?.(totalDays, totalDays);
  } else {
    let day = from;
    // Guard against pathological input (≈30y of days).
    const MAX_DAYS = 30 * 366;
    let guard = 0;
    while (day <= to && guard < MAX_DAYS) {
      guard++;
      const result = await buildDailySnapshot({ userId, date: day, dek: dek ?? null });
      if (result.gapsFilled) gapsFilledDays++;
      daysProcessed++;
      // Emit incremental progress (status registry / future stream consumers).
      // Pure compute is untouched — this only reports the day counters.
      onProgress?.(daysProcessed, totalDays);
      if (day === to) break;
      day = addDayUTC(day);
    }
    // Authoritative cleanup: the walk just rebuilt every account that still has
    // holdings; any per-account non-cash row for an account NOT in that set is a
    // leftover the UPSERT could never overwrite. Reap it (the NULL aggregate is
    // preserved — the walk keeps it current over [from, to]).
    await deleteInvestmentOrphanSnapshots(userId, holdingAccountIds);
  }

  // Cash side (DEK-free): rebuild the per-account historical-FX cash snapshots
  // over FULL history (decoupled from the investment `from`, which may be a
  // recent dirty-marker date — a partial cash build would otherwise wrongly
  // claim the watermark fresh). Guarded by the separate cash in-flight set so a
  // concurrent chart-load cash self-heal doesn't double-build. Best-effort: a
  // cash failure must never fail the investment rebuild the caller awaited.
  if (tryBeginCashRebuild(userId)) {
    try {
      await rebuildCashSnapshots({ userId, fromDate: null, toDate: to, stampMeta: true });
    } catch (err) {

      console.warn(
        "[rebuild] cash snapshot build failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      endCashRebuild(userId);
    }
  }

  return { fromDate: from, toDate: to, daysProcessed, gapsFilledDays };
}
