/**
 * Securities master — find-or-create chokepoint (Phase B dual-write).
 *
 * Resolves the `security_id` a new position should link to, creating the
 * `securities` row on first sight. Mirrors the holding resolver's 23505
 * re-select concurrency pattern (portfolio-holding-resolver.ts): the
 * (user_id, cluster_key) unique index lets two concurrent writers race and
 * converge on one row.
 *
 * Call this BEFORE inserting the `portfolio_holdings` row and spread the result
 * into the insert as `securityId`. The same partition rule (canonical.ts) backs
 * the login-time backfill, so write-time and backfill agree by construction.
 *
 * DEK contract:
 *   - With a DEK (every web/HTTP write site): symbol/name HMAC lookups are
 *     computed, clustering dedupes correctly.
 *   - Without a DEK (stdio MCP — out of scope for v1 writes): returns null;
 *     the position keeps `security_id = NULL` and the login-time backfill
 *     reconciles it once the user logs in with a DEK. Never auto-merges blind.
 *
 * → plan/architecture/securities.md
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { buildNameFields, nameLookup } from "@/lib/crypto/encrypted-columns";
import {
  classifyHoldingForSecurity,
  buildSecurityClusterKey,
} from "./canonical";

export interface ResolveSecuritySpec {
  symbol: string | null | undefined;
  name: string | null | undefined;
  /** The position's `is_crypto` flag (0/1 or boolean). */
  isCryptoFlag?: boolean | number | null;
  /** The position's `is_cash` flag (unused by clustering — overview ignores
   *  it — but accepted so callers can pass it without ceremony). */
  isCash?: boolean | null;
  /** Quote/trading currency (defaults to the position's currency). */
  currency: string;
  /** Optional logo url copied onto the security on first create. */
  image?: string | null;
  /** Per-user `active_currencies` codes (treated as cash symbols, like
   *  overview). When omitted, loaded from settings for exact parity. */
  extraCurrencyCodes?: readonly string[];
}

/** Load the user's `active_currencies` setting (codes treated as cash symbols
 *  by overview). Empty on unset/malformed. */
export async function loadActiveCurrencyCodes(userId: string): Promise<string[]> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(eq(schema.settings.key, "active_currencies"), eq(schema.settings.userId, userId)),
    )
    .get();
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (Array.isArray(parsed)) return parsed.map((s: unknown) => String(s).toUpperCase());
  } catch {
    /* malformed → none */
  }
  return [];
}

/**
 * Resolve (find-or-create) the security a position belongs to. Returns the
 * `securities.id`, or null when no DEK / un-clusterable (caller leaves
 * `security_id` NULL).
 */
export async function resolveOrCreateSecurity(
  userId: string,
  dek: Buffer | null,
  spec: ResolveSecuritySpec,
): Promise<number | null> {
  if (!dek) return null; // can't compute HMAC lookups → can't dedupe; backfill later.

  const symbol = (spec.symbol ?? "").trim() || null;
  const name = (spec.name ?? "").trim() || null;
  const isCryptoFlag = spec.isCryptoFlag === true || spec.isCryptoFlag === 1;
  const extra =
    spec.extraCurrencyCodes ?? (await loadActiveCurrencyCodes(userId));

  const cluster = classifyHoldingForSecurity({
    symbol,
    name,
    isCryptoFlag,
    currency: spec.currency,
    extraCurrencyCodes: extra,
  });

  const symbolLookup = symbol ? nameLookup(dek, symbol) : null;
  const nmLookup = name ? nameLookup(dek, name) : null;
  const clusterKey = buildSecurityClusterKey(cluster, { symbolLookup, nameLookup: nmLookup });
  if (!clusterKey) return null; // no usable discriminator → leave NULL for backfill.

  // 1. Find existing.
  const existing = await db
    .select({ id: schema.securities.id })
    .from(schema.securities)
    .where(
      and(eq(schema.securities.userId, userId), eq(schema.securities.clusterKey, clusterKey)),
    )
    .get();
  if (existing?.id != null) return existing.id;

  // 2. Create. Copy the encrypted identity (same DEK as the positions).
  const enc = buildNameFields(dek, { symbol: symbol ?? "", name: name ?? "" });
  try {
    const inserted = await db
      .insert(schema.securities)
      .values({
        userId,
        clusterKey,
        assetType: cluster.assetType,
        currency: spec.currency,
        isCash: spec.isCash === true,
        isCrypto: isCryptoFlag ? 1 : 0,
        symbolCt: (enc.symbolCt as string | null) ?? null,
        symbolLookup: symbolLookup,
        nameCt: (enc.nameCt as string | null) ?? null,
        nameLookup: nmLookup,
        image: spec.image ?? null,
      })
      .onConflictDoNothing({ target: [schema.securities.userId, schema.securities.clusterKey] })
      .returning({ id: schema.securities.id });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    if (row?.id != null) return row.id;
  } catch (err) {
    // 23505 only — a concurrent writer won the race; fall through to re-select.
    const code = (err as { code?: string }).code;
    if (code && code !== "23505") throw err;
  }

  // 3. Re-select the winner (onConflictDoNothing returned nothing, or a race).
  const after = await db
    .select({ id: schema.securities.id })
    .from(schema.securities)
    .where(
      and(eq(schema.securities.userId, userId), eq(schema.securities.clusterKey, clusterKey)),
    )
    .get();
  return after?.id ?? null;
}

/**
 * Garbage-collect a security row that no position references any more.
 *
 * Called after an EDIT re-points a position at a DIFFERENT security
 * (`resolveOrCreateSecurity` returned a new id on a symbol/name/currency
 * change): if the OLD security now backs zero positions, delete it so its
 * `cluster_key` frees up and the management UI (/settings/investments) doesn't
 * show a phantom ticker. A security may legitimately back many positions (the
 * same ticker across accounts — the merge case), so we only delete on a true
 * zero-reference count.
 *
 * Atomic NOT EXISTS guard — a concurrent insert that re-links a position keeps
 * the row. The `portfolio_holdings.security_id` FK is `ON DELETE SET NULL`, so
 * even a lost race only nulls a position's `security_id` (the login backfill /
 * next resolve re-links it); positions / lots / transactions are never touched.
 *
 * No-op when `securityId` is null. Per-user scoped.
 */
export async function gcOrphanSecurity(
  userId: string,
  securityId: number | null,
): Promise<void> {
  if (securityId == null) return;
  await db.execute(sql`
    DELETE FROM securities
    WHERE id = ${securityId}
      AND user_id = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM portfolio_holdings
        WHERE security_id = ${securityId} AND user_id = ${userId}
      )
  `);
}
