import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import {
  recordPortfolioIncomeOrExpense,
  recordReinvestedIncomeInShares,
} from "@/lib/portfolio/operations";
import { resolveOrCreateInvestmentIncomeCategory } from "@/lib/investment-income-category";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { mapOperationError, replacePortfolioOperation } from "../_helpers";

const schema = z.object({
  accountId: z.number().int().positive(),
  // Optional: the cash path requires it; the "shares" path derives currency
  // from the destination holding and omits it.
  currency: z.string().min(2).max(8).optional(),
  amount: z.number().refine((v) => v !== 0, { message: "amount cannot be 0" }),
  relatedHoldingId: z.number().int().positive().nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  // Income-type hint: when set (and no explicit categoryId is given), the
  // server resolves-or-creates the matching category so the row lands in the
  // right report. 'dividend'/'interest' apply to income (amount>0); 'fee' to
  // expense (amount<0); 'other' leaves the category as-is.
  incomeType: z.enum(["dividend", "interest", "fee", "other"]).optional(),
  date: z.string(),
  payee: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  editId: z.number().int().positive().optional(),
  // Income received AS SHARES (single-leg DRIP). When "shares", `holdingId`
  // + `quantity` are required and the income lands on that stock holding
  // instead of a cash sleeve (income only — positive amount = $ value). The
  // user may pick any category. Defaults to the legacy cash-sleeve path.
  settleAs: z.enum(["cash", "shares"]).optional(),
  holdingId: z.number().int().positive().optional(),
  quantity: z.number().positive().optional(),
});

// raw/compat mode — bare-shape consumers (web forms + mobile). See buy/route.ts.
export const POST = apiHandler(
  {
    auth: "encryption",
    body: schema,
    raw: true,
    mapError: mapOperationError,
    fallbackMessage: "Failed to record portfolio income/expense",
  },
  async ({ userId, dek, body }) => {
    const { editId, incomeType, settleAs, holdingId, quantity, currency, ...input } =
      body;

    // ── Income received as shares (single-leg DRIP) ─────────────────────
    // Create OR edit. On edit (`editId` set) we cascade-delete the original
    // row (reversing its lot) before re-recording, so editing a share
    // dividend keeps it as shares instead of converting it to a cash dividend.
    if (settleAs === "shares") {
      if (input.amount <= 0) {
        return NextResponse.json(
          { error: "Income value must be greater than 0." },
          { status: 400 },
        );
      }
      if (holdingId == null || quantity == null || quantity <= 0) {
        return NextResponse.json(
          { error: "Pick a holding and enter a share quantity greater than 0." },
          { status: 400 },
        );
      }
      // Category resolution mirrors the cash path: an explicit categoryId
      // (any category the user picked) always wins; otherwise a dividend/
      // interest preset resolves-or-creates its canonical category. "other"/
      // unset leaves the category null.
      let sharesCategoryId = input.categoryId ?? null;
      if (
        sharesCategoryId == null &&
        (incomeType === "dividend" || incomeType === "interest")
      ) {
        sharesCategoryId = await resolveOrCreateInvestmentIncomeCategory(
          db,
          userId,
          dek,
          incomeType,
        );
      }
      // Delete + record in ONE transaction on edit — a failure in the record
      // step used to leave the original share-dividend row destroyed.
      const recordShares = () => recordReinvestedIncomeInShares({
        userId,
        dek,
        accountId: input.accountId,
        holdingId,
        qty: quantity,
        amount: input.amount,
        categoryId: sharesCategoryId,
        date: input.date,
        payee: input.payee,
        note: input.note,
        tags: input.tags,
        source: "manual",
      });
      let sharesResult;
      if (editId != null) {
        const replaced = await replacePortfolioOperation(userId, editId, recordShares);
        if (!replaced.ok) return replaced.response;
        sharesResult = replaced.result;
      } else {
        sharesResult = await recordShares();
      }
      invalidateUserTxCache(userId);
      await markSnapshotsDirty(userId, input.date);
      return NextResponse.json(
        editId != null ? { ...sharesResult, replaced: editId } : sharesResult,
        { status: 201 },
      );
    }

    // ── Cash-sleeve income/expense (existing path) ──────────────────────
    if (!currency) {
      return NextResponse.json(
        { error: "Pick a currency / cash sleeve." },
        { status: 400 },
      );
    }
    // Category resolution precedence: an explicit categoryId (user override)
    // always wins. Otherwise map the income type to its canonical category,
    // creating it if missing, so dividends/interest/fees report correctly.
    // 'dividend'/'interest' only make sense for income (amount>0); 'fee' for
    // expense (amount<0). 'other' (or unset) leaves the category untouched.
    let categoryId = input.categoryId ?? null;
    if (categoryId == null && incomeType && incomeType !== "other") {
      const wantIncome = incomeType === "dividend" || incomeType === "interest";
      if ((wantIncome && input.amount > 0) || (incomeType === "fee" && input.amount < 0)) {
        categoryId = await resolveOrCreateInvestmentIncomeCategory(
          db,
          userId,
          dek,
          incomeType,
        );
      }
    }
    const recordCash = () => recordPortfolioIncomeOrExpense({
      ...input,
      currency,
      categoryId,
      userId,
      dek,
      source: "manual",
    });
    let result;
    if (editId != null) {
      const replaced = await replacePortfolioOperation(userId, editId, recordCash);
      if (!replaced.ok) return replaced.response;
      result = replaced.result;
    } else {
      result = await recordCash();
    }
    invalidateUserTxCache(userId);
    // Snapshot history is stale from this trade date forward — auto-rebuild.
    await markSnapshotsDirty(userId, input.date);
    return NextResponse.json(
      editId != null ? { ...result, replaced: editId } : result,
      { status: 201 },
    );
  },
);
