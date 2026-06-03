/**
 * GET /api/settings/backfill/[runId]/counterpart-candidates?proposalId=&kind=
 *
 * Backs the `link_existing` counterpart picker on the kind-override flow. Given
 * a refused `orphan_stock_leg` proposal + the kind the user wants to convert it
 * to, returns plausible UNMATCHED counterpart rows the user can pair the orphan
 * with (instead of synthesizing a fresh counterpart).
 *
 * Phase 2 implements the Buy/Sell case: cash-side rows in the SAME account +
 * currency as the orphan, not already canonical / pair-linked, ranked by
 * amount-match then date proximity. Cross-account / cross-currency kinds
 * (transfer / fx / brokerage) return an empty list until their phases ship.
 *
 * Excludes: the orphan itself, rows already in a canonical pair-less kind, and
 * rows that already carry a trade_link_id / link_id (already paired).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { safeErrorMessage, logApiError } from "@/lib/validate";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { PAIRLESS_CANONICAL_KINDS } from "@/lib/portfolio/backfill/types";

function daysBetween(a: string, b: string): number {
  const da = Date.parse(a);
  const dbt = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(dbt)) return 9999;
  return Math.abs(Math.round((da - dbt) / 86_400_000));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { runId } = await params;
  const url = new URL(request.url);
  const proposalId = Number(url.searchParams.get("proposalId"));
  const kind = url.searchParams.get("kind") ?? "";

  try {
    if (!Number.isFinite(proposalId) || proposalId <= 0) {
      return NextResponse.json({ error: "proposalId required" }, { status: 400 });
    }

    // Load the proposal (scoped to this run + user).
    const propRows = await db
      .select({ existingRowIds: schema.backfillProposals.existingRowIds })
      .from(schema.backfillProposals)
      .where(
        and(
          eq(schema.backfillProposals.runId, runId),
          eq(schema.backfillProposals.userId, auth.userId),
          eq(schema.backfillProposals.id, proposalId),
        ),
      )
      .limit(1);
    const prop = propRows[0];
    if (!prop) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }
    const orphanId = (prop.existingRowIds ?? [])[0];
    if (orphanId == null) {
      return NextResponse.json({ candidates: [], orphan: null });
    }

    // Read the orphan row.
    const orphanRows = await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        accountId: schema.transactions.accountId,
        currency: schema.transactions.currency,
        amount: schema.transactions.amount,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
      })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.id, orphanId), eq(schema.transactions.userId, auth.userId)))
      .limit(1);
    const orphan = orphanRows[0];
    if (!orphan || orphan.accountId == null) {
      return NextResponse.json({ candidates: [], orphan: null });
    }
    const orphanMeta = {
      id: orphan.id,
      date: orphan.date,
      accountId: orphan.accountId,
      currency: orphan.currency,
      amount: orphan.amount ?? 0,
    };

    // Which counterpart family does the chosen kind belong to?
    const FAMILY: Record<string, "buysell" | "brokerage" | "fx" | "transfer"> = {
      buy: "buysell",
      sell: "buysell",
      brokerage_deposit_in: "brokerage",
      brokerage_withdrawal_out: "brokerage",
      fx_from: "fx",
      fx_to: "fx",
      in_kind_transfer_in: "transfer",
      in_kind_transfer_out: "transfer",
    };
    const family = FAMILY[kind];
    if (!family) {
      return NextResponse.json({ candidates: [], orphan: orphanMeta });
    }

    // Base filter: unmatched rows owned by the user, not the orphan.
    const conds = [
      eq(schema.transactions.userId, auth.userId),
      ne(schema.transactions.id, orphanId),
      isNull(schema.transactions.tradeLinkId),
      isNull(schema.transactions.linkId),
    ];
    // Account scope: buy/sell + fx pair within the SAME account; brokerage +
    // transfer pair with a row in a DIFFERENT account.
    if (family === "buysell" || family === "fx") {
      conds.push(eq(schema.transactions.accountId, orphan.accountId));
    } else {
      conds.push(ne(schema.transactions.accountId, orphan.accountId));
    }
    // Currency scope: buy/sell + brokerage match currency; fx wants a different
    // currency (filtered in JS); transfer is amount=0 (no currency constraint).
    if (family === "buysell" || family === "brokerage") {
      conds.push(eq(schema.transactions.currency, orphan.currency));
    }

    const rows = await db
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        accountId: schema.transactions.accountId,
        currency: schema.transactions.currency,
        amount: schema.transactions.amount,
        quantity: schema.transactions.quantity,
        kind: schema.transactions.kind,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
        isCash: schema.portfolioHoldings.isCash,
        holdingNameCt: schema.portfolioHoldings.nameCt,
      })
      .from(schema.transactions)
      .leftJoin(
        schema.portfolioHoldings,
        eq(schema.portfolioHoldings.id, schema.transactions.portfolioHoldingId),
      )
      .where(and(...conds))
      .limit(500);

    const orphanMag = Math.abs(orphanMeta.amount);
    const tolerance = Math.max(0.01, orphanMag * 0.05);
    const amountRanked = family === "buysell" || family === "brokerage";

    const candidates = rows
      // Not already in a canonical pair-less kind.
      .filter((r) => r.kind == null || !PAIRLESS_CANONICAL_KINDS.has(r.kind))
      // Per-family shape filter.
      .filter((r) => {
        if (family === "buysell") return Boolean(r.isCash) || r.portfolioHoldingId == null;
        if (family === "brokerage") return r.portfolioHoldingId == null; // external = non-investment row
        if (family === "fx") return (Boolean(r.isCash) || r.portfolioHoldingId == null) && r.currency !== orphanMeta.currency;
        // transfer: same holding moved to another account
        return r.portfolioHoldingId === orphan.portfolioHoldingId;
      })
      // Amount match only matters for the same-currency families.
      .filter((r) => !amountRanked || Math.abs(Math.abs(r.amount ?? 0) - orphanMag) <= tolerance)
      .map((r) => {
        const dAmt = Math.abs(Math.abs(r.amount ?? 0) - orphanMag);
        const dDays = daysBetween(r.date, orphanMeta.date);
        const reason = amountRanked
          ? `${dAmt <= 0.01 ? "exact amount" : `±${dAmt.toFixed(2)} ${r.currency}`}${dDays === 0 ? ", same day" : `, ${dDays}d apart`}`
          : `${r.currency}${dDays === 0 ? ", same day" : `, ${dDays}d apart`}`;
        return {
          id: r.id,
          date: r.date,
          accountId: r.accountId,
          currency: r.currency,
          amount: r.amount ?? 0,
          quantity: r.quantity,
          kind: r.kind,
          portfolioHoldingId: r.portfolioHoldingId,
          isCashSleeve: Boolean(r.isCash),
          holdingName: decryptName(r.holdingNameCt, auth.dek, null) ?? null,
          _dAmt: dAmt,
          _dDays: dDays,
          reason,
        };
      })
      .sort((a, b) => (amountRanked ? a._dAmt - b._dAmt : 0) || a._dDays - b._dDays)
      .slice(0, 25)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ _dAmt, _dDays, ...rest }) => rest);

    return NextResponse.json({ candidates, orphan: orphanMeta });
  } catch (err: unknown) {
    await logApiError("GET", "/api/settings/backfill/[runId]/counterpart-candidates", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to load counterpart candidates") },
      { status: 500 },
    );
  }
}
