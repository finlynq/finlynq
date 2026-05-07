import { createHash } from "crypto";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";

export function generateImportHash(
  date: string,
  accountId: number,
  amount: number,
  payee: string,
): string {
  const normalized = [
    date.trim(),
    String(accountId),
    amount.toFixed(2),
    (payee || "").trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Check for duplicate transactions by `import_hash` (CSV/email/OFX content
 * dedup key). Scoped to the importing user's transactions only — passing in
 * `userId` is required so an authenticated user can't probe another tenant's
 * hashes.
 */
export async function checkDuplicates(hashes: string[], userId: string): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();

  const existing = new Set<string>();
  const batchSize = 900; // SQLite variable limit ~999

  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize);
    const rows = await db
      .select({ hash: schema.transactions.importHash })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.importHash, batch),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.hash) existing.add(row.hash);
    }
  }

  return existing;
}

/**
 * Check for duplicate transactions by fitId (bank-provided unique ID).
 * Returns the set of fitIds that already exist for the importing user.
 * Scoping to `userId` is required so an authenticated user can't probe
 * another tenant's bank fitIds.
 */
export async function checkFitIdDuplicates(fitIds: string[], userId: string): Promise<Set<string>> {
  if (fitIds.length === 0) return new Set();

  const existing = new Set<string>();
  const batchSize = 900;

  for (let i = 0; i < fitIds.length; i += batchSize) {
    const batch = fitIds.slice(i, i + batchSize);
    const rows = await db
      .select({ fitId: schema.transactions.fitId })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.fitId, batch),
        ),
      )
      .all();
    for (const row of rows) {
      if (row.fitId) existing.add(row.fitId);
    }
  }

  return existing;
}
