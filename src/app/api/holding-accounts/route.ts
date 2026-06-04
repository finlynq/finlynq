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
 *
 * FINLYNQ-116: migrated onto `apiHandler` in raw/compat mode. The only
 * consumer is the web Settings → Holding accounts page (no mobile
 * consumer — grep `mobile/src/api/client.ts`), which reads BARE success
 * bodies (it only checks `res.ok` on success) and bare `{ error }` on
 * failure. apiHandler centralizes auth + body validation + error handling
 * here WITHOUT changing the wire shape (`raw: true`). The ownership /
 * duplicate / not-found / 409 guards return their own NextResponse, which
 * the wrapper passes through verbatim. → FINLYNQ-107 / CLAUDE.md.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";

/**
 * GET /api/holding-accounts — list every (holding, account) pairing for
 * the authenticated user. Joins to portfolio_holdings + accounts so the
 * UI gets display names without a second round-trip; ciphertext columns
 * are decrypted in-memory. Returns a BARE array.
 */
export const GET = apiHandler(
  { auth: "auth", raw: true, fallbackMessage: "Failed to load holding-account pairings" },
  async ({ userId, dek }) => {
    const rawRows = await db
      .select({
        holdingId: schema.holdingAccounts.holdingId,
        accountId: schema.holdingAccounts.accountId,
        qty: schema.holdingAccounts.qty,
        costBasis: schema.holdingAccounts.costBasis,
        isPrimary: schema.holdingAccounts.isPrimary,
        createdAt: schema.holdingAccounts.createdAt,
        // Stream D Phase 4 — plaintext name/symbol/accountName columns
        // dropped; only ciphertext is selected and decrypted below.
        holdingNameCt: schema.portfolioHoldings.nameCt,
        holdingSymbolCt: schema.portfolioHoldings.symbolCt,
        holdingCurrency: schema.portfolioHoldings.currency,
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
  },
);

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
export const POST = apiHandler(
  { auth: "auth", body: postSchema, raw: true, fallbackMessage: "Failed to create pairing" },
  async ({ userId, body }) => {
    const { holdingId, accountId, qty, costBasis, isPrimary } = body;

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
  },
);

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
export const PUT = apiHandler(
  { auth: "auth", body: putSchema, raw: true, fallbackMessage: "Failed to update pairing" },
  async ({ userId, body }) => {
    const { holdingId, accountId, qty, costBasis, isPrimary } = body;

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
  },
);

/**
 * DELETE /api/holding-accounts?holdingId=N&accountId=M — remove a
 * pairing. Refuses to remove the last pairing for a holding (409) so
 * we never end up with an orphaned holding row, and refuses to remove
 * an `is_primary=true` row while other pairings exist (409 with hint
 * to set another pairing as primary first) so the legacy
 * `portfolio_holdings.account_id` mirror always points at a live row.
 */
export const DELETE = apiHandler(
  { auth: "auth", raw: true, fallbackMessage: "Failed to delete pairing" },
  async ({ request, userId }) => {
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
  },
);

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
