/**
 * Reconciliation summary (FINLYNQ-147, 2026-06-12).
 *
 * Per-account "what's up to date / what's stale" snapshot for the /import
 * reconcile surface. Everything here is DERIVED from existing tables — no
 * new column (per the item's lean):
 *
 *   - lastImportAt     = MAX(bank_upload_batches.uploaded_at) for the account.
 *                        The most recent statement/email/connector import.
 *   - lastReconciledAt = MAX(transactions.created_at) over rows whose
 *                        bank_transaction_id lineage FK is set (i.e. a bank
 *                        row was materialized into the ledger). This is the
 *                        last reconcile/materialize event.
 *   - pendingCount     = bank_transactions for the account with NO referencing
 *                        ledger transaction yet (unreconciled rows). Cheap
 *                        NOT EXISTS anti-join.
 *
 * Names are resolved by the API boundary (decrypt + safeAccountName), NOT
 * here — this core stays DEK-free.
 */

import { db, schema } from "@/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { computeReconcileForAccount } from "./match-engine";
import {
  computeAccountBalanceSummary,
  type BalanceSummaryAccount,
} from "./balance-summary";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";

export interface ReconcileSummaryRow {
  accountId: number;
  /** ISO timestamp of the most recent import batch, or null. */
  lastImportAt: string | null;
  /** ISO timestamp of the most recent materialize/reconcile event, or null. */
  lastReconciledAt: string | null;
  /** Count of bank-ledger rows not yet materialized into a ledger transaction. */
  pendingCount: number;
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  // pg may hand back a string already.
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Returns one summary row per account that has EITHER an import batch OR a
 * bank-ledger row. Accounts with no money-in activity are omitted (the UI
 * shows them implicitly as "no imports yet" only if it chooses to merge with
 * the full accounts list — callers decide). DEK-free.
 */
export async function getReconcileSummary(
  userId: string,
): Promise<ReconcileSummaryRow[]> {
  // Last import per account.
  const importRows = await db
    .select({
      accountId: schema.bankUploadBatches.accountId,
      lastImportAt: sql<
        string | null
      >`MAX(${schema.bankUploadBatches.uploadedAt})`.as("last_import_at"),
    })
    .from(schema.bankUploadBatches)
    .where(eq(schema.bankUploadBatches.userId, userId))
    .groupBy(schema.bankUploadBatches.accountId);

  // Last reconcile (materialize) event per account — transactions carrying a
  // bank_transaction_id lineage FK.
  const reconciledRows = await db
    .select({
      accountId: schema.transactions.accountId,
      lastReconciledAt: sql<
        string | null
      >`MAX(${schema.transactions.createdAt})`.as("last_reconciled_at"),
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        isNotNull(schema.transactions.bankTransactionId),
      ),
    )
    .groupBy(schema.transactions.accountId);

  // Pending (unreconciled) bank rows per account — no ledger transaction
  // references the bank row yet.
  const pendingRows = await db
    .select({
      accountId: schema.bankTransactions.accountId,
      pendingCount: sql<number>`COUNT(*)`.as("pending_count"),
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.userId, userId),
        sql`NOT EXISTS (SELECT 1 FROM transactions t WHERE t.bank_transaction_id = ${schema.bankTransactions.id})`,
      ),
    )
    .groupBy(schema.bankTransactions.accountId);

  const byAccount = new Map<number, ReconcileSummaryRow>();
  const ensure = (accountId: number | null): ReconcileSummaryRow | null => {
    if (accountId == null) return null;
    let row = byAccount.get(accountId);
    if (!row) {
      row = {
        accountId,
        lastImportAt: null,
        lastReconciledAt: null,
        pendingCount: 0,
      };
      byAccount.set(accountId, row);
    }
    return row;
  };

  for (const r of importRows) {
    const row = ensure(r.accountId);
    if (row) row.lastImportAt = toIso(r.lastImportAt);
  }
  for (const r of reconciledRows) {
    const row = ensure(r.accountId);
    if (row) row.lastReconciledAt = toIso(r.lastReconciledAt);
  }
  for (const r of pendingRows) {
    const row = ensure(r.accountId);
    if (row) row.pendingCount = Number(r.pendingCount) || 0;
  }

  return [...byAccount.values()];
}

// ─── Portfolio-wide reconcile health (FINLYNQ-215 / R-04) ─────────────────────
//
// A richer per-account aggregator built for the MCP `get_reconciliation_summary`
// tool: one row per account carrying the four reconcile-state counts plus the
// bank-vs-system balance check, so a session can read "what's up to date / what's
// off" across every account in ONE call instead of one get_reconcile_suggestions
// per account.
//
//   - linked / suggestions / bankOnly / txOnly — derived per account by REUSING
//     `computeReconcileForAccount` (the exact engine /import + get_reconcile_
//     suggestions use), so the counts are byte-identical to the detail view.
//   - balanceMismatch / balanceDelta / lastAnchorDate — from the SHARED
//     `computeAccountBalanceSummary`, the same code the /import reconcile header
//     calls. `balanceDelta` therefore EQUALS the header's delta verbatim.
//
// Investment accounts are EXCLUDED when no explicit accountIds are passed
// (investment reconcile is out of scope, doc §7). When `accountIds` IS passed,
// the caller's selection is honoured as-is (still owner-scoped).

export interface ReconciliationHealthRow {
  accountId: number;
  /** Encrypted at rest — left null here; resolved at the API/MCP boundary. */
  accountName: string | null;
  linked: number;
  suggestions: number;
  bankOnly: number;
  txOnly: number;
  /** true when the most-recent anchor disagrees with the calculated balance. */
  balanceMismatch: boolean;
  /** systemSideLatest − bankSideLatest (the /import header delta). null when
   *  the account has no balance anchor yet. */
  balanceDelta: number | null;
  /** Date (YYYY-MM-DD) of the most-recent balance anchor, or null. */
  lastAnchorDate: string | null;
  /** Account currency — the unit `balanceDelta` is expressed in. */
  currency: string;
  /** is_investment flag, surfaced so callers can label the row. */
  isInvestment: boolean;
}

export interface ReconciliationSummaryOptions {
  /** Restrict to these account ids (owner-scoped). Omit → all non-investment. */
  accountIds?: number[];
  /** Date floor on both tx + bank dates, in days back from today. Default 90 —
   *  mirrors get_reconcile_suggestions. */
  lookbackDays?: number;
}

/**
 * Portfolio-wide reconcile health, one row per in-scope account.
 *
 * `dek` is required to decrypt payees for the fuzzy match counts (mirrors
 * `computeReconcileForAccount`); a null DEK degrades the counts to "no fuzzy
 * match" rather than crashing. Account-name decryption is left to the caller.
 */
export async function getReconciliationSummary(
  userId: string,
  dek: Buffer | null,
  opts: ReconciliationSummaryOptions = {},
): Promise<ReconciliationHealthRow[]> {
  const lookbackDays = opts.lookbackDays ?? 90;
  const dateMin = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Resolve the in-scope accounts. Owner-scoped always. When accountIds is
  // omitted we exclude investment accounts (doc §7); when it's passed we honour
  // the caller's selection verbatim (still user-scoped via the WHERE).
  const whereClauses = [eq(schema.accounts.userId, userId)];
  if (opts.accountIds && opts.accountIds.length > 0) {
    whereClauses.push(inArray(schema.accounts.id, opts.accountIds));
  } else {
    whereClauses.push(eq(schema.accounts.isInvestment, false));
  }
  const accountRows = await db
    .select({
      id: schema.accounts.id,
      currency: schema.accounts.currency,
      isInvestment: schema.accounts.isInvestment,
    })
    .from(schema.accounts)
    .where(and(...whereClauses))
    .all();

  if (accountRows.length === 0) return [];

  // Pre-fetch the holdings-value map ONCE (covers all investment accounts in
  // scope) so each per-account balance summary doesn't recompute it.
  const hasInvestment = accountRows.some((a) => a.isInvestment);
  const holdingsByAccount = hasInvestment
    ? await getHoldingsValueByAccount(userId, dek)
    : undefined;

  const out = await Promise.all(
    accountRows.map(async (acct): Promise<ReconciliationHealthRow> => {
      const acctForBalance: BalanceSummaryAccount = {
        id: acct.id,
        currency: acct.currency,
        isInvestment: acct.isInvestment,
      };
      const [recon, balance] = await Promise.all([
        computeReconcileForAccount({
          userId,
          dek,
          accountId: acct.id,
          dateMin,
        }),
        computeAccountBalanceSummary(userId, dek, acctForBalance, holdingsByAccount),
      ]);
      return {
        accountId: acct.id,
        accountName: null,
        linked: recon.linked.length,
        suggestions: recon.suggestions.length,
        bankOnly: recon.bankOnly.length,
        txOnly: recon.txOnly.length,
        balanceMismatch: balance.status === "mismatch",
        balanceDelta: balance.delta,
        lastAnchorDate: balance.latestAnchor?.date ?? null,
        currency: acct.currency,
        isInvestment: acct.isInvestment,
      };
    }),
  );

  // Stable ordering by accountId so the result is deterministic.
  out.sort((a, b) => a.accountId - b.accountId);
  return out;
}
