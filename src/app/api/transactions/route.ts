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
import { todayISO } from "@/lib/utils/date";
import { InvestmentHoldingRequiredError } from "@/lib/investment-account";
import { validateSignVsCategoryById } from "@/lib/transactions/sign-category-invariant";
import {
  applyLotEffectsForTx,
  buildLotContext,
  reverseLotsForDeleteHook,
  replanLotsAfterMutation,
} from "@/lib/portfolio/lots/write-hooks";
import { canEditPortfolioRow } from "@/lib/portfolio/operations";
import type { TxRowForLots } from "@/lib/portfolio/lots/types";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { isSortableColumnId } from "@/lib/transactions/columns";
import { expandLinkSiblings } from "@/lib/transactions/link-siblings";
import { isTransactionSource, type TransactionSource } from "@/lib/tx-source";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";
import { securitiesReadEnabledForUser } from "@/lib/securities/flag";

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
  // FINLYNQ-176 — when true, a lot-locked edit (canEditPortfolioRow → not
  // allowed) reallocates the dependent closures instead of returning 409.
  // Stripped from `data` before the row is updated.
  confirmReallocation: z.boolean().optional(),
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

  // FINLYNQ-177 — single-transaction id deep link. Owner-scoped SQL pushdown
  // (combined with the user_id predicate in buildTxFilterConditions). A present
  // but non-positive / non-numeric `id` param can never match a real serial id,
  // so short-circuit to the empty state rather than silently dropping the
  // filter and rendering the full list.
  const idParamRaw = params.get("id");
  let idFilter: number | undefined;
  if (idParamRaw != null && idParamRaw !== "") {
    const parsed = parseInt(idParamRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      idFilter = parsed;
    } else {
      return NextResponse.json({ data: [], total: 0 });
    }
  }

  // FK filter is SQL-side, so it's NOT a postDecryptFilter — paginate normally.
  const postDecryptFilter = search || tag || hasEncryptedSubstringFilter;
  const filters: TxSortFilter = {
    id: idFilter,
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
  // Securities master read-flip — when on, the displayed holding identity comes
  // from the centralized `securities` row (single source of truth), so a renamed
  // security (e.g. a cash sleeve "Cash USD") shows here, not the stale position
  // name. Off / unlinked → the holding's own name (legacy behavior).
  const securitiesRead = await securitiesReadEnabledForUser(userId);
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
      securityNameCt?: string | null;
      securitySymbolCt?: string | null;
      portfolioHolding?: string | null;
    };
    row.accountName = decryptName(row.accountNameCt, dek, row.accountName);
    row.accountAlias = decryptName(row.accountAliasCt, dek, row.accountAlias);
    row.categoryName = decryptName(row.categoryNameCt, dek, row.categoryName);
    // Holding name — prefer the security's name when the read-flip is on.
    let resolvedHolding: string | null = null;
    if (securitiesRead && row.securityNameCt && dek) {
      try {
        resolvedHolding = decryptField(dek, row.securityNameCt);
      } catch {
        resolvedHolding = null;
      }
    }
    if (!resolvedHolding) {
      resolvedHolding = row.portfolioHoldingName ?? null;
      if (!resolvedHolding && row.portfolioHoldingNameCt && dek) {
        try {
          resolvedHolding = decryptField(dek, row.portfolioHoldingNameCt);
        } catch {
          resolvedHolding = null;
        }
      }
    }
    row.portfolioHolding = resolvedHolding;
    // Symbol — same preference. The security's symbol equals the holding's for
    // tickered rows; null for cash → falls back to the holding's.
    let resolvedSymbol: string | null = null;
    if (securitiesRead && row.securitySymbolCt) {
      resolvedSymbol = decryptName(row.securitySymbolCt, dek, null);
    }
    if (resolvedSymbol == null) {
      resolvedSymbol = decryptName(row.portfolioHoldingSymbolCt, dek, row.portfolioHoldingSymbol);
    }
    row.portfolioHoldingSymbol = resolvedSymbol;
    delete row.accountNameCt;
    delete row.accountAliasCt;
    delete row.categoryNameCt;
    delete row.portfolioHoldingName;
    delete row.portfolioHoldingNameCt;
    delete row.portfolioHoldingSymbolCt;
    delete row.securityNameCt;
    delete row.securitySymbolCt;
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
  const date = data.date ?? todayISO();

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
    // FINLYNQ-97 — sign-vs-category check is advisory. Compute the message
    // BEFORE encryption / INSERT so it sees the post-resolve amount; row
    // lands regardless. A returned non-null error surfaces as `warning`
    // on the 201 body.
    const signWarn =
      data.amount != null
        ? await validateSignVsCategoryById(
            auth.userId,
            auth.dek,
            data.categoryId,
            Number(data.amount),
          )
        : null;
    const encrypted = encryptTxWrite(auth.dek, data);
    // Issue #28: hard-code the writer surface at the route boundary rather
    // than relying on the schema default. Defensive against a future writer
    // path that forgets to set it — every entry point is grep-discoverable.
    const tx = await createTransaction(auth.userId, { ...encrypted, source: "manual" }, auth.dek);
    invalidateUserTxCache(auth.userId);
    // Portfolio lot tracking — open/close a lot when the row touches a
    // portfolio holding. Soft-fails internally; never blocks the REST
    // response on lot-side errors.
    if (tx && tx.portfolioHoldingId != null && tx.quantity != null && tx.quantity !== 0) {
      const ctx = await buildLotContext(auth.userId, auth.dek);
      await applyLotEffectsForTx(tx as TxRowForLots, ctx);
    }
    // Snapshot history is stale from this date forward for investment rows.
    if (tx && tx.portfolioHoldingId != null) {
      await markSnapshotsDirty(auth.userId, tx.date);
    }
    return NextResponse.json(
      signWarn ? { ...tx, warning: signWarn.message } : tx,
      { status: 201 },
    );
  } catch (error: unknown) {
    if (error instanceof InvestmentHoldingRequiredError) {
      return NextResponse.json(
        { error: error.message, code: error.code, accountId: error.accountId },
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
    const { id, confirmReallocation, ...data } = parsed.data;

    // Portfolio edit-guard (Phase 2 of the operations refactor). When a
    // buy/transfer-in tx's opened lot has been sold or transferred out, the
    // guard reports the dependent closures.
    //   - Without confirmReallocation → keep the existing 409 affordance so
    //     the client can fetch the reallocation preview (FINLYNQ-176).
    //   - With confirmReallocation → re-plan the dependent closures against
    //     the post-edit inventory instead of refusing.
    const guard = await canEditPortfolioRow(auth.userId, id);
    const reallocate = !guard.allowed && confirmReallocation === true;
    const dependentCloseTxIds = guard.blockingClosureTxIds ?? [];
    if (!guard.allowed && !reallocate) {
      return NextResponse.json(
        {
          error: guard.reason,
          code: "portfolio_edit_blocked",
          blockingClosureTxIds: dependentCloseTxIds,
        },
        { status: 409 },
      );
    }

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
    // FINLYNQ-97 — sign-vs-category check is advisory on PUT too. Compute
    // the post-merge amount + category by falling back to the existing
    // row's values when the patch doesn't touch them, then validate.
    // The row is updated either way; a non-null result is attached as
    // `warning` on the 200 body.
    let signWarn: { message: string } | null = null;
    if (data.amount !== undefined || data.categoryId !== undefined) {
      const current = await db
        .select({
          amount: schema.transactions.amount,
          categoryId: schema.transactions.categoryId,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.id, id),
            eq(schema.transactions.userId, auth.userId),
          ),
        )
        .get();
      if (current) {
        const postAmount =
          data.amount !== undefined ? data.amount : current.amount;
        const postCategoryId =
          data.categoryId !== undefined ? data.categoryId : current.categoryId;
        if (postAmount != null) {
          signWarn = await validateSignVsCategoryById(
            auth.userId,
            auth.dek,
            postCategoryId,
            Number(postAmount),
          );
        }
      }
    }
    const encrypted = encryptTxWrite(auth.dek, data);
    const tx = await updateTransaction(id, auth.userId, encrypted, auth.dek);
    invalidateUserTxCache(auth.userId);
    if (reallocate) {
      // FINLYNQ-176 — the edited buy/transfer-in had dependent closures.
      // Re-plan them against the post-edit inventory (strict, all-or-nothing):
      // reverse dependents + target, redo the edited target, re-close each
      // dependent (FIFO + auto-short). Throws on any error → 500 rollback.
      await replanLotsAfterMutation(
        auth.userId,
        { op: "edit", targetTxId: id, dependentCloseTxIds },
        { dryRun: false, dek: auth.dek },
      );
    } else {
      // Portfolio lot tracking — UPDATE may have changed quantity / amount /
      // category / holding, so the conservative move is reverse + redo.
      // Pure-metadata edits (note / payee / tags / date) still spend the
      // reverse cycle, but reverseLotsForDeleteHook is a no-op when there
      // are no lots tied to this tx.
      await reverseLotsForDeleteHook(auth.userId, id);
      if (tx && tx.portfolioHoldingId != null && tx.quantity != null && tx.quantity !== 0) {
        const ctx = await buildLotContext(auth.userId, auth.dek);
        await applyLotEffectsForTx(tx as TxRowForLots, ctx);
      }
    }
    // Snapshot history is stale from this date forward for investment rows
    // (a back-dated edit can move the affected date earlier than today).
    if (tx && tx.portfolioHoldingId != null) {
      await markSnapshotsDirty(auth.userId, tx.date);
    }
    return NextResponse.json(
      signWarn ? { ...tx, warning: signWarn.message } : tx,
    );
  } catch (error: unknown) {
    if (error instanceof InvestmentHoldingRequiredError) {
      return NextResponse.json(
        { error: error.message, code: error.code, accountId: error.accountId },
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
  const { userId } = auth.context;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // FINLYNQ-176 — `?confirmReallocation=1` opts into warn-and-reallocate
  // instead of the hard `portfolio_edit_blocked` 409.
  const confirmReallocation = params.get("confirmReallocation") === "1";

  // Phase 2 portfolio-ops refactor (2026-05-25): paired rows from
  // operations.ts share a `trade_link_id` (buy/sell cash leg pairs) or
  // `link_id` (in-kind transfers, FX conversions). Deleting one leg without
  // the sibling leaves an orphan that breaks account-level invariants
  // (cash sleeve sum drifts, lot bookkeeping desyncs). Compute the full
  // "delete set" up front — the target + every sibling sharing either
  // link — then run the edit-guard + delete loop over the entire set.
  // Sibling expansion is single-sourced in `expandLinkSiblings`
  // (FINLYNQ-222) and shared with the bank-side delete cascade.
  const target = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.id, id),
        eq(schema.transactions.userId, userId),
      ),
    )
    .get();
  if (!target) {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }
  const allIds = await expandLinkSiblings(userId, [id]);

  // Snapshot freshness — if any row in the delete set touches an investment
  // holding, capture the earliest affected date BEFORE the rows are gone so we
  // can mark snapshots dirty after the commit. Best-effort.
  let snapshotDirtyFrom: string | null = null;
  try {
    const delRows = await db
      .select({
        date: schema.transactions.date,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
      })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.userId, userId), inArray(schema.transactions.id, allIds)));
    for (const r of delRows) {
      if (r.portfolioHoldingId != null) {
        if (snapshotDirtyFrom == null || r.date < snapshotDirtyFrom) snapshotDirtyFrom = r.date;
      }
    }
  } catch {
    /* best-effort — never block the delete */
  }

  // Portfolio edit-guard — applies to EVERY id in the delete set. The user
  // can't delete a buy that has been sold (the sell's closures lock the buy
  // in place); they have to delete the sell first. We check each row in the
  // set and aggregate any blocking ids so the UI can surface a single
  // actionable list.
  const deleteIdSet = new Set<number>(allIds);
  const blockingSet = new Set<number>();
  for (const txId of allIds) {
    const guard = await canEditPortfolioRow(userId, txId);
    if (!guard.allowed && guard.blockingClosureTxIds) {
      for (const b of guard.blockingClosureTxIds) {
        // Exclude ids already in the delete set — the user is deleting
        // them, so they're not "blocking" the operation.
        if (!deleteIdSet.has(b)) blockingSet.add(b);
      }
    }
  }
  const blockingClosureTxIds = Array.from(blockingSet);
  if (blockingClosureTxIds.length > 0 && !confirmReallocation) {
    // FINLYNQ-176 — without the confirm flag, keep the 409 affordance so the
    // client can fetch the reallocation preview before proceeding.
    return NextResponse.json(
      {
        error:
          `This transaction opens one or more lots that have been sold or transferred out. ` +
          `Delete the ${blockingClosureTxIds.length} dependent transaction(s) first, then retry.`,
        code: "portfolio_edit_blocked",
        blockingClosureTxIds,
      },
      { status: 409 },
    );
  }

  if (blockingClosureTxIds.length > 0) {
    // FINLYNQ-176 reallocation path. Reverse the dependent closures' lot
    // effects FIRST so they release the lots the deleted rows opened, then
    // delete the tx rows, then re-close the dependents (FIFO + auto-short)
    // against the remaining inventory. STRICT — any error throws → 500.
    const { __setLotWriteHookStrictMode } = await import(
      "@/lib/portfolio/lots/write-hooks"
    );
    __setLotWriteHookStrictMode(true);
    try {
      for (const depId of blockingClosureTxIds) {
        await reverseLotsForDeleteHook(userId, depId);
      }
      for (const txId of allIds) {
        await reverseLotsForDeleteHook(userId, txId);
      }
      for (const txId of allIds) {
        await deleteTransaction(txId, userId);
      }
      // Re-close the (still-existing) dependent transactions against the
      // post-delete inventory.
      const ctx = await buildLotContext(userId, null);
      const depRows = await db
        .select({
          id: schema.transactions.id,
          userId: schema.transactions.userId,
          date: schema.transactions.date,
          amount: schema.transactions.amount,
          currency: schema.transactions.currency,
          enteredAmount: schema.transactions.enteredAmount,
          enteredCurrency: schema.transactions.enteredCurrency,
          quantity: schema.transactions.quantity,
          accountId: schema.transactions.accountId,
          categoryId: schema.transactions.categoryId,
          portfolioHoldingId: schema.transactions.portfolioHoldingId,
          tradeLinkId: schema.transactions.tradeLinkId,
          source: schema.transactions.source,
          kind: schema.transactions.kind,
        })
        .from(schema.transactions)
        .where(and(eq(schema.transactions.userId, userId), inArray(schema.transactions.id, blockingClosureTxIds)));
      depRows.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      for (const r of depRows) {
        if (r.portfolioHoldingId == null || r.quantity == null) continue;
        await applyLotEffectsForTx(
          {
            id: r.id,
            userId: r.userId,
            date: r.date,
            amount: Number(r.amount ?? 0),
            currency: r.currency ?? "USD",
            enteredAmount: r.enteredAmount == null ? null : Number(r.enteredAmount),
            enteredCurrency: r.enteredCurrency,
            quantity: Number(r.quantity),
            accountId: r.accountId,
            categoryId: r.categoryId,
            portfolioHoldingId: r.portfolioHoldingId,
            tradeLinkId: r.tradeLinkId,
            source: (r.source ?? "manual") as TransactionSource,
            kind: r.kind,
          },
          ctx,
        );
      }
    } finally {
      __setLotWriteHookStrictMode(false);
    }
    invalidateUserTxCache(userId);
    if (snapshotDirtyFrom) await markSnapshotsDirty(userId, snapshotDirtyFrom);
    return NextResponse.json({
      success: true,
      deletedIds: allIds,
      cascaded: allIds.length > 1,
      reallocated: blockingClosureTxIds,
    });
  }

  // No dependent closures — the standard delete path.
  // Reverse lots BEFORE deleting tx rows so reverseLotsForDeleteHook can
  // see them. ON DELETE CASCADE on holding_lots.open_tx_id catches any
  // strays as defense-in-depth.
  for (const txId of allIds) {
    await reverseLotsForDeleteHook(userId, txId);
  }
  for (const txId of allIds) {
    await deleteTransaction(txId, userId);
  }
  invalidateUserTxCache(userId);
  if (snapshotDirtyFrom) await markSnapshotsDirty(userId, snapshotDirtyFrom);
  return NextResponse.json({
    success: true,
    deletedIds: allIds,
    cascaded: allIds.length > 1,
  });
}
