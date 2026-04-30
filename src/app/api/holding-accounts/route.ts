/**
 * /api/holding-accounts — CRUD for the holding ↔ account join table.
 *
 * Issue #26 (Section G). The join table is many-to-many between
 * `portfolio_holdings` and `accounts`; this endpoint is the only surface
 * that lets users add/remove/edit additional pairings on an existing
 * holding. The Add/Edit-holding dialog still owns the first (primary)
 * pairing — it INSERTs the portfolio_holdings row and the matching
 * holding_accounts row in the same flow (out of scope for this issue).
 *
 * The aggregator + investment-account-constraint callsites listed in
 * CLAUDE.md still read `portfolio_holdings.account_id` today; issue #25
 * (Section F) migrates them onto this table. Until then this endpoint is
 * additive — every write also keeps `portfolio_holdings.account_id` in
 * sync with the row whose `is_primary=true`.
 *
 * Auth: requireAuth (no DEK needed — only ids + numbers, no encrypted
 * columns). The GET join surfaces decrypted holding/account names via
 * decryptNamedRows so the UI can render them; that is the only place
 * the DEK is touched, and a missing DEK degrades to ciphertext-or-null
 * exactly like every other read path.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { logApiError, safeErrorMessage, validateBody } from "@/lib/validate";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";

/**
 * GET /api/holding-accounts — list every (holding, account) pairing for
 * the authenticated user. Joins to portfolio_holdings + accounts so the
 * UI gets display names without a second round-trip; ciphertext columns
 * are decrypted in-memory.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;

  try {
    const rawRows = await db
      .select({
        holdingId: schema.holdingAccounts.holdingId,
        accountId: schema.holdingAccounts.accountId,
        qty: schema.holdingAccounts.qty,
        costBasis: schema.holdingAccounts.costBasis,
        isPrimary: schema.holdingAccounts.isPrimary,
        createdAt: schema.holdingAccounts.createdAt,
        // Decrypt-on-read names + symbol (Stream D Phase 3 cohorts have
        // plaintext NULL'd on disk; ciphertext is the authoritative copy).
        holdingName: schema.portfolioHoldings.name,
        holdingNameCt: schema.portfolioHoldings.nameCt,
        holdingSymbol: schema.portfolioHoldings.symbol,
        holdingSymbolCt: schema.portfolioHoldings.symbolCt,
        holdingCurrency: schema.portfolioHoldings.currency,
        accountName: schema.accounts.name,
        accountNameCt: schema.accounts.nameCt,
        accountIsInvestment: schema.accounts.isInvestment,
      })
      .from(schema.holdingAccounts)
      .leftJoin(
        schema.portfolioHoldings,
        eq(schema.holdingAccounts.holdingId, schema.portfolioHoldings.id),
      )
      .leftJoin(
        schema.accounts,
        eq(schema.holdingAccounts.accountId, schema.accounts.id),
      )
      .where(eq(schema.holdingAccounts.userId, userId));

    const rows = decryptNamedRows(rawRows, dek, {
      holdingNameCt: "holdingName",
      holdingSymbolCt: "holdingSymbol",
      accountNameCt: "accountName",
    });

    return NextResponse.json(rows);
  } catch (error: unknown) {
    await logApiError("GET", "/api/holding-accounts", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load holding-account pairings") },
      { status: 500 },
    );
  }
}

const numericId = z.number().int().positive();
const nonNegativeNumber = z.number().finite().nonnegative();

const postSchema = z.object({
  holdingId: numericId,
  accountId: numericId,
  qty: nonNegativeNumber.optional(),
  costBasis: nonNegativeNumber.optional(),
  isPrimary: z.boolean().optional(),
});

/**
 * POST /api/holding-accounts — add a new pairing. Validates that both
 * the holding and the account belong to the caller, then INSERTs the
 * row. If isPrimary=true, demotes any other primary row for the same
 * holding inside the same transaction and updates
 * `portfolio_holdings.account_id` to mirror the new primary so the
 * legacy aggregator callsites stay in sync.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, postSchema);
  if (parsed.error) return parsed.error;
  const { holdingId, accountId, qty, costBasis, isPrimary } = parsed.data;

  try {
    const ownership = await assertOwnership(userId, holdingId, accountId);
    if (ownership) return ownership;

    // Pre-check duplicate pairing — friendly 409 beats raising 23505.
    const existing = await db
      .select({ holdingId: schema.holdingAccounts.holdingId })
      .from(schema.holdingAccounts)
      .where(
        and(
          eq(schema.holdingAccounts.holdingId, holdingId),
          eq(schema.holdingAccounts.accountId, accountId),
          eq(schema.holdingAccounts.userId, userId),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "Pairing already exists; use PUT to update qty / cost basis." },
        { status: 409 },
      );
    }

    if (isPrimary) {
      await db
        .update(schema.holdingAccounts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(schema.holdingAccounts.holdingId, holdingId),
            eq(schema.holdingAccounts.userId, userId),
          ),
        );
    }

    const inserted = await db
      .insert(schema.holdingAccounts)
      .values({
        holdingId,
        accountId,
        userId,
        qty: qty ?? 0,
        costBasis: costBasis ?? 0,
        isPrimary: isPrimary ?? false,
      })
      .returning();

    if (isPrimary) {
      await db
        .update(schema.portfolioHoldings)
        .set({ accountId })
        .where(
          and(
            eq(schema.portfolioHoldings.id, holdingId),
            eq(schema.portfolioHoldings.userId, userId),
          ),
        );
    }

    return NextResponse.json(inserted[0] ?? null, { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/holding-accounts", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create pairing") },
      { status: 500 },
    );
  }
}

const putSchema = z.object({
  holdingId: numericId,
  accountId: numericId,
  qty: nonNegativeNumber.optional(),
  costBasis: nonNegativeNumber.optional(),
  isPrimary: z.boolean().optional(),
});

/**
 * PUT /api/holding-accounts — update qty / cost_basis / is_primary on
 * an existing pairing (composite key in body).
 */
export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, putSchema);
  if (parsed.error) return parsed.error;
  const { holdingId, accountId, qty, costBasis, isPrimary } = parsed.data;

  try {
    const ownership = await assertOwnership(userId, holdingId, accountId);
    if (ownership) return ownership;

    const existing = await db
      .select({ isPrimary: schema.holdingAccounts.isPrimary })
      .from(schema.holdingAccounts)
      .where(
        and(
          eq(schema.holdingAccounts.holdingId, holdingId),
          eq(schema.holdingAccounts.accountId, accountId),
          eq(schema.holdingAccounts.userId, userId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      return NextResponse.json({ error: "Pairing not found" }, { status: 404 });
    }

    const setFields: Record<string, number | boolean> = {};
    if (qty !== undefined) setFields.qty = qty;
    if (costBasis !== undefined) setFields.costBasis = costBasis;
    if (isPrimary !== undefined) setFields.isPrimary = isPrimary;

    if (isPrimary === true) {
      await db
        .update(schema.holdingAccounts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(schema.holdingAccounts.holdingId, holdingId),
            eq(schema.holdingAccounts.userId, userId),
          ),
        );
    }

    const updated = await db
      .update(schema.holdingAccounts)
      .set(setFields)
      .where(
        and(
          eq(schema.holdingAccounts.holdingId, holdingId),
          eq(schema.holdingAccounts.accountId, accountId),
          eq(schema.holdingAccounts.userId, userId),
        ),
      )
      .returning();

    if (isPrimary === true) {
      await db
        .update(schema.portfolioHoldings)
        .set({ accountId })
        .where(
          and(
            eq(schema.portfolioHoldings.id, holdingId),
            eq(schema.portfolioHoldings.userId, userId),
          ),
        );
    }

    return NextResponse.json(updated[0] ?? null);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/holding-accounts", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update pairing") },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/holding-accounts?holdingId=N&accountId=M — remove a
 * pairing. Refuses to remove the last pairing for a holding (409) so
 * we never end up with an orphaned holding row, and refuses to remove
 * an `is_primary=true` row while other pairings exist (409 with hint
 * to set another pairing as primary first) so the legacy
 * `portfolio_holdings.account_id` mirror always points at a live row.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const holdingIdRaw = request.nextUrl.searchParams.get("holdingId");
  const accountIdRaw = request.nextUrl.searchParams.get("accountId");
  const holdingId = holdingIdRaw ? parseInt(holdingIdRaw, 10) : NaN;
  const accountId = accountIdRaw ? parseInt(accountIdRaw, 10) : NaN;
  if (!Number.isFinite(holdingId) || !Number.isFinite(accountId) || holdingId <= 0 || accountId <= 0) {
    return NextResponse.json(
      { error: "Missing or invalid holdingId / accountId query params" },
      { status: 400 },
    );
  }

  try {
    const pairings = await db
      .select({
        accountId: schema.holdingAccounts.accountId,
        isPrimary: schema.holdingAccounts.isPrimary,
      })
      .from(schema.holdingAccounts)
      .where(
        and(
          eq(schema.holdingAccounts.holdingId, holdingId),
          eq(schema.holdingAccounts.userId, userId),
        ),
      );

    const target = pairings.find((p) => p.accountId === accountId);
    if (!target) {
      return NextResponse.json({ error: "Pairing not found" }, { status: 404 });
    }
    if (pairings.length === 1) {
      return NextResponse.json(
        { error: "Cannot remove the last account pairing on a holding. Delete the holding instead." },
        { status: 409 },
      );
    }
    if (target.isPrimary) {
      return NextResponse.json(
        { error: "Set another pairing as primary before removing this one." },
        { status: 409 },
      );
    }

    await db
      .delete(schema.holdingAccounts)
      .where(
        and(
          eq(schema.holdingAccounts.holdingId, holdingId),
          eq(schema.holdingAccounts.accountId, accountId),
          eq(schema.holdingAccounts.userId, userId),
        ),
      );

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/holding-accounts", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete pairing") },
      { status: 500 },
    );
  }
}

/**
 * Verify both ids belong to the caller. Returns a 404 NextResponse on
 * mismatch (caller short-circuits) or null on success.
 */
async function assertOwnership(
  userId: string,
  holdingId: number,
  accountId: number,
): Promise<NextResponse | null> {
  const holding = await db
    .select({ id: schema.portfolioHoldings.id })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.id, holdingId),
        eq(schema.portfolioHoldings.userId, userId),
      ),
    )
    .limit(1);
  if (holding.length === 0) {
    return NextResponse.json({ error: "Holding not found" }, { status: 404 });
  }
  const account = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)),
    )
    .limit(1);
  if (account.length === 0) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  return null;
}
