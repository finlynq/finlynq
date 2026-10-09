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
 * Plaintext-gap closure (2026-06-01) — `encryptOptional` / `decryptOptional`:
 *   - free-text note columns: loans.note, goals.note, snapshots.note,
 *     subscriptions.notes, fx_overrides.note, contribution_room.note,
 *     recurring_transactions.{payee,note}, plus MCP-write-only accounts.note /
 *     categories.note. Registry: src/lib/crypto/user-encrypted-registry.ts.
 *   - transaction_rules sensitive fields (name + payee/note/tags condition
 *     values + rename_payee.to + set_tags.tags) via src/lib/rules/crypto.ts.
 *   - Login sweep `upgradeUserFieldEncryption` is the backstop for legacy /
 *     stdio / email-import plaintext. → plan/encryption-plaintext-gaps.md
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
import { encryptField, decryptField, tryDecryptField } from "./envelope";

// ─── Optional free-text envelope columns (2026-06-01) ───────────────────────
//
// Plaintext-gap closure plan (plan/encryption-plaintext-gaps.md). These two
// helpers cover the "optional, ciphertext-only, null/DEK-safe" shape used by
// the free-text `note`/`notes` columns on goals/loans/snapshots/subscriptions/
// fx_overrides/contribution_room/recurring_transactions. Unlike the Stream D
// `name` columns there is no `name_lookup` HMAC sibling — notes are never
// queried by exact match, only displayed.
//
// Contract:
//   - Cold DEK (`dek == null`) writes pass plaintext through unchanged; the
//     login sweep (upgradeUserFieldEncryption) re-encrypts it on next login.
//   - Empty/null inputs pass through unchanged (no `v1:` on empty strings).
//   - Reads tolerate legacy plaintext (`tryDecryptField` passthrough) and
//     surface the raw value rather than crashing on auth-tag failure.

/** Encrypt an optional free-text value. Returns the value unchanged when the
 *  DEK is null (plaintext passthrough) or when the value is null/empty. */
export function encryptOptional(
  dek: Buffer | null,
  v: string | null | undefined,
): string | null {
  if (v == null || v === "") return v ?? null;
  return dek ? encryptField(dek, v) : v;
}

/** Decrypt an optional free-text value. Tolerates legacy plaintext and a null
 *  DEK (returns the stored value unchanged). On auth-tag failure returns the
 *  raw ciphertext rather than throwing (the `?? v` fallback). */
export function decryptOptional(
  dek: Buffer | null,
  v: string | null | undefined,
): string | null {
  if (v == null) return null;
  if (!dek) return v;
  return tryDecryptField(dek, v) ?? v;
}

/** Columns on `transactions` that are ciphertext-at-rest in Phase 1.
 *  `portfolioHolding` was removed by Phase 5 (2026-04-29) — the FK
 *  `portfolio_holding_id` is now the sole source of truth, the legacy
 *  text column is NULLed by scripts/migrate-tx-portfolio-holding-phase5-null.sql,
 *  and the holding name is decrypted off `portfolio_holdings.name_ct` via the
 *  Stream D `decryptName()` helper. */
export const TX_ENCRYPTED_FIELDS = [
  "payee",
  "note",
  "tags",
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
 * For READ RESPONSES served without a DEK (locked session): blank every
 * still-encrypted transaction field (`v1:...`) to null so the UI shows "—"
 * instead of ciphertext. Legacy plaintext values pass through. Never use on
 * rows that will be written back — it is display-only.
 */
export function redactTxCiphertext<T extends Partial<Record<TxEncryptedKey, string | null | undefined>>>(
  rows: T[],
): T[] {
  return rows.map((r) => {
    let out: T | null = null;
    for (const k of TX_ENCRYPTED_FIELDS) {
      const v = r[k];
      if (typeof v === "string" && v.startsWith("v1:")) {
        out ??= { ...r };
        (out as Record<string, string | null>)[k] = null;
      }
    }
    return out ?? r;
  });
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
 * Decrypt a name ciphertext back to plaintext.
 *
 * Stream D Phase 3 cutover (2026-05-03): plaintext fallback removed. Every
 * row's plaintext column is NULL on dev; reads route through `name_ct` only.
 * The `fallback` parameter is kept in the signature so call sites compile
 * unchanged but it is no longer consulted on decrypt failure — returning the
 * stale plaintext after a force-NULL would leak data we deliberately deleted.
 *
 * Returns:
 *   - decryptField(ct) if ct is non-null AND dek decrypts it
 *   - null if ct is non-null but DEK is missing OR decrypt fails — the UI
 *     renders "—"/blank rather than reviving plaintext that was nulled on
 *     purpose. Surfaces a warn line so DEK-mismatch users (pathfinder) are
 *     diagnosable from the journal.
 *   - null if ct is null (legacy stdio-write rows that never backfilled)
 *
 * @param fallback retained for ABI stability with pre-cutover call sites;
 *   ignored on the decrypt failure path. Pass `null` for new code.
 */
export function decryptName(
  ct: string | null | undefined,
  dek: Buffer | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fallback: string | null | undefined
): string | null {
  if (ct == null || ct === "") return null;
  if (!dek) {
    // No DEK in the cache (server restart, idle timeout). Returning the
    // ciphertext marker would render `v1:...` in the UI; null renders "—".
    // Caller (login path) repopulates the DEK on next request.
    return null;
  }
  try {
    return decryptField(dek, ct);
  } catch (err) {
    try {

      console.warn(
        "[envelope] decryptName failed; returning null:",
        err instanceof Error ? err.message : String(err),
      );
    } catch { /* ignore */ }
    return null;
  }
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
