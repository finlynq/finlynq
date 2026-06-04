/**
 * GET   /api/settings/backfill/[runId]   — list proposals for this run
 * PATCH /api/settings/backfill/[runId]   — update one proposal's status/variant
 *
 * Status transitions enforced server-side:
 *   pending  → approved | rejected
 *   approved → applied (only via /apply route, not here)
 *   applied  → undone  (only via /undo route, not here)
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { tryDecryptField } from "@/lib/crypto/envelope";

// MUST stay in sync with the CHECK constraint on
// backfill_proposals.chosen_kind (migration 20260609) and with
// OverrideKind in src/lib/portfolio/backfill/apply.ts.
const overrideKindSchema = z.enum([
  "opening_balance",
  "dividend",
  "interest",
  "portfolio_income",
  "portfolio_expense",
  "buy",
  "sell",
  "in_kind_transfer_in",
  "in_kind_transfer_out",
  "fx_from",
  "fx_to",
  "brokerage_deposit_in",
  "brokerage_deposit_out",
  "brokerage_withdrawal_in",
  "brokerage_withdrawal_out",
]);

const patchSchema = z.object({
  proposalId: z.number().int().positive(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  variantChoice: z.enum(["separate_fee_row", "absorb_into_cost"]).nullable().optional(),
  // Set by the holding-picker on `dividend_reinvestment` proposals. The
  // apply route refuses with `holding_choice_missing` if it's still NULL
  // at apply time.
  chosenHoldingId: z.number().int().positive().nullable().optional(),
  // Set by the dividend-variant radio on `dividend_reinvestment`
  // proposals. Pre-filled with the planner's suggestion; user can flip
  // before approving. Apply refuses with `dividend_variant_missing` if
  // NULL at apply time.
  dividendVariant: z.enum(["cash_dividend", "drip"]).nullable().optional(),
  // Kind override (migration 20260609) — set ONLY by the override picker
  // on refused `orphan_stock_leg` proposals.
  chosenKind: overrideKindSchema.nullable().optional(),
  chosenCounterpartTxId: z.number().int().positive().nullable().optional(),
  chosenCounterpartMode: z.enum(["link_existing", "synth_new"]).nullable().optional(),
  chosenRelatedHoldingId: z.number().int().positive().nullable().optional(),
  // Category for a pair-less income override (migration 20260614). Optional —
  // for dividend/interest the apply path resolves-or-creates a default when
  // this is NULL; the user may override here.
  chosenCategoryId: z.number().int().positive().nullable().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { runId } = await params;
  try {
    const proposals = await db
      .select()
      .from(schema.backfillProposals)
      .where(
        and(
          eq(schema.backfillProposals.runId, runId),
          eq(schema.backfillProposals.userId, auth.userId),
        ),
      )
      .orderBy(schema.backfillProposals.id);

    // Enrich with displaced row details + holding/account display names so the
    // right-pane shows actual transaction info instead of just "Tx #ID".
    const allTxIds = new Set<number>();
    for (const p of proposals) {
      for (const id of (p.existingRowIds ?? [])) allTxIds.add(id);
    }
    const displacedRowsRaw = allTxIds.size === 0 ? [] : await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        accountId: schema.transactions.accountId,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
        relatedHoldingId: schema.transactions.relatedHoldingId,
        categoryId: schema.transactions.categoryId,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        quantity: schema.transactions.quantity,
        kind: schema.transactions.kind,
        tradeLinkId: schema.transactions.tradeLinkId,
        linkId: schema.transactions.linkId,
        // Encrypted-at-rest free-text fields — decrypt below so the
        // RowDetails secondary line can render them without a second
        // round-trip. Columns are `note`/`tags`/`payee` (not `_ct`-suffixed);
        // the encrypted ciphertext is stored in-place. tryDecryptField
        // returns null on tag mismatch — legacy plaintext rows fall back
        // to the raw value via the ?? coalesce.
        note: schema.transactions.note,
        tags: schema.transactions.tags,
        payee: schema.transactions.payee,
        source: schema.transactions.source,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, auth.userId),
          inArray(schema.transactions.id, Array.from(allTxIds)),
        ),
      );

    // Decrypt the free-text fields once per row server-side. The UI
    // never sees ciphertext — same pattern as the holdingMap / accountMap
    // labels below.
    const displacedRows = displacedRowsRaw.map((r) => ({
      id: r.id,
      date: r.date,
      accountId: r.accountId,
      portfolioHoldingId: r.portfolioHoldingId,
      relatedHoldingId: r.relatedHoldingId,
      categoryId: r.categoryId,
      amount: r.amount,
      currency: r.currency,
      quantity: r.quantity,
      kind: r.kind,
      tradeLinkId: r.tradeLinkId,
      linkId: r.linkId,
      note:
        auth.dek && r.note
          ? tryDecryptField(auth.dek, r.note, "transactions.note") ?? r.note
          : r.note ?? null,
      tags:
        auth.dek && r.tags
          ? tryDecryptField(auth.dek, r.tags, "transactions.tags") ?? r.tags
          : r.tags ?? null,
      payee:
        auth.dek && r.payee
          ? tryDecryptField(auth.dek, r.payee, "transactions.payee") ?? r.payee
          : r.payee ?? null,
      source: r.source ?? null,
    }));

    // Holding + account labels (decrypted display names)
    const holdingsRaw = await db
      .select({
        id: schema.portfolioHoldings.id,
        nameCt: schema.portfolioHoldings.nameCt,
        isCash: schema.portfolioHoldings.isCash,
        currency: schema.portfolioHoldings.currency,
      })
      .from(schema.portfolioHoldings)
      .where(eq(schema.portfolioHoldings.userId, auth.userId));
    const holdingMap: Record<number, { name: string | null; isCash: boolean; currency: string }> = {};
    for (const h of holdingsRaw) {
      holdingMap[h.id] = {
        name: decryptName(h.nameCt, auth.dek, null) ?? null,
        isCash: Boolean(h.isCash),
        currency: h.currency,
      };
    }

    const accountsRaw = await db
      .select({
        id: schema.accounts.id,
        nameCt: schema.accounts.nameCt,
        currency: schema.accounts.currency,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, auth.userId));
    const accountMap: Record<number, { name: string | null; currency: string }> = {};
    for (const a of accountsRaw) {
      accountMap[a.id] = {
        name: decryptName(a.nameCt, auth.dek, null) ?? null,
        currency: a.currency,
      };
    }

    // Category labels (decrypted) — needed by the RowDetails secondary
    // line that the override-picker UI surfaces. Categories are encrypted
    // via the same envelope helpers; schema column is `name_ct`.
    const categoriesRaw = await db
      .select({
        id: schema.categories.id,
        nameCt: schema.categories.nameCt,
        type: schema.categories.type,
      })
      .from(schema.categories)
      .where(eq(schema.categories.userId, auth.userId));
    const categoryMap: Record<number, { name: string | null; type: string | null }> = {};
    for (const c of categoriesRaw) {
      categoryMap[c.id] = {
        name: decryptName(c.nameCt, auth.dek, null) ?? null,
        type: c.type ?? null,
      };
    }

    return NextResponse.json({
      proposals,
      displacedRows,
      holdingMap,
      accountMap,
      categoryMap,
    });
  } catch (err: unknown) {
    await logApiError("GET", `/api/settings/backfill/${runId}`, err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to load proposals") },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { runId } = await params;
  try {
    const body = await request.json();
    const parsed = validateBody(body, patchSchema);
    if (parsed.error) return parsed.error;
    const {
      proposalId,
      status,
      variantChoice,
      chosenHoldingId,
      dividendVariant,
      chosenKind,
      chosenCounterpartTxId,
      chosenCounterpartMode,
      chosenRelatedHoldingId,
      chosenCategoryId,
    } = parsed.data;

    // Verify the proposal belongs to this run+user.
    const existing = await db
      .select({
        id: schema.backfillProposals.id,
        status: schema.backfillProposals.status,
        proposalKind: schema.backfillProposals.proposalKind,
      })
      .from(schema.backfillProposals)
      .where(
        and(
          eq(schema.backfillProposals.id, proposalId),
          eq(schema.backfillProposals.runId, runId),
          eq(schema.backfillProposals.userId, auth.userId),
        ),
      );
    if (existing.length === 0) {
      return NextResponse.json({ error: "Proposal not found in run" }, { status: 404 });
    }
    const row = existing[0];
    if (row.status === "applied" || row.status === "undone") {
      return NextResponse.json(
        { error: `Proposal already in terminal status '${row.status}'` },
        { status: 409 },
      );
    }

    // Status transition: `refused_with_reason → approved` is only valid
    // when the caller also stamps a chosen_kind on an orphan_stock_leg
    // proposal. Without an override the proposal stays refused and the
    // apply route short-circuits with `refused_proposal`.
    if (row.status === "refused_with_reason" && status === "approved") {
      if (row.proposalKind !== "orphan_stock_leg") {
        return NextResponse.json(
          { error: `Cannot promote a refused ${row.proposalKind} proposal — only orphan_stock_leg supports kind override.` },
          { status: 409 },
        );
      }
      if (chosenKind == null) {
        return NextResponse.json(
          { error: `Promoting a refused orphan_stock_leg requires chosenKind to be set in the same request.` },
          { status: 409 },
        );
      }
    }

    const patch: Record<string, unknown> = {};
    if (status !== undefined) patch.status = status;
    if (variantChoice !== undefined) patch.variantChoice = variantChoice;
    if (chosenHoldingId !== undefined) patch.chosenHoldingId = chosenHoldingId;
    if (dividendVariant !== undefined) patch.dividendVariant = dividendVariant;
    if (chosenKind !== undefined) patch.chosenKind = chosenKind;
    if (chosenCounterpartTxId !== undefined) patch.chosenCounterpartTxId = chosenCounterpartTxId;
    if (chosenCounterpartMode !== undefined) patch.chosenCounterpartMode = chosenCounterpartMode;
    if (chosenRelatedHoldingId !== undefined) patch.chosenRelatedHoldingId = chosenRelatedHoldingId;
    if (chosenCategoryId !== undefined) patch.chosenCategoryId = chosenCategoryId;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: true, noop: true });
    }
    await db
      .update(schema.backfillProposals)
      .set(patch)
      .where(eq(schema.backfillProposals.id, proposalId));
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    await logApiError("PATCH", `/api/settings/backfill/${runId}`, err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to update proposal") },
      { status: 500 },
    );
  }
}
