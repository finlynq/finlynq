/**
 * Bank-ledger candidate pool builder (2026-05-23).
 *
 * Sibling to `pf-app/src/lib/external-import/duplicate-detect-pool.ts`. That
 * builder queries `transactions` because it serves the staged → tx duplicate
 * detector. The reconcile page flips direction: bank rows are the
 * CANDIDATES, transactions are the INPUTS. We need a separate builder
 * because:
 *   1. The source table is `bank_transactions` (different columns,
 *      different ciphertext envelope per row).
 *   2. Decryption is tier-aware — rows with `encryption_tier='service'`
 *      decrypt via `decryptStaged()` (PF_STAGING_KEY, sv1: envelope);
 *      `'user'` tier via `tryDecryptField(dek, ...)` (user DEK, v1:
 *      envelope). The existing builder only knows user-tier.
 *   3. The bank-ledger row id is a UUID `string`, not the `number` shape
 *      the existing builder returns.
 *
 * Pure read; no DB writes. The caller (match-engine) supplies the user id,
 * DEK (nullable on read paths per the auth gate convention), and the
 * account scope.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";

export interface BankCandidateRow {
  /** `bank_transactions.id` — UUID. */
  id: string;
  accountId: number;
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Signed amount in the account's native currency. */
  amount: number;
  currency: string;
  /** Plaintext payee (post tier-aware decrypt). null on auth-tag failure. */
  payeePlain: string | null;
  /** Always set on bank_transactions (NOT NULL column). */
  importHash: string;
  fitId: string | null;
}

export interface BankCandidatePool {
  /** Pool of bank-ledger rows, indexed by accountId for hot lookup. */
  byAccount: Map<number, BankCandidateRow[]>;
}

export interface BankPoolBuildInput {
  userId: string;
  /** DEK for user-tier row decryption. null is allowed; service-tier rows
   *  still decrypt via PF_STAGING_KEY, user-tier rows fall through to null. */
  dek: Buffer | null;
  /** Account ids to load. Caller deduplicates. */
  accountIds: number[];
}

/**
 * Load every `bank_transactions` row for the given accounts and decrypt
 * payee per-row using the row's `encryption_tier`. Returns an empty pool
 * when there are no account ids.
 *
 * Date scope: full history per account today. The reconcile page is a
 * per-account view and the bank ledger is bounded by how many statements
 * the user has uploaded; for the current target user base this stays
 * under a few thousand rows per account. If that grows we can add a
 * `dateMin`/`dateMax` window without breaking the call site.
 */
export async function buildBankLedgerCandidatePool(
  input: BankPoolBuildInput,
): Promise<BankCandidatePool> {
  const pool: BankCandidatePool = { byAccount: new Map() };
  if (input.accountIds.length === 0) return pool;

  const rows = await db
    .select({
      id: schema.bankTransactions.id,
      accountId: schema.bankTransactions.accountId,
      date: schema.bankTransactions.date,
      amount: schema.bankTransactions.amount,
      currency: schema.bankTransactions.currency,
      payee: schema.bankTransactions.payee,
      importHash: schema.bankTransactions.importHash,
      fitId: schema.bankTransactions.fitId,
      encryptionTier: schema.bankTransactions.encryptionTier,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.userId, input.userId),
        // `inArray` requires a non-empty array; guarded by the early-return
        // above when `accountIds.length === 0`.
        inArray(schema.bankTransactions.accountId, input.accountIds),
      ),
    )
    .all();

  for (const r of rows) {
    const tier = r.encryptionTier ?? "user";
    const payeePlain = decryptBankPayee(tier, input.dek, r.payee);
    const row: BankCandidateRow = {
      id: r.id,
      accountId: r.accountId,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      payeePlain,
      importHash: r.importHash,
      fitId: r.fitId,
    };
    const arr = pool.byAccount.get(r.accountId) ?? [];
    arr.push(row);
    pool.byAccount.set(r.accountId, arr);
  }
  return pool;
}

/**
 * Tier-aware decrypt for `bank_transactions.payee`. Mirrors the pattern in
 * `pf-app/src/app/api/import/bank-ledger/route.ts`.
 *
 * `tryDecryptField` returns null on auth-tag failure (load-bearing —
 * CLAUDE.md "Footgun"). On null we surface null to the caller; the fuzzy
 * scorer skips the payee-similarity hint for that row but can still match
 * on date + amount.
 */
function decryptBankPayee(
  tier: string,
  dek: Buffer | null,
  value: string | null,
): string | null {
  if (value == null) return null;
  if (tier === "user") {
    if (!dek) return null;
    return tryDecryptField(dek, value, "bank_transactions.payee");
  }
  // service tier
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}
