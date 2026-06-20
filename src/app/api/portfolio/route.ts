import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getPortfolioHoldings } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptName, decryptNamedRows, nameLookup } from "@/lib/crypto/encrypted-columns";
import { resolveOrCreateSecurity, gcOrphanSecurity } from "@/lib/securities/resolve";
import {
  holdingCreateSchema,
  holdingUpdateSchema,
} from "@/lib/schemas/holding";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const rows = await getPortfolioHoldings(auth.context.userId);
  // Stream D: holdings carry name_ct/symbol_ct/account.name_ct alongside the
  // plaintext columns. Past Phase 3 cutover the plaintext columns are NULL on
  // disk, so the dropdown in Add Transaction (and any other consumer) sees
  // {name: null, symbol: null, accountName: null} unless we decrypt here.
  // Mirrors /api/portfolio/overview and /api/accounts.
  const data = decryptNamedRows(rows, auth.context.dek, {
    nameCt: "name",
    symbolCt: "symbol",
    accountNameCt: "accountName",
  });
  return NextResponse.json(data);
}

/**
 * POST /api/portfolio — create a new portfolio holding.
 *
 * Stream D dual-write: persists name_ct/name_lookup + symbol_ct/symbol_lookup
 * alongside the plaintext columns. Requires an unlocked session DEK because
 * Phase 3 prod has plaintext NULL'd on existing rows; writing plaintext-only
 * here would create a row that's invisible to every other read path.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, holdingCreateSchema);
    if (parsed.error) return parsed.error;
    const { name, accountId, symbol, currency, isCrypto, note } = parsed.data;

    const acct = await db
      .select({ id: schema.accounts.id, currency: schema.accounts.currency })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, auth.userId)))
      .get();
    if (!acct) return NextResponse.json({ error: "Account not found" }, { status: 404 });

    // Pre-check duplicate against name_lookup (HMAC) — partial UNIQUE on
    // (user_id, account_id, name_lookup) is the DB backstop, but a friendly
    // pre-check beats raising 23505.
    const lookup = nameLookup(auth.dek, name);
    const dup = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, auth.userId),
          eq(schema.portfolioHoldings.accountId, accountId),
          eq(schema.portfolioHoldings.nameLookup, lookup),
        ),
      )
      .get();
    if (dup) {
      return NextResponse.json(
        { error: `Holding "${name}" already exists in this account` },
        { status: 409 },
      );
    }

    const symbolValue = symbol && symbol.trim() ? symbol.trim() : null;
    const enc = buildNameFields(auth.dek, { name, symbol: symbolValue });
    // Securities master (Phase B) — resolve the shared identity before insert.
    const holdingCurrency = currency ?? acct.currency ?? "CAD";
    const securityId = await resolveOrCreateSecurity(auth.userId, auth.dek, {
      symbol: symbolValue,
      name,
      isCryptoFlag: !!isCrypto,
      isCash: false,
      currency: holdingCurrency,
    });

    try {
      // Stream D Phase 4 — plaintext name/symbol dropped.
      const holding = await db
        .insert(schema.portfolioHoldings)
        .values({
          accountId,
          currency: holdingCurrency,
          isCrypto: isCrypto ? 1 : 0,
          securityId,
          note: note ?? "",
          userId: auth.userId,
          ...enc,
        })
        .returning()
        .get();
      // Issue #205 — dual-write holding_accounts pairing. Every aggregator
      // (issue #25) JOINs through holding_accounts on (holding_id, account_id,
      // user_id); without the pairing, the holding is invisible to
      // get_portfolio_analysis / get_portfolio_performance / analyze_holding
      // (live SUM(transactions.quantity) evaluates to 0). is_primary=true on
      // the fresh row mirrors the legacy portfolio_holdings.account_id column.
      // qty=0/cost_basis=0 are CACHED defaults — aggregators read live values
      // from transactions (CLAUDE.md #99 trap; do NOT compute live sums here).
      // On pairing failure, DELETE the orphan portfolio_holdings row so we
      // never leave the user with an aggregator-invisible holding.
      try {
        await db
          .insert(schema.holdingAccounts)
          .values({
            holdingId: holding.id,
            accountId,
            userId: auth.userId,
            qty: 0,
            costBasis: 0,
            isPrimary: true,
          })
          .onConflictDoNothing();
      } catch (pairingErr) {
        await db
          .delete(schema.portfolioHoldings)
          .where(
            and(
              eq(schema.portfolioHoldings.id, holding.id),
              eq(schema.portfolioHoldings.userId, auth.userId),
            ),
          );
        throw pairingErr;
      }
      return NextResponse.json(holding, { status: 201 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
        return NextResponse.json(
          { error: `Holding "${name}" already exists in this account` },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    await logApiError("POST", "/api/portfolio", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create holding") }, { status: 500 });
  }
}

/**
 * PUT /api/portfolio — update an existing portfolio holding.
 *
 * Renames cascade to all transactions automatically: the aggregator groups by
 * `transactions.portfolio_holding_id` (integer FK) and JOINs to
 * `portfolio_holdings` for the display name.
 *
 * Stream D dual-write: name_ct/name_lookup + symbol_ct/symbol_lookup are
 * regenerated whenever name or symbol changes. Requires an unlocked session
 * DEK — see POST docstring above.
 */
export async function PUT(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, holdingUpdateSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;

    // Stream D Phase 4 — plaintext name/symbol dropped.
    const existing = await db
      .select({
        id: schema.portfolioHoldings.id,
        nameCt: schema.portfolioHoldings.nameCt,
        symbolCt: schema.portfolioHoldings.symbolCt,
        securityId: schema.portfolioHoldings.securityId,
        currency: schema.portfolioHoldings.currency,
        isCrypto: schema.portfolioHoldings.isCrypto,
        isCash: schema.portfolioHoldings.isCash,
      })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.id, id),
          eq(schema.portfolioHoldings.userId, auth.userId),
        ),
      )
      .get();
    if (!existing) {
      return NextResponse.json({ error: "Holding not found" }, { status: 404 });
    }

    // Decrypt the current identity once, then derive the EFFECTIVE post-edit
    // identity — a field the caller didn't send keeps its current value. Used
    // by the securities-master re-resolve below. (FINLYNQ-198: the former
    // canonical-name guard that 400'd Name edits on tickered/cash rows was
    // retired — names are now managed at the `securities` level, so a
    // per-position Name edit is a legitimate write again.)
    const currentName = decryptName(existing.nameCt, auth.dek, null);
    const currentSymbol = decryptName(existing.symbolCt, auth.dek, null);
    const nextName = data.name !== undefined ? data.name : currentName;
    const nextSymbol =
      data.symbol !== undefined
        ? (data.symbol && data.symbol.trim() ? data.symbol.trim() : null)
        : currentSymbol;
    const nextCurrency = data.currency !== undefined ? data.currency : existing.currency;
    const nextIsCrypto =
      data.isCrypto !== undefined ? data.isCrypto === 1 : existing.isCrypto === 1;

    // Stream D Phase 4 — plaintext name/symbol dropped. Re-encrypt and strip
    // the plaintext keys from the UPDATE set.
    const encFields: Record<string, string | null> = {};
    if (data.name !== undefined) {
      Object.assign(encFields, buildNameFields(auth.dek, { name: data.name }));
    }
    if (data.symbol !== undefined) {
      const symbolValue = data.symbol && data.symbol.trim() ? data.symbol.trim() : null;
      Object.assign(encFields, buildNameFields(auth.dek, { symbol: symbolValue }));
    }
    const dataNoNames = { ...data };
    delete (dataNoNames as Record<string, unknown>).name;
    delete (dataNoNames as Record<string, unknown>).symbol;

    // Securities master edit-path dual-write — when an identity field changes
    // (symbol / name / currency / isCrypto) the position must re-cluster under
    // the NEW identity instead of clinging to its old security_id (e.g.
    // GOOGL → GOOG has to move to the GOOG security). Mirrors the INSERT-side
    // dual-write; runs regardless of the read-flip flag (writes always link).
    // Never overwrite a live security_id with null — an un-clusterable resolve
    // leaves it for the login backfill to heal. → securities.md
    const identityChanged =
      data.symbol !== undefined ||
      data.name !== undefined ||
      data.currency !== undefined ||
      data.isCrypto !== undefined;
    let newSecurityId: number | null = existing.securityId;
    if (identityChanged) {
      const resolved = await resolveOrCreateSecurity(auth.userId, auth.dek, {
        symbol: nextSymbol,
        name: nextName,
        isCryptoFlag: nextIsCrypto,
        isCash: existing.isCash === true,
        currency: nextCurrency,
      });
      if (resolved != null) newSecurityId = resolved;
    }
    const securityIdChanged = newSecurityId !== existing.securityId;

    try {
      const updated = await db
        .update(schema.portfolioHoldings)
        .set({
          ...dataNoNames,
          ...encFields,
          ...(securityIdChanged ? { securityId: newSecurityId } : {}),
        })
        .where(
          and(
            eq(schema.portfolioHoldings.id, id),
            eq(schema.portfolioHoldings.userId, auth.userId),
          ),
        )
        .returning()
        .get();
      // GC the prior security if this edit left it backing zero positions.
      if (securityIdChanged) await gcOrphanSecurity(auth.userId, existing.securityId);
      return NextResponse.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
        return NextResponse.json(
          { error: "Another holding with this name already exists in this account" },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    await logApiError("PUT", "/api/portfolio", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update holding") }, { status: 500 });
  }
}

/**
 * DELETE /api/portfolio?id=N — remove a holding.
 *
 * The FK `transactions.portfolio_holding_id … ON DELETE SET NULL` auto-NULLs
 * referencing rows. Transactions survive (no data loss) but disappear from
 * the portfolio aggregator until reassigned. The response reports the count
 * of unlinked transactions for transparency.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    // Count referencing transactions before delete so we can report it.
    const txnCount = await db
      .select({ cnt: sql<number>`COUNT(*)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, auth.context.userId),
          eq(schema.transactions.portfolioHoldingId, id),
        ),
      )
      .get();
    const unlinked = Number(txnCount?.cnt ?? 0);

    const result = await db
      .delete(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.id, id),
          eq(schema.portfolioHoldings.userId, auth.context.userId),
        ),
      )
      .returning({ id: schema.portfolioHoldings.id })
      .all();
    if (result.length === 0) {
      return NextResponse.json({ error: "Holding not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, unlinkedTransactions: unlinked });
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/portfolio", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to delete holding") }, { status: 500 });
  }
}
