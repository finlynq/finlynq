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

const patchSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
});

/**
 * PATCH /api/securities — rename a security's display name. Re-encrypts
 * name_ct/name_lookup; does NOT touch cluster_key (renaming never re-clusters).
 *
 * Propagation (2026-06-17): the rename is ALSO copied onto every member position
 * (`portfolio_holdings` with this `security_id`), so surfaces that read the
 * per-position holding name — the account-detail "Cash sleeves" list, the
 * transactions ledger when the read-flip is OFF — reflect it too, not just the
 * centralized securities row. A security can back several cash sleeves across
 * accounts ("multiple members"); all get the new name. The position's
 * `security_id` is unchanged, so this is a name copy, NOT a re-cluster (no
 * `resolveOrCreateSecurity`). Cash sleeves / custom holdings keep the new name;
 * tickered holdings get re-canonicalized to their symbol on next login (their
 * ledger identity is the symbol anyway).
 */
export const PATCH = apiHandler(
  { auth: "encryption", body: patchSchema, fallbackMessage: "Failed to rename security" },
  async ({ userId, dek, body }) => {
    const enc = buildNameFields(dek!, { name: body.name });
    const nameCt = (enc.nameCt as string | null) ?? null;
    const nameLookup = (enc.nameLookup as string | null) ?? null;
    const updated = await db
      .update(schema.securities)
      .set({ nameCt, nameLookup, updatedAt: sql`NOW()` })
      .where(and(eq(schema.securities.id, body.id), eq(schema.securities.userId, userId)))
      .returning({ id: schema.securities.id });
    if (updated.length === 0) {
      return NextResponse.json({ error: "Security not found" }, { status: 404 });
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
