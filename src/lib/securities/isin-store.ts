/**
 * Remember and recall a security's ISIN (GH #365). Server-only (DB).
 *
 * The resolved Yahoo symbol is what clusters and prices a security; the ISIN
 * is kept alongside it (`securities.isin_ct` / `isin_lookup`, encrypted like
 * the symbol) so an ISIN the user has entered once matches from their own
 * data on later lookups and imports, before anything asks Yahoo.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { buildNameFields, decryptName, nameLookup } from "@/lib/crypto/encrypted-columns";
import { isIsin, normalizeIsin } from "./isin";
import { resolveIsin, type IsinMatch } from "./isin-resolve";

/** Stamp `isin` on a security the user owns. No-op without a DEK, an id, or a valid ISIN. */
export async function rememberSecurityIsin(
  userId: string,
  dek: Buffer | null,
  securityId: number | null | undefined,
  isin: string | null | undefined,
): Promise<void> {
  if (!dek || securityId == null || !isin || !isIsin(isin)) return;
  const norm = normalizeIsin(isin);
  await db
    .update(schema.securities)
    // Same encryption as symbol_ct / symbol_lookup (buildNameFields → isinCt + isinLookup).
    .set({ ...buildNameFields(dek, { isin: norm }), updatedAt: new Date() })
    .where(and(eq(schema.securities.id, securityId), eq(schema.securities.userId, userId)));
}

/** The ticker of the user's security stored under this ISIN, if any. */
export async function findSymbolByIsin(userId: string, dek: Buffer | null, isin: string): Promise<string | null> {
  if (!dek || !isIsin(isin)) return null;
  const row = await db
    .select({ symbolCt: schema.securities.symbolCt })
    .from(schema.securities)
    .where(
      and(
        eq(schema.securities.userId, userId),
        eq(schema.securities.isinLookup, nameLookup(dek, normalizeIsin(isin))),
        isNotNull(schema.securities.symbolCt),
      ),
    )
    .get();
  return row ? decryptName(row.symbolCt, dek, null) : null;
}

/**
 * Resolve an ISIN for one user: their own stored securities first, then
 * Yahoo. `source` says which answered. Null when neither knows it.
 */
export async function resolveIsinForUser(
  userId: string,
  dek: Buffer | null,
  isin: string,
): Promise<(Pick<IsinMatch, "symbol"> & Partial<IsinMatch> & { source: "stored" | "yahoo" }) | null> {
  if (!isIsin(isin)) return null;
  const stored = await findSymbolByIsin(userId, dek, isin).catch(() => null);
  if (stored) return { symbol: stored, source: "stored" };
  const match = await resolveIsin(isin);
  return match ? { ...match, source: "yahoo" } : null;
}
