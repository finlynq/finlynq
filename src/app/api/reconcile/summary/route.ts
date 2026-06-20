/**
 * GET /api/reconcile/summary — per-account reconciliation summary
 * (FINLYNQ-147, 2026-06-12; FINLYNQ-184, 2026-06-17).
 *
 * Powers the "what's up to date / what's stale" panel on /import. Each row:
 *   { accountId, accountName, currency, lastImportAt, lastReconciledAt, pendingCount }
 *
 * Archived accounts and accounts in reconcile_hidden_accounts are excluded
 * (FINLYNQ-184). The user has intentionally tucked these away; surfacing them
 * in the summary would clutter the panel with accounts they don't manage here.
 *
 * All money-in figures are DERIVED from existing tables (bank_upload_batches +
 * transactions.bank_transaction_id lineage + bank_transactions anti-join) — no
 * new column. Account names are decrypted at this boundary; the summary core
 * stays DEK-free. Reads use requireAuth (nullable DEK) per the read/write split.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getAccounts, getAccountBalances } from "@/lib/queries";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { safeAccountName } from "@/lib/safe-name";
import { getReconcileSummary } from "@/lib/reconcile/summary";
import { getReconcileHiddenAccountIds } from "@/lib/reconcile/hidden-accounts";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { applyInvestmentMarketOverlay } from "../../../../../mcp-server/investment-balance-overlay";
import { safeErrorMessage, logApiError } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;

  try {
    // Exclude archived accounts — they've been intentionally closed off.
    const rawAccounts = await getAccounts(userId);
    // decryptNamedRows writes the decrypted `name`/`alias` onto the rows at
    // runtime (the plaintext columns were physically dropped in Stream D
    // Phase 4, so they're not in the static row type — cast through unknown,
    // mirroring how /api/accounts ships the same shape to JSON).
    const accounts = decryptNamedRows(rawAccounts, dek, {
      nameCt: "name",
      aliasCt: "alias",
    }) as unknown as Array<{
      id: number;
      name: string | null;
      alias?: string | null;
      currency: string;
      isInvestment?: boolean;
    }>;

    // Raw ledger balance per account — COALESCE(SUM(transactions.amount), 0).
    // For investment accounts this is net contributions, NOT market value; the
    // overlay below marks those to market (FINLYNQ-196).
    const ledgerBalances = await getAccountBalances(userId);

    const [summary, hidden] = await Promise.all([
      getReconcileSummary(userId),
      getReconcileHiddenAccountIds(userId),
    ]);
    const summaryByAccount = new Map(summary.map((s) => [s.accountId, s]));
    const hiddenSet = new Set(hidden);

    // Current balance per account, following the load-bearing invariant
    // "Account balance for accounts with holdings = holdings.value". Investment
    // accounts are marked to MARKET via the SAME overlay the MCP balance tools
    // use (applyInvestmentMarketOverlay, FINLYNQ-151) — never a naive
    // SUM(transactions.amount). This is a web-session route (requireAuth, DEK
    // present), so the overlay can price holdings; a DEK-null caller degrades
    // to the ledger balance per the overlay's own guard. Cash accounts keep
    // their ledger balance. Each balance is displayed in the account's OWN
    // currency client-side (formatCurrency) — no cross-currency conversion.
    const overlay = await applyInvestmentMarketOverlay(
      ledgerBalances.map((b) => ({
        id: b.accountId,
        currency: b.currency,
        isInvestment: b.isInvestment === true,
        ledgerBalance: Number(b.balance),
      })),
      dek,
      () => getHoldingsValueByAccount(userId, dek),
    );
    const balanceByAccount = new Map(
      overlay.rows.map((r) => [r.id, r.balance]),
    );

    // Filter out hidden accounts (user tucked them out of the dropdown via
    // /settings/import). Archived accounts are already excluded by not passing
    // { includeArchived: true } above (FINLYNQ-184).
    const rows = accounts
      .filter((a) => !hiddenSet.has(a.id))
      .map((a) => {
        const s = summaryByAccount.get(a.id);
        return {
          accountId: a.id,
          accountName: safeAccountName(a),
          currency: a.currency,
          currentBalance: balanceByAccount.get(a.id) ?? 0,
          lastImportAt: s?.lastImportAt ?? null,
          lastReconciledAt: s?.lastReconciledAt ?? null,
          pendingCount: s?.pendingCount ?? 0,
        };
      });

    return NextResponse.json({ rows });
  } catch (error: unknown) {
    await logApiError("GET", "/api/reconcile/summary", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load reconcile summary") },
      { status: 500 },
    );
  }
}
