/**
 * Write parsed email rows into the staging queue for user review.
 *
 * Given RawTransaction[] from parseResendAttachments(), creates:
 *   - one row in staged_imports (metadata + totals + expiry)
 *   - N rows in staged_transactions (flat, plaintext, 14-day TTL)
 *
 * Dedup against existing `transactions` is best-effort: we only check rows
 * whose `account` name resolves to an existing account (needed for the
 * generateImportHash signature). Unresolvable rows stay isDuplicate=false
 * and get a real dedup check at approve time.
 *
 * Rows land PLAINTEXT because the user isn't logged in when the email
 * arrives. When they approve at /import/pending, rows move into the
 * encrypted `transactions` table with their session DEK and the staged
 * copy is deleted. See Research/email-import-resend-plan.md.
 */

import { randomUUID } from "crypto";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { generateImportHash } from "@/lib/import-hash";
import { normalizeDate, parseAmount as parseAmountStr } from "@/lib/csv-parser";
import type { RawTransaction } from "@/lib/import-pipeline";
import { encryptStaged } from "@/lib/crypto/staging-envelope";

export interface StageEmailImportInput {
  userId: string;
  rows: RawTransaction[];
  source: "email" | "upload";
  fromAddress?: string | null;
  subject?: string | null;
  svixId?: string | null;
}

export interface StageEmailImportResult {
  stagedImportId: string;
  totalRowCount: number;
  duplicateCount: number;
  /** true if the svix_id collided with an existing row — nothing was inserted. */
  alreadyProcessed: boolean;
}

/** 60 days as ms. Bumped from 14d on 2026-05-06 alongside the login-time
 *  service→user encryption upgrade — rows convert to user-DEK as soon as
 *  the user is active, so the longer plaintext-equivalent window is bounded
 *  by the user's login cadence, not the full 60d. */
const STAGE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export async function stageEmailImport(
  input: StageEmailImportInput,
): Promise<StageEmailImportResult> {
  const { userId, rows, source, fromAddress, subject, svixId } = input;

  // Idempotency — Resend retries on 5xx. If we've seen this svix_id already,
  // surface the existing row instead of duplicating.
  if (svixId) {
    const existing = await db
      .select({ id: schema.stagedImports.id })
      .from(schema.stagedImports)
      .where(eq(schema.stagedImports.svixId, svixId))
      .get();
    if (existing?.id) {
      return {
        stagedImportId: existing.id,
        totalRowCount: 0,
        duplicateCount: 0,
        alreadyProcessed: true,
      };
    }
  }

  // Build accountName → accountId map for this user so we can compute real
  // import_hashes for the rows whose account resolves.
  // Stream D Phase 4 — plaintext name dropped; ciphertext only. Email import
  // happens without a session DEK (it's a webhook), so name resolution falls
  // back to "no match" — staged rows for those accounts fail to bind.
  const userAccounts = await db
    .select({ id: schema.accounts.id, nameCt: schema.accounts.nameCt })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .all();
  // Empty map by name — webhook has no DEK so it can't decrypt. Email-import
  // staging doesn't bind to accounts at write time anyway; the user resolves
  // the binding at /import/pending review time, with their session DEK.
  const accountIdByName = new Map<string, number>();
  void userAccounts; // kept for future webhook-with-DEK enrichment

  // First pass: compute hash + normalize, gather the hash set for dedup.
  interface Prepared {
    date: string;
    amount: number;
    payee: string;
    category?: string;
    accountName?: string;
    note?: string;
    currency?: string;
    rowIndex: number;
    importHash: string;
    hasResolvedAccount: boolean;
  }
  const prepared: Prepared[] = [];
  const hashesToCheck: string[] = [];

  rows.forEach((r, i) => {
    const date = normalizeDate(r.date) || r.date;
    const amount = typeof r.amount === "number" ? r.amount : parseAmountStr(String(r.amount));
    const payee = (r.payee || "").trim();
    const accountId = r.account ? accountIdByName.get(r.account) : undefined;
    // When account doesn't resolve, use a sentinel so hashes don't collide
    // with real rows; dedup flag will be false until approve-time.
    const hashAccountId = accountId ?? 0;
    const hash = generateImportHash(date, hashAccountId, amount, payee);
    if (accountId !== undefined) hashesToCheck.push(hash);
    prepared.push({
      date,
      amount,
      payee,
      category: r.category,
      accountName: r.account,
      note: r.note,
      currency: r.currency,
      rowIndex: i,
      importHash: hash,
      hasResolvedAccount: accountId !== undefined,
    });
  });

  // Second pass: check the resolvable hashes against existing transactions
  // (scoped to this user).
  const existingHashes = new Set<string>();
  if (hashesToCheck.length > 0) {
    const batchSize = 900;
    for (let i = 0; i < hashesToCheck.length; i += batchSize) {
      const batch = hashesToCheck.slice(i, i + batchSize);
      const rowsDb = await db
        .select({ hash: schema.transactions.importHash })
        .from(schema.transactions)
        .where(and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.importHash, batch),
        ))
        .all();
      for (const row of rowsDb) {
        if (row.hash) existingHashes.add(row.hash);
      }
    }
  }

  const duplicateCount = prepared.filter(
    (p) => p.hasResolvedAccount && existingHashes.has(p.importHash),
  ).length;

  const stagedImportId = randomUUID();
  const expiresAt = new Date(Date.now() + STAGE_TTL_MS);

  await db.insert(schema.stagedImports).values({
    id: stagedImportId,
    userId,
    source,
    fromAddress: fromAddress ?? null,
    subject: subject ?? null,
    svixId: svixId ?? null,
    status: "pending",
    totalRowCount: prepared.length,
    duplicateCount,
    expiresAt,
  });

  if (prepared.length > 0) {
    // Insert in chunks to avoid hitting statement-size limits.
    const chunk = 500;
    for (let i = 0; i < prepared.length; i += chunk) {
      const slice = prepared.slice(i, i + chunk);
      // Finding #9 — encrypt the free-text fields under the server staging
      // key before INSERT. A DB-dump-only attacker reading `staged_transactions`
      // sees `sv1:...` ciphertexts for payee/note/category/accountName instead
      // of plaintext. Decrypted at approve time (see /import/staged route).
      await db.insert(schema.stagedTransactions).values(
        slice.map((p) => ({
          id: randomUUID(),
          stagedImportId,
          userId,
          date: p.date,
          amount: p.amount,
          currency: p.currency ?? "CAD",
          payee: encryptStaged(p.payee),
          category: encryptStaged(p.category ?? null),
          accountName: encryptStaged(p.accountName ?? null),
          note: encryptStaged(p.note ?? null),
          rowIndex: p.rowIndex,
          isDuplicate: p.hasResolvedAccount && existingHashes.has(p.importHash),
          importHash: p.importHash,
        })),
      );
    }
  }

  return {
    stagedImportId,
    totalRowCount: prepared.length,
    duplicateCount,
    alreadyProcessed: false,
  };
}
