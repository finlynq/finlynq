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
 *
 * Stream D (2026-04-24):
 *   - accounts: name, alias
 *   - categories: name
 *   - goals: name
 *   - loans: name
 *   - subscriptions: name
 *   - portfolio_holdings: name, symbol
 *
 * Stream D names use a parallel (name_ct, name_lookup) column pattern:
 *   - name_ct = AES-GCM(dek, plaintext) with random IV (so cross-row hashes differ)
 *   - name_lookup = HMAC-SHA256(dek, lowercased-trimmed(plaintext)) (stable per user)
 *
 * The lookup column lets us keep exact-match SQL queries and per-user unique
 * constraints while the ciphertext provides the privacy guarantee. Case-
 * insensitive collision — "Chase" / "CHASE" / "chase " all hash to the same
 * lookup — is a feature, not a bug: it matches the semantic users expect.
 *
 * While plaintext columns still exist (Phase 1 of the Stream D rollout), writes
 * populate BOTH the old plaintext column AND the new ct/lookup pair when a DEK
 * is available, and reads prefer the decrypted ciphertext but fall back to
 * plaintext. Phase 3 will null out plaintext on backfilled rows and then drop
 * the old columns in a separate cutover.
 */

import { createHmac } from "crypto";
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

/**
 * Shallow-decrypt the named fields of a transaction read row.
 * When `dek` is null (e.g. session DEK cache missed after a deploy), rows
 * pass through unchanged — legacy plaintext stays readable and encrypted
 * rows ship as `v1:` ciphertext rather than 423-ing the whole page.
 */
export function decryptTxRow<T extends Partial<Record<TxEncryptedKey, string | null | undefined>>>(
  dek: Buffer | null,
  row: T
): T {
  if (!dek) return row;
  const out = { ...row };
  for (const k of TX_ENCRYPTED_FIELDS) {
    if (k in row) {
      const v = row[k] ?? null;
      try {
        (out as Record<string, string | null>)[k] = decryptField(dek, v);
      } catch (err) {
        // Auth-tag mismatch — DEK rotation, wipe-rewrap orphan, or genuine
        // corruption. Pass through ciphertext (or null) instead of crashing
        // the whole list-rendering path. The "v1:..." marker surfaces in the
        // UI so the failure isn't completely silent.
        try {
          // eslint-disable-next-line no-console
          console.warn(
            `[envelope] decryptTxRow failed on ${k}; returning ciphertext:`,
            err instanceof Error ? err.message : String(err),
          );
        } catch { /* ignore */ }
        (out as Record<string, string | null>)[k] = v;
      }
    }
  }
  return out;
}

export function decryptTxRows<T extends Partial<Record<TxEncryptedKey, string | null | undefined>>>(
  dek: Buffer | null,
  rows: T[]
): T[] {
  if (!dek) return rows;
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

/** Shallow-decrypt the named fields of a transaction-split read row.
 *  Pass-through when `dek` is null — same rationale as decryptTxRow. */
export function decryptSplitRow<T extends Partial<Record<SplitEncryptedKey, string | null | undefined>>>(
  dek: Buffer | null,
  row: T
): T {
  if (!dek) return row;
  const out = { ...row };
  for (const k of SPLIT_ENCRYPTED_FIELDS) {
    if (k in row) {
      const v = row[k] ?? null;
      try {
        (out as Record<string, string | null>)[k] = decryptField(dek, v);
      } catch (err) {
        try {
          // eslint-disable-next-line no-console
          console.warn(
            `[envelope] decryptSplitRow failed on ${k}; returning ciphertext:`,
            err instanceof Error ? err.message : String(err),
          );
        } catch { /* ignore */ }
        (out as Record<string, string | null>)[k] = v;
      }
    }
  }
  return out;
}

export function decryptSplitRows<T extends Partial<Record<SplitEncryptedKey, string | null | undefined>>>(
  dek: Buffer | null,
  rows: T[]
): T[] {
  if (!dek) return rows;
  return rows.map((r) => decryptSplitRow(dek, r));
}

// ─── Stream D — display-name encryption (2026-04-24) ────────────────────────

/**
 * Normalize a name for lookup hashing: lowercase + collapsed whitespace + trim.
 * "Chase Checking" and "  chase   checking " hash to the same lookup.
 */
function normalizeForLookup(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * HMAC-SHA256 of the normalized name under the user's DEK. Returns base64url
 * so it fits in a text column without wrapping concerns. Used both for exact-
 * match WHERE clauses and for the (user_id, name_lookup) unique constraint.
 * Same DEK + same normalized input always produces the same hash — that's the
 * point. Different users produce different hashes for the same input.
 */
export function nameLookup(dek: Buffer, name: string): string {
  const h = createHmac("sha256", dek).update(normalizeForLookup(name), "utf8").digest();
  return h.toString("base64url");
}

/**
 * Encrypt a display name: returns `{ ct, lookup }`. Ciphertext uses the v1:
 * envelope with a random IV so cross-row hashes differ; lookup is stable per
 * user (same DEK + same normalized input = same hash).
 *
 * Empty / null input returns `{ ct: null, lookup: null }` — callers that
 * require a non-empty name must reject upstream.
 */
export function encryptName(
  dek: Buffer,
  name: string | null | undefined
): { ct: string | null; lookup: string | null } {
  if (name == null || name === "") return { ct: null, lookup: null };
  return { ct: encryptField(dek, name), lookup: nameLookup(dek, name) };
}

/**
 * Decrypt a name ciphertext back to plaintext, with a plaintext-column
 * fallback that makes migration safe. Returns:
 *   - decryptField(ct) if ct is non-null AND dek is available
 *   - fallback (plaintext) if decryption FAILS and fallback is non-null —
 *     this guards the dual-write window where a row carries both `name`
 *     (plaintext) and `name_ct` (ciphertext encrypted under a DEK that
 *     the current session can no longer reproduce, e.g. data written before
 *     a wipe-and-rewrap). Encryption is defense-in-depth; if the user's
 *     plaintext is still on disk the right thing is to show it rather than
 *     500 the dashboard.
 *   - ct as-is if ct is non-null and decrypt fails AND no plaintext
 *     fallback (shows "v1:..." so the user knows something's off)
 *   - fallback if ct is null (pre-migration row, not yet backfilled)
 */
export function decryptName(
  ct: string | null | undefined,
  dek: Buffer | null,
  fallback: string | null | undefined
): string | null {
  if (ct != null && ct !== "") {
    if (dek) {
      try {
        return decryptField(dek, ct);
      } catch (err) {
        // Auth-tag mismatch (DEK rotation, wipe-rewrap orphan, or genuine
        // corruption). Surface a single warn line — callers further up the
        // stack throw away the full row map on the first error otherwise.
        try {
          // eslint-disable-next-line no-console
          console.warn(
            "[envelope] decryptName failed; falling back to plaintext:",
            err instanceof Error ? err.message : String(err),
          );
        } catch { /* ignore */ }
        if (fallback != null && fallback !== "") return fallback;
        return ct; // ciphertext marker so the failure isn't completely silent
      }
    }
    if (fallback != null && fallback !== "") return fallback;
    return ct; // degraded — caller's UI may show placeholder
  }
  return fallback ?? null;
}

/**
 * Spec for {@link decryptNamedRows}: maps a ciphertext property name to the
 * plaintext fallback property name. Example for accounts:
 *   { name_ct: "name", alias_ct: "alias" }
 */
export type NamedColumnSpec = Record<string, string>;

/**
 * Shallow-decrypt every named column on every row using the spec. Preserves
 * any other columns on the row untouched. Designed for list endpoints +
 * JSON serialization paths.
 */
export function decryptNamedRows<T extends Record<string, unknown>>(
  rows: T[],
  dek: Buffer | null,
  spec: NamedColumnSpec
): T[] {
  if (rows.length === 0) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const [ctKey, fallbackKey] of Object.entries(spec)) {
      const ct = row[ctKey] as string | null | undefined;
      const fallback = row[fallbackKey] as string | null | undefined;
      out[fallbackKey] = decryptName(ct, dek, fallback);
    }
    return out as T;
  });
}

/**
 * Named-column write spec per table. Tables not listed here have no encrypted
 * display-name columns. Each entry lists the plaintext-column → ct/lookup
 * mapping used by the CRUD helpers.
 */
export const NAMED_ENCRYPTED_FIELDS = {
  accounts: { name: { ct: "nameCt", lookup: "nameLookup" }, alias: { ct: "aliasCt", lookup: "aliasLookup" } },
  categories: { name: { ct: "nameCt", lookup: "nameLookup" } },
  goals: { name: { ct: "nameCt", lookup: "nameLookup" } },
  loans: { name: { ct: "nameCt", lookup: "nameLookup" } },
  subscriptions: { name: { ct: "nameCt", lookup: "nameLookup" } },
  portfolioHoldings: {
    name: { ct: "nameCt", lookup: "nameLookup" },
    symbol: { ct: "symbolCt", lookup: "symbolLookup" },
  },
} as const;

/**
 * Build the encrypted ct/lookup fields to merge into an INSERT/UPDATE payload.
 * When `dek` is null (legacy path, stdio MCP, migration window), returns an
 * empty object — callers still set the plaintext column as before.
 *
 * Usage:
 *   const enc = buildNameFields(dek, { name: data.name, alias: data.alias });
 *   await db.insert(accounts).values({ ...data, ...enc, userId }).returning().get();
 */
export function buildNameFields(
  dek: Buffer | null,
  fields: Record<string, string | null | undefined>
): Record<string, string | null> {
  if (!dek) return {};
  const out: Record<string, string | null> = {};
  for (const [plainKey, value] of Object.entries(fields)) {
    const { ct, lookup } = encryptName(dek, value);
    const ctKey = plainKey + "Ct";
    const lookupKey = plainKey + "Lookup";
    out[ctKey] = ct;
    out[lookupKey] = lookup;
  }
  return out;
}
