import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getPortfolioHoldings } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptName, decryptNamedRows, nameLookup } from "@/lib/crypto/encrypted-columns";
import { isSupportedCurrency, isMetalCurrency } from "@/lib/fx/supported-currencies";

/**
 * A row is "canonical" (its display name is auto-managed) when:
 *   - it has a non-empty symbol that isn't a currency code → tickered;
 *     canonical name = uppercased symbol.
 *   - it has a currency-code symbol (CAD/USD/XAU/etc.) → cash-as-currency;
 *     canonical name = "Cash <SYMBOL>".
 *   - name === "Cash" with no symbol → cash sleeve; canonical name = "Cash".
 *
 * Editing the Name on these rows is a no-op (the canonicalize helper would
 * rewrite it on next login) and confuses the user, so we reject it at the
 * API. Symbol / currency / isCrypto / note remain editable; renaming a
 * tickered position is done by changing its symbol.
 *
 * Mirrors the classifier in src/lib/crypto/stream-d-canonicalize-portfolio.ts.
 */
function isCanonicalHolding(name: string | null, symbol: string | null): boolean {
  const sym = (symbol ?? "").trim().toUpperCase();
  const nm = (name ?? "").trim();
  if (sym && /^[A-Z]{3,4}$/.test(sym) && (isSupportedCurrency(sym) || isMetalCurrency(sym))) return true;
  if (sym) return true;
  if (!sym && nm.toLowerCase() === "cash") return true;
  return false;
}

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

// Currency: any 3-4 letter ISO 4217 code, normalized to uppercase. Was
// previously z.enum(["CAD","USD"]) which silently rejected EUR/GBP/BTC etc.
// — fixed 2026-04-27 alongside the holding-currency redesign.
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3,4}$/, "Currency must be a 3-4 letter ISO 4217 code");

const postSchema = z.object({
  name: z.string().min(1).max(200),
  accountId: z.number().int(),
  symbol: z.string().max(50).nullable().optional(),
  currency: currencyCode.optional(),
  isCrypto: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

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
    const parsed = validateBody(body, postSchema);
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

    try {
      const holding = await db
        .insert(schema.portfolioHoldings)
        .values({
          name,
          symbol: symbolValue,
          accountId,
          currency: currency ?? acct.currency ?? "CAD",
          isCrypto: isCrypto ? 1 : 0,
          note: note ?? "",
          userId: auth.userId,
          ...enc,
        })
        .returning()
        .get();
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

const putSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(200).optional(),
  symbol: z.string().max(50).nullable().optional(),
  currency: currencyCode.optional(),
  isCrypto: z.number().int().min(0).max(1).optional(),
  note: z.string().max(500).optional(),
});

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
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;

    const existing = await db
      .select({
        id: schema.portfolioHoldings.id,
        name: schema.portfolioHoldings.name,
        nameCt: schema.portfolioHoldings.nameCt,
        symbol: schema.portfolioHoldings.symbol,
        symbolCt: schema.portfolioHoldings.symbolCt,
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

    // Section F (issue #25): block Name edits on canonical rows. The
    // canonicalize helper would rewrite a user-typed name back to symbol /
    // "Cash" / "Cash <CCY>" on next login, so silently dropping the edit is
    // worse than rejecting it up front. Symbol / currency / isCrypto / note
    // are still editable — change the symbol to rename a tickered position.
    if (data.name !== undefined) {
      const currentName = decryptName(existing.nameCt, auth.dek, existing.name);
      const currentSymbol = decryptName(existing.symbolCt, auth.dek, existing.symbol);
      // The "next" symbol is the about-to-write value when the user is also
      // editing symbol; otherwise the existing symbol. Likewise for the row
      // type on cash-sleeve rows (no symbol → name "Cash" gates).
      const nextSymbol = data.symbol !== undefined
        ? (data.symbol && data.symbol.trim() ? data.symbol.trim() : null)
        : currentSymbol;
      if (isCanonicalHolding(currentName, nextSymbol)) {
        return NextResponse.json(
          { error: "name is auto-managed for this holding type — edit the symbol or currency to rename" },
          { status: 400 },
        );
      }
    }

    // buildNameFields takes only the keys we want to re-encrypt — name and/or
    // symbol — and returns { nameCt, nameLookup, symbolCt, symbolLookup } as
    // appropriate. Spread alongside the plaintext UPDATE.
    const encFields: Record<string, string | null> = {};
    if (data.name !== undefined) {
      Object.assign(encFields, buildNameFields(auth.dek, { name: data.name }));
    }
    if (data.symbol !== undefined) {
      const symbolValue = data.symbol && data.symbol.trim() ? data.symbol.trim() : null;
      data.symbol = symbolValue;
      Object.assign(encFields, buildNameFields(auth.dek, { symbol: symbolValue }));
    }

    try {
      const updated = await db
        .update(schema.portfolioHoldings)
        .set({ ...data, ...encFields })
        .where(
          and(
            eq(schema.portfolioHoldings.id, id),
            eq(schema.portfolioHoldings.userId, auth.userId),
          ),
        )
        .returning()
        .get();
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
