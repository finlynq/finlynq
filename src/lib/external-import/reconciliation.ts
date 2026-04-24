// Post-import balance reconciliation: compare WP's
// `categorized_balance_account_currency` per account against Finlynq's
// SUM(amount) for the same account on-or-before a given date, surface
// mismatches, and optionally insert an opening-balance adjustment tx.

import { db, schema } from "@/db";
import { eq, and, lte, sql } from "drizzle-orm";
import { getAccounts } from "@/lib/queries";
import {
  wealthposition,
  WealthPositionApiError,
} from "@finlynq/import-connectors/wealthposition";
import { loadConnectorCredentials } from "@/lib/external-import/credentials";
import {
  loadConnectorMapping,
  type ConnectorMapping,
} from "@/lib/external-import/mapping";
import { generateImportHash } from "@/lib/import-hash";
import { encryptField } from "@/lib/crypto/envelope";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { WEALTHPOSITION_CONNECTOR_ID } from "@/lib/external-import/orchestrator";

export interface ReconciliationRow {
  externalAccountId: string;
  finlynqAccountId: number;
  accountName: string;
  currency: string;
  /** WP's reported balance in the account's native currency. */
  wpBalance: number;
  /** SUM(transactions.amount) where account_id = finlynqAccountId AND date <= date. */
  pfBalance: number;
  diff: number;
  matches: boolean;
}

export interface ReconciliationResult {
  date: string;
  rows: ReconciliationRow[];
  /** Accounts mapped but not present in WP's balance payload. */
  unmatchedExternal: string[];
}

const MATCH_TOLERANCE = 0.01;

export async function runWealthPositionReconciliation(
  userId: string,
  dek: Buffer,
  date: string,
): Promise<ReconciliationResult> {
  const creds = await loadConnectorCredentials<{ apiKey: string }>(
    userId,
    WEALTHPOSITION_CONNECTOR_ID,
    dek,
  );
  if (!creds?.apiKey) {
    throw new WealthPositionApiError(
      "AUTHENTICATION_ERROR",
      "No WealthPosition API key on file.",
      401,
    );
  }

  const mapping = await loadConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID);
  const client = wealthposition.createClient({ apiKey: creds.apiKey });
  const balances: Record<string, number> = client.getBalances
    ? await client.getBalances(date)
    : {};

  const pfAccounts = await getAccounts(userId, { includeArchived: true });
  const accountById = new Map(pfAccounts.map((a) => [a.id, a]));

  const rows: ReconciliationRow[] = [];
  const unmatchedExternal: string[] = [];

  for (const [externalId, pfAccountId] of Object.entries(mapping.accountMap)) {
    const wpBalance = balances[externalId];
    if (wpBalance === undefined) {
      unmatchedExternal.push(externalId);
      continue;
    }
    const pfAccount = accountById.get(pfAccountId);
    if (!pfAccount) continue;

    const sumRow = await db
      .select({ total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.accountId, pfAccountId),
          lte(schema.transactions.date, date),
        ),
      )
      .get();
    const pfBalance = Number(sumRow?.total ?? 0);
    const diff = wpBalance - pfBalance;

    rows.push({
      externalAccountId: externalId,
      finlynqAccountId: pfAccountId,
      accountName: pfAccount.name,
      currency: pfAccount.currency,
      wpBalance,
      pfBalance,
      diff,
      matches: Math.abs(diff) < MATCH_TOLERANCE,
    });
  }

  return { date, rows, unmatchedExternal };
}

/**
 * Insert a single dated transaction into the given account so that
 * SUM(amount) becomes `targetBalance`. Used by the reconciliation dialog's
 * "Add opening-balance adjustment" button.
 */
export async function insertOpeningBalanceAdjustment(
  userId: string,
  dek: Buffer,
  params: {
    finlynqAccountId: number;
    /** ISO (YYYY-MM-DD) — typically the user's earliest account open date. */
    date: string;
    /** Positive/negative amount equal to the reconciliation diff. */
    amount: number;
    /** Optional — use the mapping's openingBalanceCategoryId if omitted. */
    categoryId?: number | null;
    mapping?: ConnectorMapping;
  },
): Promise<{ inserted: boolean; transactionId?: number; reason?: string }> {
  const mapping =
    params.mapping ?? (await loadConnectorMapping(userId, WEALTHPOSITION_CONNECTOR_ID));
  const categoryId = params.categoryId ?? mapping.openingBalanceCategoryId ?? null;

  const pfAccounts = await getAccounts(userId, { includeArchived: true });
  const account = pfAccounts.find((a) => a.id === params.finlynqAccountId);
  if (!account) return { inserted: false, reason: "Account not found." };

  const payee = "Opening balance adjustment";
  const importHash = generateImportHash(
    params.date,
    params.finlynqAccountId,
    params.amount,
    payee,
  );

  // Don't insert twice for the same diff on the same account.
  const existing = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.importHash, importHash),
      ),
    )
    .get();
  if (existing?.id) {
    return { inserted: false, transactionId: existing.id, reason: "Adjustment already exists." };
  }

  const payeeCipher = encryptField(dek, payee) ?? "";
  const noteCipher = encryptField(dek, "Matches WealthPosition balance after sync") ?? "";
  const inserted = await db
    .insert(schema.transactions)
    .values({
      userId,
      date: params.date,
      accountId: params.finlynqAccountId,
      categoryId,
      currency: account.currency,
      amount: params.amount,
      payee: payeeCipher,
      note: noteCipher,
      tags: "",
      importHash,
    })
    .returning({ id: schema.transactions.id })
    .get();

  invalidateUserTxCache(userId);

  return { inserted: true, transactionId: inserted?.id };
}
