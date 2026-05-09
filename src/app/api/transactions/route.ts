import { NextRequest, NextResponse } from "next/server";
import { getTransactions, getTransactionCount, createTransaction, updateTransaction, deleteTransaction, getAccountById, type TxSortFilter } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { getDEK } from "@/lib/crypto/dek-cache";
import { encryptTxWrite, decryptTxRows, filterDecryptedBySearch, nameLookup, decryptName } from "@/lib/crypto/encrypted-columns";
import { decryptField } from "@/lib/crypto/envelope";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { buildHoldingResolver } from "@/lib/external-import/portfolio-holding-resolver";
import { convertToAccountCurrency } from "@/lib/currency-conversion";
import { InvestmentHoldingRequiredError } from "@/lib/investment-account";
import { SignCategoryMismatchError } from "@/lib/transactions/sign-category-invariant";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { isSortableColumnId } from "@/lib/transactions/columns";
import { isTransactionSource, type TransactionSource } from "@/lib/tx-source";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";

const postSchema = z.object({
  date: z.string(),
  amount: z.number().optional(),       // account-currency amount; computed by server when entered* is provided
  accountId: z.number().int().positive({ message: "Please pick an account" }),
  // Reject 0 (the UI's "no selection" sentinel) up front — letting it through
  // to the INSERT raises a Postgres FK violation 23503 which surfaces as a
  // confusing 500. Real category ids are positive serial values.
  categoryId: z.number().int().positive({ message: "Please pick a category" }),
  currency: z.string().optional(),     // account currency; defaults to the account's currency
  // Phase 2 of the currency rework — the user-typed values. When provided,
  // the server triangulates to the account's currency and locks the rate.
  // When omitted, falls back to (amount, currency) being the entered side too.
  enteredAmount: z.number().optional(),
  enteredCurrency: z.string().optional(),
  payee: z.string().optional(),
  quantity: z.number().optional(),
  portfolioHolding: z.string().optional(),
  portfolioHoldingId: z.number().int().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  isBusiness: z.number().optional(),
  splitPerson: z.string().optional(),
  splitRatio: z.number().optional(),
}).refine(
  (data) => data.amount != null || data.enteredAmount != null,
  { message: "Either amount or enteredAmount is required" }
);

const putSchema = z.object({
  id: z.number(),
  date: z.string().optional(),
  amount: z.number().optional(),
  accountId: z.number().int().positive({ message: "Please pick an account" }).optional(),
  categoryId: z.number().int().positive({ message: "Please pick a category" }).optional(),
  currency: z.string().optional(),
  enteredAmount: z.number().optional(),
  enteredCurrency: z.string().optional(),
  payee: z.string().optional(),
  quantity: z.number().optional(),
  portfolioHolding: z.string().optional(),
  portfolioHoldingId: z.number().int().nullable().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  isBusiness: z.number().optional(),
  splitPerson: z.string().optional(),
  splitRatio: z.number().optional(),
});

export async function GET(request: NextRequest) {
  // GET must stay accessible even when the session has no cached DEK
  // (e.g. first request after a server restart). `decryptTxRows` passes
  // rows through unchanged when dek is null — encrypted rows surface as
  // `v1:...` ciphertext, which is ugly but recoverable (re-login
  // repopulates the DEK cache), whereas 423-ing the whole transactions
  // page blocks the user entirely.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const search = params.get("search") ?? undefined;
  // `portfolioHolding` (name) is resolved server-side to a holding id and
  // applied as a SQL `WHERE portfolio_holding_id = ?` filter. Phase 5
  // (2026-04-29) eliminated the in-memory ciphertext scan — the FK is the
  // source of truth and the legacy text column is NULL on every row.
  const portfolioHoldingNameParam = params.get("portfolioHolding") ?? undefined;
  const portfolioHoldingIdParam = params.get("portfolioHoldingId");
  let portfolioHoldingId = portfolioHoldingIdParam
    ? parseInt(portfolioHoldingIdParam)
    : undefined;
  // Resolve name → id via the user's name_lookup HMAC. Returns empty when
  // no holding matches that name (deleted, never existed) — short-circuits
  // before the SQL roundtrip.
  if (
    portfolioHoldingNameParam &&
    (portfolioHoldingId == null || !Number.isFinite(portfolioHoldingId)) &&
    dek
  ) {
    const lookup = nameLookup(dek, portfolioHoldingNameParam);
    const matched = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(and(
        eq(schema.portfolioHoldings.userId, userId),
        eq(schema.portfolioHoldings.nameLookup, lookup),
      ))
      .limit(1);
    if (matched[0]) {
      portfolioHoldingId = matched[0].id;
    } else {
      return NextResponse.json([]);
    }
  }
  // Tag is an in-memory exact-match filter on the comma-split list. The
  // column is ciphertext-at-rest so SQL LIKE won't work, and substring
  // match on decrypted text would false-match (e.g. `source:X` in one tag
  // shouldn't match `source:XY` in another). Split then exact-compare each.
  const tag = params.get("tag") ?? undefined;

  // Issue #59 — parse the new sort + per-column filter query params. SQL-
  // pushdown filters (date / numeric / multi-id / enum) are wired into
  // `getTransactions`. Substring filters on encrypted columns stay
  // post-decryption (handled below alongside the legacy `search`).
  const sortColumnIdRaw = params.get("sort") ?? undefined;
  const sortDirRaw = params.get("sortDir") ?? undefined;
  const sortColumnId = sortColumnIdRaw && isSortableColumnId(sortColumnIdRaw)
    ? sortColumnIdRaw
    : undefined;
  const sortDirection: "asc" | "desc" | undefined =
    sortDirRaw === "asc" || sortDirRaw === "desc" ? sortDirRaw : undefined;

  const parseNum = (key: string): number | undefined => {
    const v = params.get(key);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const parseIdList = (key: string): number[] | undefined => {
    const v = params.get(key);
    if (!v) return undefined;
    const ids = v.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
    return ids.length > 0 ? ids : undefined;
  };
  const parseSourcesList = (): TransactionSource[] | undefined => {
    const v = params.get("sources");
    if (!v) return undefined;
    const out = v.split(",").map((s) => s.trim()).filter(isTransactionSource);
    return out.length > 0 ? out : undefined;
  };

  // Encrypted-column substring filters — payee / note / accountName /
  // categoryName / portfolioHolding etc. Trigger the post-decrypt widening
  // since SQL LIKE on ciphertext returns garbage.
  const filterPayee = params.get("filter_payee") ?? undefined;
  const filterNote = params.get("filter_note") ?? undefined;
  const filterAccountName = params.get("filter_accountName") ?? undefined;
  const filterAccountAlias = params.get("filter_accountAlias") ?? undefined;
  const filterPortfolio = params.get("filter_portfolio") ?? undefined;
  const filterPortfolioTicker = params.get("filter_portfolioTicker") ?? undefined;
  const filterTags = params.get("filter_tags") ?? undefined;
  const hasEncryptedSubstringFilter = !!(
    filterPayee || filterNote || filterAccountName || filterAccountAlias ||
    filterPortfolio || filterPortfolioTicker || filterTags
  );

  // FK filter is SQL-side, so it's NOT a postDecryptFilter — paginate normally.
  const postDecryptFilter = search || tag || hasEncryptedSubstringFilter;
  const filters: TxSortFilter = {
    startDate: params.get("startDate") ?? undefined,
    endDate: params.get("endDate") ?? undefined,
    createdAtFrom: params.get("createdAtFrom") ?? undefined,
    createdAtTo: params.get("createdAtTo") ?? undefined,
    updatedAtFrom: params.get("updatedAtFrom") ?? undefined,
    updatedAtTo: params.get("updatedAtTo") ?? undefined,
    accountId: params.get("accountId") ? parseInt(params.get("accountId")!) : undefined,
    categoryId: params.get("categoryId") ? parseInt(params.get("categoryId")!) : undefined,
    portfolioHoldingId: Number.isFinite(portfolioHoldingId) ? portfolioHoldingId : undefined,
    accountIds: parseIdList("accountIds"),
    categoryIds: parseIdList("categoryIds"),
    amountMin: parseNum("amountMin"),
    amountMax: parseNum("amountMax"),
    amountEq: parseNum("amountEq"),
    quantityMin: parseNum("quantityMin"),
    quantityMax: parseNum("quantityMax"),
    quantityEq: parseNum("quantityEq"),
    sources: parseSourcesList(),
    sortColumnId,
    sortDirection,
    // Search is applied after decryption, so don't push it into the SQL filter.
    // Pull a wider page when any post-decrypt filter is set so the in-memory
    // pass doesn't paginate an empty window. The client still honors the
    // original limit.
    limit: postDecryptFilter ? 1000 : (params.get("limit") ? parseInt(params.get("limit")!) : 100),
    offset: postDecryptFilter ? 0 : (params.get("offset") ? parseInt(params.get("offset")!) : 0),
  };

  const rawRows = await getTransactions(userId, filters);
  let decrypted = decryptTxRows(dek, rawRows as Array<Parameters<typeof decryptTxRows>[1][number]>);

  // Resolve every Stream-D-encrypted display name and strip the *_ct
  // companion fields before serializing. Falls back to plaintext (legacy
  // rows + DEK-mismatch users) via decryptName's ladder. Without the
  // category + account decrypts, the /transactions page and the Reports
  // tabs render empty cells for every Phase-3-NULL'd user.
  decrypted = decrypted.map((r) => {
    const row = r as typeof r & {
      accountName?: string | null;
      accountNameCt?: string | null;
      accountAlias?: string | null;
      accountAliasCt?: string | null;
      categoryName?: string | null;
      categoryNameCt?: string | null;
      portfolioHoldingName?: string | null;
      portfolioHoldingNameCt?: string | null;
      portfolioHoldingSymbol?: string | null;
      portfolioHoldingSymbolCt?: string | null;
      portfolioHolding?: string | null;
    };
    row.accountName = decryptName(row.accountNameCt, dek, row.accountName);
    row.accountAlias = decryptName(row.accountAliasCt, dek, row.accountAlias);
    row.categoryName = decryptName(row.categoryNameCt, dek, row.categoryName);
    let resolvedHolding: string | null = row.portfolioHoldingName ?? null;
    if (!resolvedHolding && row.portfolioHoldingNameCt && dek) {
      try {
        resolvedHolding = decryptField(dek, row.portfolioHoldingNameCt);
      } catch {
        resolvedHolding = null;
      }
    }
    row.portfolioHolding = resolvedHolding;
    row.portfolioHoldingSymbol = decryptName(
      row.portfolioHoldingSymbolCt,
      dek,
      row.portfolioHoldingSymbol,
    );
    delete row.accountNameCt;
    delete row.accountAliasCt;
    delete row.categoryNameCt;
    delete row.portfolioHoldingName;
    delete row.portfolioHoldingNameCt;
    delete row.portfolioHoldingSymbolCt;
    return row;
  });

  if (search) {
    decrypted = filterDecryptedBySearch(decrypted, search);
  }

  if (tag) {
    decrypted = decrypted.filter((r) => {
      if (!r.tags) return false;
      return r.tags.split(",").map((t) => t.trim()).includes(tag);
    });
  }

  // Issue #59 — per-column substring filters on encrypted fields.
  // Case-insensitive substring match against the post-decrypt value.
  // Each filter narrows independently (AND across columns).
  const matchSubstring = (value: string | null | undefined, needle: string) => {
    if (!value) return false;
    return value.toLowerCase().includes(needle.toLowerCase());
  };
  if (filterPayee) {
    decrypted = decrypted.filter((r) => matchSubstring(r.payee, filterPayee));
  }
  if (filterNote) {
    decrypted = decrypted.filter((r) => matchSubstring(r.note, filterNote));
  }
  if (filterAccountName) {
    decrypted = decrypted.filter((r) =>
      matchSubstring((r as { accountName?: string | null }).accountName, filterAccountName),
    );
  }
  if (filterAccountAlias) {
    decrypted = decrypted.filter((r) =>
      matchSubstring((r as { accountAlias?: string | null }).accountAlias, filterAccountAlias),
    );
  }
  if (filterPortfolio) {
    decrypted = decrypted.filter((r) =>
      matchSubstring((r as { portfolioHolding?: string | null }).portfolioHolding, filterPortfolio),
    );
  }
  if (filterPortfolioTicker) {
    decrypted = decrypted.filter((r) =>
      matchSubstring((r as { portfolioHoldingSymbol?: string | null }).portfolioHoldingSymbol, filterPortfolioTicker),
    );
  }
  if (filterTags) {
    decrypted = decrypted.filter((r) => matchSubstring(r.tags, filterTags));
  }

  // Re-apply client-requested pagination after in-memory filters so the
  // chip-filtered view doesn't spill into an empty page.
  let total: number;
  if (postDecryptFilter) {
    total = decrypted.length;
    const clientLimit = params.get("limit") ? parseInt(params.get("limit")!) : 100;
    const clientOffset = params.get("offset") ? parseInt(params.get("offset")!) : 0;
    decrypted = decrypted.slice(clientOffset, clientOffset + clientLimit);
  } else {
    total = await getTransactionCount(userId, filters);
  }

  return NextResponse.json({ data: decrypted, total });
}

/**
 * Resolve the entered/account-currency trilogy on a write payload.
 *
 * Branches:
 *  - enteredAmount + enteredCurrency provided → triangulate to account's
 *    currency, lock the rate. Refuses to write on source='fallback' so we
 *    don't silently store rate=1 for unsupported currencies.
 *  - enteredAmount alone (no enteredCurrency) → assume entered currency
 *    matches the account currency.
 *  - amount + currency provided (legacy callers) → mirror them as the
 *    entered side too with rate=1.
 *  - Neither → caller bug; rejected by Zod refine().
 */
async function resolveTxAmounts(
  data: {
    accountId?: number;
    currency?: string;
    amount?: number;
    enteredAmount?: number;
    enteredCurrency?: string;
    date?: string;
  },
  userId: string,
  isUpdate: boolean
): Promise<{
  ok: true;
  fields: {
    amount?: number;
    currency?: string;
    enteredAmount?: number;
    enteredCurrency?: string;
    enteredFxRate?: number;
  };
} | { ok: false; response: NextResponse }> {
  // For UPDATEs: only resolve if the user touched amount/entered fields.
  // Allow updates to date/payee/note/etc. without re-running FX.
  const touchedAmounts =
    data.amount !== undefined ||
    data.enteredAmount !== undefined ||
    data.enteredCurrency !== undefined ||
    data.currency !== undefined;
  if (isUpdate && !touchedAmounts) {
    return { ok: true, fields: {} };
  }

  // Need an account to know the settlement currency. For updates without
  // accountId in the payload, look up the existing tx's account.
  const accountId = data.accountId;
  if (accountId == null) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "accountId is required when amount or currency is being changed" },
        { status: 400 }
      ),
    };
  }
  const account = await getAccountById(accountId, userId);
  if (!account) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Account ${accountId} not found` },
        { status: 404 }
      ),
    };
  }
  const accountCurrency = account.currency.toUpperCase();
  const date = data.date ?? new Date().toISOString().split("T")[0];

  // Path 1: caller gave us entered fields — triangulate.
  if (data.enteredAmount != null) {
    const enteredCurrency = (data.enteredCurrency ?? accountCurrency).toUpperCase();
    const conversion = await convertToAccountCurrency({
      enteredAmount: data.enteredAmount,
      enteredCurrency,
      accountCurrency,
      date,
      userId,
    });
    if (conversion.source === "fallback") {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `No FX rate available for ${enteredCurrency}. Add a custom rate via Settings → Custom exchange rates first.`,
            code: "fx-currency-needs-override",
            currency: enteredCurrency,
          },
          { status: 409 }
        ),
      };
    }
    return {
      ok: true,
      fields: {
        amount: conversion.amount,
        currency: accountCurrency,
        enteredAmount: data.enteredAmount,
        enteredCurrency,
        enteredFxRate: conversion.enteredFxRate,
      },
    };
  }

  // Path 2: legacy caller — only `amount` (+ maybe `currency`). Treat the
  // recorded amount as both entered and account, with rate=1. If the caller
  // passed a currency that doesn't match the account, that's a cross-
  // currency entry without conversion (same as today's broken behavior); we
  // preserve it for back-compat but it will get flagged by tx_currency_audit.
  if (data.amount != null) {
    const currency = (data.currency ?? accountCurrency).toUpperCase();
    return {
      ok: true,
      fields: {
        amount: data.amount,
        currency,
        enteredAmount: data.amount,
        enteredCurrency: currency,
        enteredFxRate: 1,
      },
    };
  }

  return { ok: true, fields: {} };
}

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const data = { ...parsed.data };

    const resolved = await resolveTxAmounts(data, auth.userId, false);
    if (!resolved.ok) return resolved.response;
    Object.assign(data, resolved.fields);

    // Cross-tenant FK guard (H-1) — verify the caller owns every FK id
    // supplied in the body BEFORE the resolver auto-creates anything or the
    // INSERT fires. `portfolioHoldingId` is checked when present; the name
    // resolver below scopes by `auth.userId` so the resolved-from-name path
    // can't cross tenants.
    await verifyOwnership(auth.userId, {
      accountIds: [data.accountId],
      categoryIds: [data.categoryId],
      holdingIds: data.portfolioHoldingId != null ? [data.portfolioHoldingId] : undefined,
    });

    // Resolve portfolioHolding name → portfolio_holdings.id when the caller
    // didn't supply the FK directly. Auto-creates a holding scoped to the
    // tx's account when missing — matches the import-pipeline behavior so
    // ad-hoc tx creation and bulk imports converge on the same FK.
    if (
      data.portfolioHoldingId == null &&
      data.portfolioHolding &&
      data.accountId != null
    ) {
      const resolver = await buildHoldingResolver(auth.userId, auth.dek);
      data.portfolioHoldingId =
        (await resolver.resolve(data.accountId, data.portfolioHolding)) ?? undefined;
    }
    // Phase 5: never persist the legacy text column. The FK is the source
    // of truth and the column is being dropped in a follow-up release.
    delete data.portfolioHolding;
    const encrypted = encryptTxWrite(auth.dek, data);
    // Issue #28: hard-code the writer surface at the route boundary rather
    // than relying on the schema default. Defensive against a future writer
    // path that forgets to set it — every entry point is grep-discoverable.
    const tx = await createTransaction(auth.userId, { ...encrypted, source: "manual" }, auth.dek);
    invalidateUserTxCache(auth.userId);
    return NextResponse.json(tx, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof InvestmentHoldingRequiredError) {
      return NextResponse.json(
        { error: error.message, code: error.code, accountId: error.accountId },
        { status: 400 },
      );
    }
    if (error instanceof SignCategoryMismatchError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          amount: error.amount,
          categoryName: error.categoryName,
          categoryType: error.categoryType,
        },
        { status: 400 },
      );
    }
    if (error instanceof OwnershipError) {
      // 404 (not 403) — same shape as "not found" so the caller can't
      // distinguish "another user's id" from "non-existent id". H-1.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Postgres FK violation — typically a stale categoryId / accountId /
    // portfolioHoldingId from a stale UI form. Map to 400 with a friendly
    // pointer instead of leaking the SQL error as a 500.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23503") {
      return NextResponse.json(
        { error: "Pick a valid account, category, and portfolio holding — one of them no longer exists.", code: "fk_violation" },
        { status: 400 },
      );
    }
    await logApiError("POST", "/api/transactions", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create transaction") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;

    const resolved = await resolveTxAmounts(data, auth.userId, true);
    if (!resolved.ok) return resolved.response;
    Object.assign(data, resolved.fields);

    // Cross-tenant FK guard (H-1). The transaction id itself is checked by
    // the SQL `eq(transactions.userId, ...)` in `updateTransaction`, but the
    // FK ids in the update body would otherwise re-attribute the row to
    // another user's account/category/holding.
    await verifyOwnership(auth.userId, {
      accountIds: data.accountId != null ? [data.accountId] : undefined,
      categoryIds: data.categoryId != null ? [data.categoryId] : undefined,
      // `null` is an explicit clear-the-FK; only verify positive ids.
      holdingIds:
        data.portfolioHoldingId != null && data.portfolioHoldingId > 0
          ? [data.portfolioHoldingId]
          : undefined,
    });

    // Same name→id resolution as POST. Only runs when caller passed a name
    // without explicitly supplying (or nulling) the FK.
    if (
      data.portfolioHoldingId === undefined &&
      data.portfolioHolding &&
      data.accountId != null
    ) {
      const resolver = await buildHoldingResolver(auth.userId, auth.dek);
      data.portfolioHoldingId =
        (await resolver.resolve(data.accountId, data.portfolioHolding)) ?? undefined;
    }
    // Phase 5: never persist the legacy text column.
    delete data.portfolioHolding;
    const encrypted = encryptTxWrite(auth.dek, data);
    const tx = await updateTransaction(id, auth.userId, encrypted, auth.dek);
    invalidateUserTxCache(auth.userId);
    return NextResponse.json(tx);
  } catch (error: unknown) {
    if (error instanceof InvestmentHoldingRequiredError) {
      return NextResponse.json(
        { error: error.message, code: error.code, accountId: error.accountId },
        { status: 400 },
      );
    }
    if (error instanceof SignCategoryMismatchError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          amount: error.amount,
          categoryName: error.categoryName,
          categoryType: error.categoryType,
        },
        { status: 400 },
      );
    }
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23503") {
      return NextResponse.json(
        { error: "Pick a valid account, category, and portfolio holding — one of them no longer exists.", code: "fk_violation" },
        { status: 400 },
      );
    }
    await logApiError("PUT", "/api/transactions", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update transaction") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // DELETE doesn't need the DEK — IDs and user-scope only.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await deleteTransaction(id, auth.context.userId);
  invalidateUserTxCache(auth.context.userId);
  return NextResponse.json({ success: true });
}
