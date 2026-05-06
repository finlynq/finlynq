/**
 * GET    /api/import/staged/[id]  — detail + preview rows for approval
 * DELETE /api/import/staged/[id]  — reject (deletes staged rows via cascade)
 *
 * Approve lives at /api/import/staged/[id]/approve (separate file — it needs
 * DEK auth whereas detail + reject only need session auth).
 *
 * All routes are user-scoped via userId filter. 404 if the staged_import
 * doesn't belong to the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, asc, sql } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { getRate } from "@/lib/fx-service";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Switched from requireAuth to requireEncryption (2026-05-06): rows can now
  // be at either 'service' or 'user' encryption tier; user-tier rows need the
  // DEK to decrypt. Forcing DEK presence for service-tier rows too keeps the
  // route a single shape and matches CLAUDE.md "reads use requireAuth() OR
  // requireEncryption() depending on whether they touch encrypted columns".
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  const staged = await db
    .select()
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();

  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: schema.stagedTransactions.id,
      date: schema.stagedTransactions.date,
      amount: schema.stagedTransactions.amount,
      currency: schema.stagedTransactions.currency,
      payee: schema.stagedTransactions.payee,
      category: schema.stagedTransactions.category,
      accountName: schema.stagedTransactions.accountName,
      note: schema.stagedTransactions.note,
      rowIndex: schema.stagedTransactions.rowIndex,
      isDuplicate: schema.stagedTransactions.isDuplicate,
      encryptionTier: schema.stagedTransactions.encryptionTier,
      // Issue #154 — surface dedup_status + row_status so the client-side
      // reconciliation callout can recompute "After approval" live as the
      // user toggles row checkboxes (selection != row_status, but the
      // initial projection uses dedup_status to exclude EXISTING rows).
      dedupStatus: schema.stagedTransactions.dedupStatus,
      rowStatus: schema.stagedTransactions.rowStatus,
      // Issue #155 — full-transaction parity columns the row editor reads
      // and writes. Numeric / structural / FK — not encrypted, no per-tier
      // branch needed. tags is a free-text comma-separated value (same
      // shape as live transactions.tags) — also unencrypted at staging.
      txType: schema.stagedTransactions.txType,
      quantity: schema.stagedTransactions.quantity,
      portfolioHoldingId: schema.stagedTransactions.portfolioHoldingId,
      enteredAmount: schema.stagedTransactions.enteredAmount,
      enteredCurrency: schema.stagedTransactions.enteredCurrency,
      tags: schema.stagedTransactions.tags,
      fitId: schema.stagedTransactions.fitId,
      peerStagedId: schema.stagedTransactions.peerStagedId,
      targetAccountId: schema.stagedTransactions.targetAccountId,
    })
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .orderBy(asc(schema.stagedTransactions.rowIndex))
    .all();

  // Branch on encryption_tier per row (2026-05-06): mixed tiers are expected
  // mid-upgrade (the login-time job is async). 'user' rows are v1: ciphertext
  // under the session DEK; 'service' rows are sv1: under PF_STAGING_KEY.
  const decryptedRows = rows.map((r) => {
    const decode = (v: string | null): string | null => {
      if (v == null) return null;
      return r.encryptionTier === "user"
        ? tryDecryptField(dek, v) // returns null on auth-tag failure
        : decryptStaged(v);
    };
    return {
      ...r,
      payee: decode(r.payee),
      category: decode(r.category),
      accountName: decode(r.accountName),
      note: decode(r.note),
    };
  });

  // ─── Issue #154: statement-balance reconciliation ──────────────────────
  // When the staged import has a bound account AND a statement balance, the
  // review page renders a three-column "Statement says / Finlynq has now /
  // After approval" callout. Compute the numbers server-side so the client
  // doesn't have to reach into balances + holdings-value + FX itself.
  let currentBalance: number | null = null;
  let projectedBalance: number | null = null;
  let pendingDelta: number | null = null;
  let boundAccountCurrency: string | null = null;

  if (staged.boundAccountId != null) {
    const acct = await db
      .select({
        id: schema.accounts.id,
        currency: schema.accounts.currency,
        isInvestment: schema.accounts.isInvestment,
      })
      .from(schema.accounts)
      .where(and(
        eq(schema.accounts.id, staged.boundAccountId),
        eq(schema.accounts.userId, userId),
      ))
      .get();

    if (acct) {
      boundAccountCurrency = acct.currency;
      // CLAUDE.md: "Account balance for accounts with holdings = holdings.value,
      // NOT b.balance + holdings.value." The dashboard route is the canonical
      // pattern; mirror it here. For pure-cash accounts holdingsByAccount has
      // no entry → fall through to SUM(transactions.amount).
      let balanceInAccountCcy: number;
      if (acct.isInvestment) {
        // Investment accounts always go through holdings-value, even if the
        // map is empty (a brand-new investment account with no positions
        // sums to 0). Don't fall back to the cash-account formula.
        const holdingsByAccount = await getHoldingsValueByAccount(userId, dek);
        balanceInAccountCcy = holdingsByAccount.get(acct.id)?.value ?? 0;
      } else {
        const sumRow = await db
          .select({
            balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
          })
          .from(schema.transactions)
          .where(and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.accountId, acct.id),
          ))
          .get();
        balanceInAccountCcy = Number(sumRow?.balance ?? 0);
      }

      // Projected delta: sum of staged amounts that count toward the
      // post-approval balance. Only NEW + PROBABLE_DUPLICATE rows count
      // (EXISTING rows would double-count — they're already in the live
      // transactions table). Row status='pending' filters out rows the
      // user has already actioned in a prior partial approve.
      // Amounts are stored in the staged row's `currency`, which the
      // upload route defaults to the bound account's currency for
      // OFX/QFX uploads. CSV rows can carry a different currency; this
      // projection assumes per-row currency matches the account, which
      // is the common case. If a user hits a mixed-currency CSV the
      // projection will be slightly off — accepted tradeoff (display-
      // only, "user is the judge").
      const eligibleRows = rows.filter(
        (r) => r.rowStatus === "pending" && r.dedupStatus !== "existing",
      );
      pendingDelta = eligibleRows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);

      // Statement currency for display. Falls back to account currency when
      // the upload didn't carry one (most CSV cases).
      const stmtCcy = staged.statementCurrency ?? acct.currency;

      // FX-convert "Finlynq has now" + projection into the statement
      // currency for like-with-like display. Same-currency = no-op via
      // getRate's early-return.
      let fxRate = 1;
      if (stmtCcy !== acct.currency) {
        try {
          fxRate = await getRate(
            acct.currency,
            stmtCcy,
            new Date().toISOString().split("T")[0],
            userId,
          );
        } catch {
          // FX failure → display in account currency unconverted.
          fxRate = 1;
        }
      }

      currentBalance = balanceInAccountCcy * fxRate;
      projectedBalance = (balanceInAccountCcy + pendingDelta) * fxRate;
    }
  }

  return NextResponse.json({
    staged,
    rows: decryptedRows,
    reconciliation: {
      currentBalance,
      projectedBalance,
      pendingDelta,
      boundAccountCurrency,
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id } = await params;

  // Delete is scoped — if the id doesn't belong to this user, row count = 0
  // and we surface 404 without leaking that the id exists for someone else.
  const result = await db
    .delete(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ));

  // Drizzle returns different shapes per dialect; check rowCount via any-cast.
  const rc = (result as unknown as { rowCount?: number }).rowCount ?? null;
  if (rc === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
