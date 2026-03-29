import { createHash } from "crypto";
import { db, schema } from "@/db";
import { inArray } from "drizzle-orm";

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

export function checkDuplicates(hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set();

  const existing = new Set<string>();
  const batchSize = 900; // SQLite variable limit ~999

  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize);
    const rows = db
      .select({ hash: schema.transactions.importHash })
      .from(schema.transactions)
      .where(inArray(schema.transactions.importHash, batch))
      .all();
    for (const row of rows) {
      if (row.hash) existing.add(row.hash);
    }
  }

  return existing;
}

/**
 * Check for duplicate transactions by fitId (bank-provided unique ID).
 * Returns the set of fitIds that already exist in the database.
 */
export function checkFitIdDuplicates(fitIds: string[]): Set<string> {
  if (fitIds.length === 0) return new Set();

  const existing = new Set<string>();
  const batchSize = 900;

  for (let i = 0; i < fitIds.length; i += batchSize) {
    const batch = fitIds.slice(i, i + batchSize);
    const rows = db
      .select({ fitId: schema.transactions.fitId })
      .from(schema.transactions)
      .where(inArray(schema.transactions.fitId, batch))
      .all();
    for (const row of rows) {
      if (row.fitId) existing.add(row.fitId);
    }
  }

  return existing;
}
