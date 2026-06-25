/**
 * Bank balance anchor validation + retrieval (2026-05-24).
 *
 * An "anchor" is the bank's reported balance for an account on a given
 * date. Anchors live on `bank_daily_balances`, keyed by
 * (user_id, account_id, date). Sources today:
 *   - 'csv_column'     — last-in-file-order row's Balance value per date
 *   - 'ofx_ledgerbal'  — OFX/QFX <LEDGERBAL><BALAMT> + <DTASOF>
 *   - 'upload_form'    — user-typed statement balance + date
 *   - 'mcp_manual'    — Claude-authored anchor via the MCP upsert_balance_anchor tool
 * Reserved future sources: 'email', 'connector', 'backup_restore'.
 *
 * Validation algorithm (checkpoint-style — user decision 2026-05-22):
 *   For each new anchor in the batch (sorted ascending by date):
 *     1. Find the most-recent prior anchor for this (user, account).
 *        If none, skip — first anchor anchors, nothing before it.
 *     2. Sum bank-row amounts strictly between (prior.date, new.date].
 *        Source: existing `bank_transactions` rows + projected rows from
 *        the staged batch that are about to be inserted.
 *     3. Expected = prior.balance + sum. Compare to new.balance.
 *        Float tolerance: 0.005. Larger delta => mismatch.
 *
 * Errors do NOT compound forward — each anchor is validated against the
 * immediately-prior anchor, NOT a recomputed running total from day zero.
 * If period N-1 had a $50 mismatch, period N still validates against
 * period N-1's anchor; the $50 error stays local to N-1. Rationale: the
 * user can revisit and fix period N-1 later; we don't want to flood the
 * UI with cascading warnings on every future statement.
 *
 * Source of truth for the anchor enum lives here. Keep in sync with the
 * SQL CHECK in `scripts/migrations/20260524_bank-daily-balances.sql`.
 */

import { db, schema } from "@/db";
import { and, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";

export const ANCHOR_SOURCES = [
  "csv_column",
  "ofx_ledgerbal",
  "upload_form",
  "email",
  "connector",
  "backup_restore",
  // FINLYNQ-217 (R-03) — a Claude-authored anchor created/corrected via the
  // MCP upsert_balance_anchor tool, outside the staged-import flow. Kept in
  // sync with the SQL CHECK in scripts/migrations/20260625b_balance_anchor_mcp_source.sql.
  "mcp_manual",
] as const;
export type AnchorSource = (typeof ANCHOR_SOURCES)[number];

export interface BalanceAnchor {
  date: string; // YYYY-MM-DD
  balance: number;
  currency: string;
  source: AnchorSource;
}

export interface BalanceMismatch {
  /** Anchor date that didn't match its prior anchor + intervening sum. */
  date: string;
  /** Expected = priorAnchor.balance + Σ(amount between prior.date+1 .. this.date). */
  expected: number;
  /** What the imported anchor says the balance was on `date`. */
  actual: number;
  /** actual - expected. Signed; positive means the bank says we have MORE
   *  than our rows imply (likely missing a credit / extra debit). */
  delta: number;
  /** Date of the prior anchor used for the comparison. Always set —
   *  anchors with no prior anchor are skipped, not surfaced as mismatches. */
  priorAnchorDate: string;
  priorAnchorBalance: number;
  /** Sum of amounts walked between (priorAnchorDate, date]. */
  intervalSum: number;
}

/** Single projected bank row about to be INSERTed by the approve step.
 *  Mirrors the shape passed to `upsertBankTransaction` — only the two
 *  fields the running-balance walk needs. */
export interface ProjectedBankRow {
  date: string; // YYYY-MM-DD
  amount: number;
}

/** Float tolerance for "balanced" check. 0.5¢ matches the threshold
 *  used by other balance code (see e.g. queries.ts account-balance). */
const EPSILON = 0.005;

/**
 * Validate a set of new balance anchors against the existing bank-ledger
 * for an account. Returns mismatches in date-ascending order. Empty
 * array means every anchor checks out (or has no prior anchor).
 *
 * Pure: no DB writes. The approve route inserts anchors AFTER this
 * helper returns success — the helper exists so a mismatch can be
 * surfaced as a banner before the user commits.
 */
export async function validateBankBalances(
  userId: string,
  accountId: number,
  newAnchors: BalanceAnchor[],
  projectedRows: ProjectedBankRow[],
): Promise<BalanceMismatch[]> {
  if (newAnchors.length === 0) return [];

  // Sort defensively — caller may pass in any order. ASC by date so the
  // checkpoint walk progresses chronologically.
  const sorted = [...newAnchors].sort((a, b) => a.date.localeCompare(b.date));

  // Pre-load every existing anchor on or before the latest new anchor's
  // date (we need them to look up "prior anchor" without per-row queries).
  // ON DELETE CASCADE on the FK means this returns only this user's data.
  const latestNew = sorted[sorted.length - 1].date;
  const existing = await db
    .select({
      date: schema.bankDailyBalances.date,
      balance: schema.bankDailyBalances.balance,
    })
    .from(schema.bankDailyBalances)
    .where(and(
      eq(schema.bankDailyBalances.userId, userId),
      eq(schema.bankDailyBalances.accountId, accountId),
      lte(schema.bankDailyBalances.date, latestNew),
    ))
    .orderBy(schema.bankDailyBalances.date)
    .all();

  // Sorted ASC. To find the prior anchor for date D, take the last entry
  // whose date < D.
  function findPriorAnchor(d: string): { date: string; balance: number } | null {
    let prior: { date: string; balance: number } | null = null;
    for (const a of existing) {
      if (a.date < d) prior = a;
      else break;
    }
    return prior;
  }

  // Pre-load every bank_transactions amount in the relevant window. The
  // window spans from the earliest prior anchor's date+1 (exclusive) to
  // the latest new anchor's date (inclusive). When no prior anchor
  // exists for ANY new anchor, the window collapses to nothing — every
  // new anchor in that batch is unvalidated.
  const earliestPrior = (() => {
    let lo: string | null = null;
    for (const n of sorted) {
      const p = findPriorAnchor(n.date);
      if (!p) continue;
      if (lo == null || p.date < lo) lo = p.date;
    }
    return lo;
  })();

  let bankRows: Array<{ date: string; amount: number }> = [];
  if (earliestPrior != null) {
    bankRows = await db
      .select({
        date: schema.bankTransactions.date,
        amount: schema.bankTransactions.amount,
      })
      .from(schema.bankTransactions)
      .where(and(
        eq(schema.bankTransactions.userId, userId),
        eq(schema.bankTransactions.accountId, accountId),
        gt(schema.bankTransactions.date, earliestPrior),
        lte(schema.bankTransactions.date, latestNew),
      ))
      .all();
  }

  // Combined per-day amount index = existing bank rows + projected rows.
  // Projected rows are about to be INSERTed; they're the "what would
  // happen if I approve" preview.
  const combined: Array<{ date: string; amount: number }> = [
    ...bankRows,
    ...projectedRows,
  ];

  const mismatches: BalanceMismatch[] = [];
  for (const n of sorted) {
    const prior = findPriorAnchor(n.date);
    if (!prior) continue; // No prior anchor — skip per user decision.
    let intervalSum = 0;
    for (const r of combined) {
      if (r.date > prior.date && r.date <= n.date) {
        intervalSum += r.amount;
      }
    }
    const expected = prior.balance + intervalSum;
    const delta = n.balance - expected;
    if (Math.abs(delta) > EPSILON) {
      mismatches.push({
        date: n.date,
        expected,
        actual: n.balance,
        delta,
        priorAnchorDate: prior.date,
        priorAnchorBalance: prior.balance,
        intervalSum,
      });
    }
  }

  return mismatches;
}

/**
 * Upsert anchors into bank_daily_balances. ON CONFLICT (user, account,
 * date) DO UPDATE — newer balance wins, last_seen_at bumps,
 * source_filenames appends the new filename. Load-bearing per CLAUDE.md
 * "Bank balance anchors".
 *
 * Idempotent: re-running with the same anchors is a no-op (the
 * filename array_append uses ON CONFLICT with the EXCLUDED row's
 * sole filename — duplicates are tolerated in v1; if dedup becomes
 * important we can switch to array_distinct + uniq).
 */
export async function upsertBankBalanceAnchors(
  userId: string,
  accountId: number,
  anchors: BalanceAnchor[],
  filename: string | null,
  uploadBatchId?: string | null,
): Promise<void> {
  if (anchors.length === 0) return;
  const rows = anchors.map((a) => ({
    userId,
    accountId,
    date: a.date,
    balance: a.balance,
    currency: a.currency,
    source: a.source,
    sourceFilenames: filename ? [filename] : [],
    // Phase 1 of import-modes refactor (2026-05-25) — anchor lineage to the
    // upload batch. NULL for legacy paths. On conflict the existing value
    // is overwritten (anchors are content-immutable per-date EXCEPT for the
    // batch lineage which tracks the most-recent ingest that touched them).
    uploadBatchId: uploadBatchId ?? null,
  }));
  // Drizzle PG supports onConflictDoUpdate with target columns. Re-import
  // semantics: newer balance wins, last_seen_at bumps, source_filenames
  // grows — a corrected re-download from the bank overwrites cleanly.
  // Load-bearing per CLAUDE.md "Bank balance anchors".
  await db
    .insert(schema.bankDailyBalances)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        schema.bankDailyBalances.userId,
        schema.bankDailyBalances.accountId,
        schema.bankDailyBalances.date,
      ],
      set: {
        balance: sql`EXCLUDED.balance`,
        currency: sql`EXCLUDED.currency`,
        source: sql`EXCLUDED.source`,
        lastSeenAt: sql`NOW()`,
        sourceFilenames: sql`array_append(bank_daily_balances.source_filenames, EXCLUDED.source_filenames[1])`,
        // Track the most-recent ingest that touched this anchor so Phase 4's
        // batch-undo can remove the corresponding row.
        uploadBatchId: sql`COALESCE(EXCLUDED.upload_batch_id, bank_daily_balances.upload_batch_id)`,
      },
    });
}

/**
 * Load the most recent anchor for an account. Returns null when the
 * account has no anchors yet. Used by the /reconcile header to show
 * "Bank says (as of YYYY-MM-DD): $X".
 */
export async function getLatestBankAnchor(
  userId: string,
  accountId: number,
): Promise<{ date: string; balance: number; source: string; currency: string } | null> {
  const row = await db
    .select({
      date: schema.bankDailyBalances.date,
      balance: schema.bankDailyBalances.balance,
      source: schema.bankDailyBalances.source,
      currency: schema.bankDailyBalances.currency,
    })
    .from(schema.bankDailyBalances)
    .where(and(
      eq(schema.bankDailyBalances.userId, userId),
      eq(schema.bankDailyBalances.accountId, accountId),
    ))
    .orderBy(desc(schema.bankDailyBalances.date))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * List every anchor for an account, ordered by date DESC. Used by the
 * bank-ledger route to enrich per-row Balance cells with the actual
 * loaded anchor value alongside the computed running balance — so the
 * user can sanity-check that anchors match the running sum on dates
 * where the bank reported a balance.
 */
export async function listBankAnchors(
  userId: string,
  accountId: number,
): Promise<Array<{ date: string; balance: number; source: string; currency: string }>> {
  return await db
    .select({
      date: schema.bankDailyBalances.date,
      balance: schema.bankDailyBalances.balance,
      source: schema.bankDailyBalances.source,
      currency: schema.bankDailyBalances.currency,
    })
    .from(schema.bankDailyBalances)
    .where(and(
      eq(schema.bankDailyBalances.userId, userId),
      eq(schema.bankDailyBalances.accountId, accountId),
    ))
    .orderBy(desc(schema.bankDailyBalances.date))
    .all();
}

/**
 * Sum bank_transactions.amount for rows strictly AFTER the given date,
 * within the account. Used to project from the latest anchor forward to
 * the current bank-side balance.
 */
export async function sumBankAmountsAfter(
  userId: string,
  accountId: number,
  afterDate: string,
): Promise<number> {
  const rows = await db
    .select({
      amount: schema.bankTransactions.amount,
    })
    .from(schema.bankTransactions)
    .where(and(
      eq(schema.bankTransactions.userId, userId),
      eq(schema.bankTransactions.accountId, accountId),
      gt(schema.bankTransactions.date, afterDate),
    ))
    .all();
  return rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
}

/**
 * Sum bank_transactions.amount for every row in the account (no date
 * filter). Used when the account has no anchor yet — the bank-side
 * total is just Σ(amount) starting from 0. Result is unvalidated until
 * the user uploads a statement with a balance.
 */
export async function sumAllBankAmounts(
  userId: string,
  accountId: number,
): Promise<number> {
  const rows = await db
    .select({
      amount: schema.bankTransactions.amount,
    })
    .from(schema.bankTransactions)
    .where(and(
      eq(schema.bankTransactions.userId, userId),
      eq(schema.bankTransactions.accountId, accountId),
    ))
    .all();
  return rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
}

/** One anchor row, with its created-at timestamp, as returned to MCP callers. */
export interface BalanceAnchorRow {
  date: string; // YYYY-MM-DD
  balance: number;
  currency: string;
  source: string;
  /** first_seen_at — when the anchor row was first created. */
  firstSeenAt: Date;
}

/**
 * List every anchor for an account ordered by date DESC, optionally bounded by
 * an inclusive [dateMin, dateMax] window. Unlike `listBankAnchors` this also
 * returns `firstSeenAt` (the row's created-at) so the MCP get_balance_anchors
 * tool can surface `createdAt`. FINLYNQ-217 (R-03).
 */
export async function listBankAnchorsInRange(
  userId: string,
  accountId: number,
  dateMin?: string | null,
  dateMax?: string | null,
): Promise<BalanceAnchorRow[]> {
  const conds = [
    eq(schema.bankDailyBalances.userId, userId),
    eq(schema.bankDailyBalances.accountId, accountId),
  ];
  if (dateMin != null) conds.push(gte(schema.bankDailyBalances.date, dateMin));
  if (dateMax != null) conds.push(lte(schema.bankDailyBalances.date, dateMax));
  const rows = await db
    .select({
      date: schema.bankDailyBalances.date,
      balance: schema.bankDailyBalances.balance,
      currency: schema.bankDailyBalances.currency,
      source: schema.bankDailyBalances.source,
      firstSeenAt: schema.bankDailyBalances.firstSeenAt,
    })
    .from(schema.bankDailyBalances)
    .where(and(...conds))
    .orderBy(desc(schema.bankDailyBalances.date))
    .all();
  return rows.map((r) => ({
    date: r.date,
    balance: Number(r.balance),
    currency: r.currency,
    source: r.source,
    firstSeenAt: r.firstSeenAt as Date,
  }));
}

/**
 * Upsert a SINGLE manual balance anchor (one (user, account, date) key) and
 * report whether the row was inserted (true) vs updated (false). Backs the MCP
 * upsert_balance_anchor tool (FINLYNQ-217 / R-03).
 *
 * Distinct from `upsertBankBalanceAnchors` (the import path): this stamps
 * `source='mcp_manual'`, sets an EMPTY `source_filenames` (no statement file),
 * and returns the created flag. The empty array means no filename append on
 * conflict — a manual anchor has no source file.
 *
 * `created` is derived from the system column `xmax`: PostgreSQL sets xmax=0 on
 * a freshly INSERTed tuple, so `(xmax = 0)` distinguishes the INSERT branch of
 * ON CONFLICT from the UPDATE branch in a single round-trip (no pre-existence
 * SELECT needed).
 *
 * The reconcile balance check reads the latest anchor live
 * (`computeAccountBalanceSummary` → `getLatestBankAnchor`), so an upsert here
 * is immediately reflected in get_reconcile_suggestions / get_reconciliation_summary.
 */
export async function upsertManualBankAnchor(
  userId: string,
  accountId: number,
  date: string,
  balance: number,
  currency: string,
): Promise<{ created: boolean }> {
  const res = await db.execute(sql`
    INSERT INTO bank_daily_balances
      (user_id, account_id, date, balance, currency, source, source_filenames,
       first_seen_at, last_seen_at)
    VALUES
      (${userId}, ${accountId}, ${date}, ${balance}, ${currency}, 'mcp_manual',
       ARRAY[]::text[], NOW(), NOW())
    ON CONFLICT (user_id, account_id, date) DO UPDATE SET
      balance = EXCLUDED.balance,
      currency = EXCLUDED.currency,
      source = 'mcp_manual',
      last_seen_at = NOW()
    RETURNING (xmax = 0) AS inserted
  `);
  const rows = normalizeDbRows<{ inserted: boolean }>(res);
  return { created: rows[0]?.inserted === true };
}

