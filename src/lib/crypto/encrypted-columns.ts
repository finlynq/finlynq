/**
 * Encrypted-column helpers for route handlers.
 *
 * The queries layer (src/lib/queries.ts) stays dialect-pure: it just reads and
 * writes whatever strings are in the columns. These helpers live one layer up
 * in route handlers, converting plaintext <-> ciphertext as data crosses the
 * API boundary.
 *
 * Phase 1 scope:
 *   - transactions: payee, note, tags, portfolio_holding
 *
 * Phase 3 extensions:
 *   - transaction_splits: note, description, tags
 */

import { encryptField, decryptField } from "./envelope";

/** Columns on `transactions` that are ciphertext-at-rest in Phase 1. */
export const TX_ENCRYPTED_FIELDS = [
  "payee",
  "note",
  "tags",
  "portfolioHolding",
] as const;

type TxEncryptedKey = (typeof TX_ENCRYPTED_FIELDS)[number];

/** Columns on `transaction_splits` that are ciphertext-at-rest. */
export const SPLIT_ENCRYPTED_FIELDS = [
  "note",
  "description",
  "tags",
] as const;

type SplitEncryptedKey = (typeof SPLIT_ENCRYPTED_FIELDS)[number];

/** Shallow-encrypt the named fields of a transaction write payload. */
export function encryptTxWrite<T extends Partial<Record<TxEncryptedKey, string | null | undefined>>>(
  dek: Buffer,
  data: T
): T {
  const out = { ...data };
  for (const k of TX_ENCRYPTED_FIELDS) {
    if (k in data) {
      (out as Record<string, string | null>)[k] = encryptField(dek, data[k] ?? null);
    }
  }
  return out;
}

/** Shallow-decrypt the named fields of a transaction read row. */
export function decryptTxRow<T extends Partial<Record<TxEncryptedKey, string | null | undefined>>>(
  dek: Buffer,
  row: T
): T {
  const out = { ...row };
  for (const k of TX_ENCRYPTED_FIELDS) {
    if (k in row) {
      (out as Record<string, string | null>)[k] = decryptField(dek, row[k] ?? null);
    }
  }
  return out;
}

export function decryptTxRows<T extends Partial<Record<TxEncryptedKey, string | null | undefined>>>(
  dek: Buffer,
  rows: T[]
): T[] {
  return rows.map((r) => decryptTxRow(dek, r));
}

/**
 * In-memory substring filter for the `search` query param. We can't push
 * substring search down into SQL on encrypted columns; for small row counts
 * (< ~10k per user) the decrypted scan is a few ms.
 *
 * Returns rows whose payee, note, or tags contain `query` (case-insensitive).
 */
export function filterDecryptedBySearch<
  T extends { payee?: string | null; note?: string | null; tags?: string | null }
>(rows: T[], query: string): T[] {
  const q = query.toLowerCase();
  return rows.filter((r) => {
    return (
      (r.payee?.toLowerCase().includes(q) ?? false) ||
      (r.note?.toLowerCase().includes(q) ?? false) ||
      (r.tags?.toLowerCase().includes(q) ?? false)
    );
  });
}

/** Shallow-encrypt the named fields of a transaction-split write payload. */
export function encryptSplitWrite<T extends Partial<Record<SplitEncryptedKey, string | null | undefined>>>(
  dek: Buffer,
  data: T
): T {
  const out = { ...data };
  for (const k of SPLIT_ENCRYPTED_FIELDS) {
    if (k in data) {
      (out as Record<string, string | null>)[k] = encryptField(dek, data[k] ?? null);
    }
  }
  return out;
}

/** Shallow-decrypt the named fields of a transaction-split read row. */
export function decryptSplitRow<T extends Partial<Record<SplitEncryptedKey, string | null | undefined>>>(
  dek: Buffer,
  row: T
): T {
  const out = { ...row };
  for (const k of SPLIT_ENCRYPTED_FIELDS) {
    if (k in row) {
      (out as Record<string, string | null>)[k] = decryptField(dek, row[k] ?? null);
    }
  }
  return out;
}

export function decryptSplitRows<T extends Partial<Record<SplitEncryptedKey, string | null | undefined>>>(
  dek: Buffer,
  rows: T[]
): T[] {
  return rows.map((r) => decryptSplitRow(dek, r));
}
