/**
 * Securities master — Phase C login-time per-user backfill.
 *
 * Clusters every existing `portfolio_holdings` row under a `securities` row and
 * sets `security_id`, using the EXACT same partition rule (canonical.ts) as the
 * write-side resolver and the legacy overview `canonicalKey` — so grouping by
 * `security_id` is provably equivalent to the legacy string grouping (the
 * parity gate, scripts/verify-securities-parity.ts).
 *
 * Why per-user at login (not a pure-SQL migration):
 *   - The cluster kind depends on the PLAINTEXT symbol (metal XAU vs currency
 *     code vs crypto vs equity) — which lives only in `symbol_ct` (AES-GCM).
 *     Pure SQL can't read it; the DEK can. The HMAC `symbol_lookup`/`name_lookup`
 *     ARE stored, so we reuse them verbatim and never recompute.
 *   - The security row copies the representative position's ciphertext
 *     VERBATIM (no decrypt/re-encrypt) — same per-user DEK.
 *
 * Idempotent + re-run-safe: short-circuits on `users.securities_backfilled_at`;
 * find-or-create on (user_id, cluster_key) converges; the flag is stamped only
 * after a full pass, so a partial failure simply re-runs next login.
 *
 * Fire-and-forget on the login path — never blocks login, never throws.
 * → plan/architecture/securities.md
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { decryptField } from "@/lib/crypto/envelope";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import {
  classifyHoldingForSecurity,
  buildSecurityClusterKey,
} from "./canonical";
import { loadActiveCurrencyCodes } from "./resolve";

export type BackfillSecuritiesResult =
  | { backfilled: true; linkedCount: number; securitiesCreated: number; total: number }
  | { backfilled: false; reason: "already-done" | "dek-decrypt-failed" | "no-rows" };

/**
 * Run the per-user securities backfill if not already done. Returns a summary
 * for logging. Partial-progress-safe (flag stamped only after a full pass).
 */
export async function backfillSecuritiesForUser(
  userId: string,
  dek: Buffer,
): Promise<BackfillSecuritiesResult> {
  // Step 1: skip if already done.
  const flagRes = await db.execute<{ securities_backfilled_at: string | null }>(
    sql`SELECT securities_backfilled_at FROM users WHERE id = ${userId} LIMIT 1`,
  );
  if (flagRes.rows?.[0]?.securities_backfilled_at) {
    return { backfilled: false, reason: "already-done" };
  }

  // Step 2: load every holding (lowest id first = deterministic cluster
  // representative). We read the STORED HMAC lookups (no recompute) + ciphertext.
  const rows = await db
    .select({
      id: schema.portfolioHoldings.id,
      accountId: schema.portfolioHoldings.accountId,
      currency: schema.portfolioHoldings.currency,
      isCrypto: schema.portfolioHoldings.isCrypto,
      isCash: schema.portfolioHoldings.isCash,
      securityId: schema.portfolioHoldings.securityId,
      nameCt: schema.portfolioHoldings.nameCt,
      nameLookup: schema.portfolioHoldings.nameLookup,
      symbolCt: schema.portfolioHoldings.symbolCt,
      symbolLookup: schema.portfolioHoldings.symbolLookup,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId))
    .orderBy(schema.portfolioHoldings.id);

  if (rows.length === 0) {
    await db.execute(
      sql`UPDATE users SET securities_backfilled_at = ${new Date().toISOString()} WHERE id = ${userId}`,
    );
    return { backfilled: false, reason: "no-rows" };
  }

  // Step 3: sample-decrypt precondition (DEK-mismatch users bail silently).
  const sample = rows.find((r) => r.symbolCt) ?? rows.find((r) => r.nameCt);
  const sampleCt = sample?.symbolCt ?? sample?.nameCt ?? null;
  if (sampleCt) {
    try {
      decryptField(dek, sampleCt);
    } catch (err) {
      console.warn(
        `[backfill-securities] user=${userId} sample decrypt failed; skipping. ` +
          `err=${err instanceof Error ? err.message : String(err)}`,
      );
      return { backfilled: false, reason: "dek-decrypt-failed" };
    }
  }

  const extraCurrencyCodes = await loadActiveCurrencyCodes(userId);

  // Pre-load existing securities (created by Phase B dual-write) so we reuse,
  // not duplicate.
  const existingSecurities = await db
    .select({ id: schema.securities.id, clusterKey: schema.securities.clusterKey })
    .from(schema.securities)
    .where(eq(schema.securities.userId, userId));
  const byClusterKey = new Map<string, number>();
  for (const s of existingSecurities) byClusterKey.set(s.clusterKey, s.id);

  // Anomaly tracking (logged, not blocking): currency mismatch within a cluster
  // + duplicate (same account) positions sharing a cluster.
  const clusterCurrencies = new Map<string, Set<string>>();
  const clusterAccountCounts = new Map<string, Map<number, number>>();

  let linkedCount = 0;
  let securitiesCreated = 0;

  await db.transaction(async (tx) => {
    for (const r of rows) {
      const symbol = decryptName(r.symbolCt, dek, null);
      const name = decryptName(r.nameCt, dek, null);
      const cluster = classifyHoldingForSecurity({
        symbol,
        name,
        isCryptoFlag: r.isCrypto === 1,
        currency: r.currency,
        extraCurrencyCodes,
      });
      const clusterKey = buildSecurityClusterKey(cluster, {
        symbolLookup: r.symbolLookup,
        nameLookup: r.nameLookup,
      });
      if (!clusterKey) continue; // un-clusterable (no lookups) — leave NULL.

      // Anomaly bookkeeping.
      let ccySet = clusterCurrencies.get(clusterKey);
      if (!ccySet) {
        ccySet = new Set();
        clusterCurrencies.set(clusterKey, ccySet);
      }
      ccySet.add((r.currency ?? "").toUpperCase());
      if (r.accountId != null) {
        let accMap = clusterAccountCounts.get(clusterKey);
        if (!accMap) {
          accMap = new Map();
          clusterAccountCounts.set(clusterKey, accMap);
        }
        accMap.set(r.accountId, (accMap.get(r.accountId) ?? 0) + 1);
      }

      let securityId = byClusterKey.get(clusterKey);
      if (securityId == null) {
        // Create — copy the representative (this lowest-id) row's ciphertext
        // VERBATIM (same DEK, no re-encrypt). symbol_lookup mirrors the
        // position's stored lookup for any future SQL join.
        const inserted = await tx
          .insert(schema.securities)
          .values({
            userId,
            clusterKey,
            assetType: cluster.assetType,
            currency: r.currency,
            isCash: r.isCash === true,
            isCrypto: r.isCrypto ?? 0,
            symbolCt: cluster.kind === "cash" || cluster.kind === "custom" ? null : r.symbolCt,
            symbolLookup: cluster.kind === "cash" || cluster.kind === "custom" ? null : r.symbolLookup,
            nameCt: r.nameCt,
            nameLookup: r.nameLookup,
          })
          .onConflictDoNothing({ target: [schema.securities.userId, schema.securities.clusterKey] })
          .returning({ id: schema.securities.id });
        const newRow = Array.isArray(inserted) ? inserted[0] : inserted;
        if (newRow?.id != null) {
          securityId = newRow.id;
          securitiesCreated++;
        } else {
          // Conflict (shouldn't happen mid-tx) — re-select.
          const after = await tx
            .select({ id: schema.securities.id })
            .from(schema.securities)
            .where(and(eq(schema.securities.userId, userId), eq(schema.securities.clusterKey, clusterKey)))
            .get();
          securityId = after?.id ?? undefined;
        }
        if (securityId != null) byClusterKey.set(clusterKey, securityId);
      }

      if (securityId != null && r.securityId !== securityId) {
        await tx
          .update(schema.portfolioHoldings)
          .set({ securityId })
          .where(and(eq(schema.portfolioHoldings.id, r.id), eq(schema.portfolioHoldings.userId, userId)));
        linkedCount++;
      }
    }

    await tx.execute(
      sql`UPDATE users SET securities_backfilled_at = ${new Date().toISOString()} WHERE id = ${userId}`,
    );
  });

  // Anomaly report (logged for ops; never blocks).
  for (const [ck, ccys] of clusterCurrencies) {
    if (ccys.size > 1) {
      console.warn(`[backfill-securities] user=${userId} cluster ${ck} has mixed currencies: ${[...ccys].join(",")}`);
    }
  }
  for (const [ck, accMap] of clusterAccountCounts) {
    for (const [accId, count] of accMap) {
      if (count > 1) {
        console.warn(`[backfill-securities] user=${userId} cluster ${ck} has ${count} positions in account ${accId} (possible duplicate position)`);
      }
    }
  }

  return { backfilled: true, linkedCount, securitiesCreated, total: rows.length };
}

/**
 * Fire-and-forget wrapper for login paths. Never blocks login, swallows errors.
 * Logs a one-liner on a non-trivial backfill.
 */
export function enqueueBackfillSecurities(userId: string, dek: Buffer): void {
  void (async () => {
    try {
      const r = await backfillSecuritiesForUser(userId, dek);
      if (r.backfilled && (r.linkedCount > 0 || r.securitiesCreated > 0)) {
        console.log(
          `[backfill-securities] user=${userId} linked ${r.linkedCount}/${r.total} positions ` +
            `under ${r.securitiesCreated} new securities`,
        );
      }
    } catch (err) {
      console.warn(`[backfill-securities] user=${userId} unexpected error:`, err);
    }
  })();
}
