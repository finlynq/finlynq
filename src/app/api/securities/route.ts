/**
 * /api/securities — Securities master management (Tier 2, Phase E).
 *
 * The `securities` table is the centralized per-(user, ticker) identity (one
 * row per cluster). Positions (`portfolio_holdings`) carry a `security_id` FK.
 * This endpoint powers /settings/securities:
 *
 *   GET    — list each security once, with the accounts that hold it.
 *   PATCH  — rename a security's display name (re-encrypts name_ct/lookup).
 *            The cluster_key (symbol-based) is NOT touched — renaming never
 *            re-clusters.
 *   POST   — link a security to another account = create a position in that
 *            account, copying the security's encrypted identity + security_id
 *            (+ the mandatory holding_accounts pairing).
 *   DELETE — unlink a security from an account = delete that (tx-free) position.
 *            Refuses (409) when the position has ledger transactions — those
 *            must be managed from /portfolio.
 *
 * Auth: GET is requireAuth (nullable DEK — decrypt for display). Writes use
 * requireEncryption (423 without a DEK — they encrypt names / copy ciphertext).
 * Envelope shape ({ success, data }) — the only consumer is the new
 * /settings/securities page. → plan/architecture/securities.md
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql, desc, asc } from "drizzle-orm";

import { db, schema } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import { buildNameFields, decryptName, decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { resolveOrCreateSecurity, gcOrphanSecurity } from "@/lib/securities/resolve";

interface SecurityAccountLink {
  accountId: number;
  accountName: string | null;
  isInvestment: boolean;
  positionId: number;
  isCash: boolean;
}

/**
 * GET /api/securities — every security for the user, each with the accounts
 * (positions) that reference it. Decrypts symbol/name + account names.
 */
export const GET = apiHandler(
  { auth: "auth", fallbackMessage: "Failed to load securities" },
  async ({ userId, dek }) => {
    const secRows = await db
      .select({
        id: schema.securities.id,
        clusterKey: schema.securities.clusterKey,
        assetType: schema.securities.assetType,
        currency: schema.securities.currency,
        isCash: schema.securities.isCash,
        isCrypto: schema.securities.isCrypto,
        image: schema.securities.image,
        symbolCt: schema.securities.symbolCt,
        nameCt: schema.securities.nameCt,
      })
      .from(schema.securities)
      .where(eq(schema.securities.userId, userId));

    const securities = decryptNamedRows(secRows, dek, {
      symbolCt: "symbol",
      nameCt: "name",
    }) as Array<(typeof secRows)[number] & { symbol: string | null; name: string | null }>;

    // Positions per security, with account name + qty (cached) for context.
    const posRows = await db
      .select({
        positionId: schema.portfolioHoldings.id,
        securityId: schema.portfolioHoldings.securityId,
        accountId: schema.portfolioHoldings.accountId,
        isCash: schema.portfolioHoldings.isCash,
        accountNameCt: schema.accounts.nameCt,
        accountIsInvestment: schema.accounts.isInvestment,
      })
      .from(schema.portfolioHoldings)
      .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          sql`${schema.portfolioHoldings.securityId} IS NOT NULL`,
        ),
      );

    const linksBySecurity = new Map<number, SecurityAccountLink[]>();
    for (const p of posRows) {
      if (p.securityId == null || p.accountId == null) continue;
      const accountName = decryptName(p.accountNameCt, dek, null);
      const arr = linksBySecurity.get(p.securityId) ?? [];
      arr.push({
        accountId: p.accountId,
        accountName,
        isInvestment: p.accountIsInvestment === true,
        positionId: p.positionId,
        isCash: p.isCash === true,
      });
      linksBySecurity.set(p.securityId, arr);
    }

    const data = securities
      .map((s) => ({
        id: s.id,
        symbol: s.symbol,
        name: s.name,
        assetType: s.assetType,
        currency: s.currency,
        isCash: s.isCash,
        isCrypto: s.isCrypto === 1,
        image: s.image,
        accounts: (linksBySecurity.get(s.id) ?? []).sort(
          (a, b) => (a.accountName ?? "").localeCompare(b.accountName ?? ""),
        ),
      }))
      .sort((a, b) => {
        // Tickered first, then by display label.
        const al = (a.symbol ?? a.name ?? "").toUpperCase();
        const bl = (b.symbol ?? b.name ?? "").toUpperCase();
        return al.localeCompare(bl);
      });

    return data;
  },
);

// FINLYNQ-201: the user-settable display asset class. `asset_type` is COSMETIC
// — the cluster_key (symbol-based) is the grouping/uniqueness key, so changing
// it NEVER re-clusters (canonical.ts). The badge resolution order is
// user/persisted `asset_type` → live Yahoo quoteType → stock; setting it here is
// the durable user override that always wins.
const ASSET_TYPES = ["stock", "etf", "crypto", "cash", "metal", "custom"] as const;

const patchSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    assetType: z.enum(ASSET_TYPES).optional(),
    // Ticker change = re-cluster (handled BEFORE name/assetType): re-points every
    // member position at the security for the NEW symbol (creating/reusing it),
    // then GCs the old. Its only caller is the unpriceable-ticker advisory on
    // /settings/investments, which sends `symbol` alone.
    symbol: z.string().trim().min(1).max(40).optional(),
  })
  .refine((b) => b.name !== undefined || b.assetType !== undefined || b.symbol !== undefined, {
    message: "Provide a name, assetType, and/or symbol",
  });

/**
 * PATCH /api/securities — update a security's display name and/or asset type.
 *
 * `name` (optional): re-encrypts name_ct/name_lookup AND copies the new name
 * onto every member position (see below).
 * `assetType` (optional, FINLYNQ-201): sets the user-settable ETF-vs-stock (etc.)
 * display class on the `securities` row. Cosmetic — does NOT touch cluster_key,
 * so it NEVER re-clusters; it is the durable user override the badge prefers
 * over Yahoo's quoteType.
 *
 * Neither change touches cluster_key, so a rename / retype never re-clusters.
 *
 * Name propagation (2026-06-17): the rename is ALSO copied onto every member
 * position (`portfolio_holdings` with this `security_id`), so surfaces that read
 * the per-position holding name — the account-detail "Cash sleeves" list, the
 * transactions ledger when the read-flip is OFF — reflect it too, not just the
 * centralized securities row. A security can back several cash sleeves across
 * accounts ("multiple members"); all get the new name. The position's
 * `security_id` is unchanged, so this is a name copy, NOT a re-cluster (no
 * `resolveOrCreateSecurity`). Cash sleeves / custom holdings keep the new name;
 * tickered holdings get re-canonicalized to their symbol on next login (their
 * ledger identity is the symbol anyway).
 */
export const PATCH = apiHandler(
  { auth: "encryption", body: patchSchema, fallbackMessage: "Failed to update security" },
  async ({ userId, dek, body }) => {
    // ── Ticker (symbol) change = RE-CLUSTER. Changing the symbol redefines the
    // security's identity (cluster_key is symbol-derived), so we mirror the
    // per-holding edit path (PUT /api/portfolio): find-or-create the target
    // security for the new ticker, re-point EVERY member position's symbol +
    // security_id at it, then GC the old security if it's now orphaned. Handled
    // before — and exclusive of — the name/assetType path below. ──
    if (body.symbol !== undefined) {
      const sec = await db
        .select({
          id: schema.securities.id,
          symbolCt: schema.securities.symbolCt,
          nameCt: schema.securities.nameCt,
          currency: schema.securities.currency,
          isCrypto: schema.securities.isCrypto,
          isCash: schema.securities.isCash,
        })
        .from(schema.securities)
        .where(and(eq(schema.securities.id, body.id), eq(schema.securities.userId, userId)))
        .get();
      if (!sec) return NextResponse.json({ error: "Security not found" }, { status: 404 });

      const newSymbol = body.symbol.trim();
      const currentSymbol = decryptName(sec.symbolCt, dek!, null);
      if ((currentSymbol ?? "").toUpperCase() === newSymbol.toUpperCase()) {
        // No-op: already on this ticker.
        return { id: sec.id, symbol: newSymbol, positions: 0, repointed: false };
      }
      const name = decryptName(sec.nameCt, dek!, null);

      // Find-or-create the target security for the new ticker (reuses an existing
      // one if the user already holds it — a legitimate merge).
      const targetId = await resolveOrCreateSecurity(userId, dek!, {
        symbol: newSymbol,
        name,
        isCryptoFlag: sec.isCrypto,
        currency: sec.currency,
        isCash: sec.isCash,
      });

      // Re-encrypt the new symbol ONCE; stamp it on every member position and
      // re-point security_id at the target. Only the symbol fields change — the
      // name (and its name_lookup) is untouched, so the per-account name_lookup
      // partial-unique index can't trip.
      const senc = buildNameFields(dek!, { symbol: newSymbol });
      const newSymbolCt = (senc.symbolCt as string | null) ?? null;
      const newSymbolLookup = (senc.symbolLookup as string | null) ?? null;

      const members = await db
        .select({ id: schema.portfolioHoldings.id })
        .from(schema.portfolioHoldings)
        .where(
          and(
            eq(schema.portfolioHoldings.securityId, sec.id),
            eq(schema.portfolioHoldings.userId, userId),
          ),
        );
      let positions = 0;
      for (const m of members) {
        await db
          .update(schema.portfolioHoldings)
          .set({
            symbolCt: newSymbolCt,
            symbolLookup: newSymbolLookup,
            ...(targetId != null ? { securityId: targetId } : {}),
          })
          .where(
            and(
              eq(schema.portfolioHoldings.id, m.id),
              eq(schema.portfolioHoldings.userId, userId),
            ),
          );
        positions++;
      }

      // GC the old security if the re-point left it backing zero positions.
      if (targetId != null && targetId !== sec.id) {
        await gcOrphanSecurity(userId, sec.id);
      }
      return { id: sec.id, newSecurityId: targetId, symbol: newSymbol, positions };
    }

    // Build the SET partial: asset_type and/or the re-encrypted name.
    const setFields: Record<string, unknown> = { updatedAt: sql`NOW()` };
    let nameCt: string | null = null;
    let nameLookup: string | null = null;
    const renaming = body.name !== undefined;
    if (renaming) {
      const enc = buildNameFields(dek!, { name: body.name! });
      nameCt = (enc.nameCt as string | null) ?? null;
      nameLookup = (enc.nameLookup as string | null) ?? null;
      setFields.nameCt = nameCt;
      setFields.nameLookup = nameLookup;
    }
    if (body.assetType !== undefined) setFields.assetType = body.assetType;

    const updated = await db
      .update(schema.securities)
      .set(setFields)
      .where(and(eq(schema.securities.id, body.id), eq(schema.securities.userId, userId)))
      .returning({ id: schema.securities.id });
    if (updated.length === 0) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
    }
    // Only the name change propagates to member positions; asset_type lives on
    // the securities row alone (display-only, no per-position column).
    if (!renaming) {
      return { id: body.id, assetType: body.assetType, positions: 0, skipped: 0 };
    }
    // Copy the rename down onto every member position — ONE AT A TIME, not a
    // single atomic batch. A stray member (e.g. a non-cash holding mis-linked
    // to a cash security, or a legacy duplicate) sharing an account with a
    // legitimate member would make both end up with the same name → the
    // (user,account,name_lookup) partial unique index trips. A batch UPDATE then
    // fails ATOMICALLY and renames NOTHING; per-member updates rename every good
    // position and skip only the colliding stray. Cash sleeves are renamed FIRST
    // (is_cash DESC) so they win the name and the stray is the one skipped.
    const members = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.securityId, body.id),
          eq(schema.portfolioHoldings.userId, userId),
        ),
      )
      .orderBy(desc(schema.portfolioHoldings.isCash), asc(schema.portfolioHoldings.id));
    let positions = 0;
    let skipped = 0;
    for (const m of members) {
      try {
        await db
          .update(schema.portfolioHoldings)
          .set({ nameCt, nameLookup })
          .where(
            and(
              eq(schema.portfolioHoldings.id, m.id),
              eq(schema.portfolioHoldings.userId, userId),
            ),
          );
        positions++;
      } catch {
        // Same-account name collision for this member — leave it as-is.
        skipped++;
      }
    }
    return { id: body.id, name: body.name, positions, skipped };
  },
);

const postSchema = z.object({
  securityId: z.number().int().positive(),
  accountId: z.number().int().positive(),
});

/**
 * POST /api/securities — link a security to an account: create a position
 * (portfolio_holdings) in that account that copies the security's encrypted
 * identity + security_id, plus the mandatory holding_accounts pairing. Refuses
 * (409) when the account already holds this security.
 */
export const POST = apiHandler(
  { auth: "encryption", body: postSchema, fallbackMessage: "Failed to link security" },
  async ({ userId, body }) => {
    const sec = await db
      .select({
        id: schema.securities.id,
        currency: schema.securities.currency,
        isCash: schema.securities.isCash,
        isCrypto: schema.securities.isCrypto,
        symbolCt: schema.securities.symbolCt,
        symbolLookup: schema.securities.symbolLookup,
        nameCt: schema.securities.nameCt,
        nameLookup: schema.securities.nameLookup,
      })
      .from(schema.securities)
      .where(and(eq(schema.securities.id, body.securityId), eq(schema.securities.userId, userId)))
      .get();
    if (!sec) return NextResponse.json({ error: "Security not found" }, { status: 404 });

    const acct = await db
      .select({ id: schema.accounts.id, currency: schema.accounts.currency })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, body.accountId), eq(schema.accounts.userId, userId)))
      .get();
    if (!acct) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    // Already linked? (a position for this security in this account)
    const existing = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          eq(schema.portfolioHoldings.accountId, body.accountId),
          eq(schema.portfolioHoldings.securityId, body.securityId),
        ),
      )
      .get();
    if (existing) {
      return NextResponse.json(
        { error: "This account already holds the security", positionId: existing.id },
        { status: 409 },
      );
    }

    // Create the position, copying the security's ciphertext verbatim (same
    // DEK). Then the mandatory holding_accounts dual-write.
    const inserted = await db
      .insert(schema.portfolioHoldings)
      .values({
        userId,
        accountId: body.accountId,
        currency: sec.currency,
        isCrypto: sec.isCrypto ?? 0,
        isCash: sec.isCash,
        securityId: sec.id,
        note: "linked via securities page",
        nameCt: sec.nameCt,
        nameLookup: sec.nameLookup,
        symbolCt: sec.symbolCt,
        symbolLookup: sec.symbolLookup,
      })
      .returning({ id: schema.portfolioHoldings.id });
    const positionId = Array.isArray(inserted) ? inserted[0]?.id : undefined;
    if (positionId == null) {
      return NextResponse.json({ error: "Failed to create position" }, { status: 500 });
    }
    try {
      await db
        .insert(schema.holdingAccounts)
        .values({ holdingId: positionId, accountId: body.accountId, userId, qty: 0, costBasis: 0, isPrimary: true })
        .onConflictDoNothing();
    } catch (pairingErr) {
      await db
        .delete(schema.portfolioHoldings)
        .where(and(eq(schema.portfolioHoldings.id, positionId), eq(schema.portfolioHoldings.userId, userId)));
      throw pairingErr;
    }

    return { positionId, securityId: sec.id, accountId: body.accountId };
  },
);

/**
 * DELETE /api/securities?positionId=N — unlink a security from an account by
 * deleting that position. Refuses (409) when the position has ledger
 * transactions (those carry cost basis / lots — manage from /portfolio).
 */
export const DELETE = apiHandler(
  { auth: "encryption", fallbackMessage: "Failed to unlink security" },
  async ({ request, userId }) => {
    const positionIdRaw = request.nextUrl.searchParams.get("positionId");
    const positionId = positionIdRaw ? parseInt(positionIdRaw, 10) : NaN;
    if (!Number.isFinite(positionId) || positionId <= 0) {
      return NextResponse.json({ error: "Missing or invalid positionId" }, { status: 400 });
    }

    const pos = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(and(eq(schema.portfolioHoldings.id, positionId), eq(schema.portfolioHoldings.userId, userId)))
      .get();
    if (!pos) return NextResponse.json({ error: "Position not found" }, { status: 404 });

    // Guard: refuse to delete a position that has ledger transactions.
    const txCount = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.portfolioHoldingId, positionId),
        ),
      )
      .limit(1);
    if (txCount.length > 0) {
      return NextResponse.json(
        { error: "This position has transactions; manage it from the Portfolio page." },
        { status: 409 },
      );
    }

    // Delete the holding_accounts pairing(s) then the position. The security
    // row is left intact (it may still back other accounts' positions, and is
    // recreated by the login backfill if all positions are removed).
    await db
      .delete(schema.holdingAccounts)
      .where(and(eq(schema.holdingAccounts.holdingId, positionId), eq(schema.holdingAccounts.userId, userId)));
    await db
      .delete(schema.portfolioHoldings)
      .where(and(eq(schema.portfolioHoldings.id, positionId), eq(schema.portfolioHoldings.userId, userId)));

    return { success: true };
  },
);
