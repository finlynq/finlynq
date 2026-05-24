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

const patchSchema = z.object({
  proposalId: z.number().int().positive(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  variantChoice: z.enum(["separate_fee_row", "absorb_into_cost"]).nullable().optional(),
  // Set by the holding-picker on `dividend_reinvestment` proposals. The
  // apply route refuses with `holding_choice_missing` if it's still NULL
  // at apply time.
  chosenHoldingId: z.number().int().positive().nullable().optional(),
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
    const displacedRows = allTxIds.size === 0 ? [] : await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        accountId: schema.transactions.accountId,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        quantity: schema.transactions.quantity,
        kind: schema.transactions.kind,
        tradeLinkId: schema.transactions.tradeLinkId,
        linkId: schema.transactions.linkId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, auth.userId),
          inArray(schema.transactions.id, Array.from(allTxIds)),
        ),
      );

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

    return NextResponse.json({
      proposals,
      displacedRows,
      holdingMap,
      accountMap,
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
    const { proposalId, status, variantChoice, chosenHoldingId } = parsed.data;

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

    const patch: Record<string, unknown> = {};
    if (status !== undefined) patch.status = status;
    if (variantChoice !== undefined) patch.variantChoice = variantChoice;
    if (chosenHoldingId !== undefined) patch.chosenHoldingId = chosenHoldingId;
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
