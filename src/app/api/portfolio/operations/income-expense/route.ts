import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { apiHandler } from "@/lib/api-handler";
import { recordPortfolioIncomeOrExpense } from "@/lib/portfolio/operations";
import { resolveOrCreateInvestmentIncomeCategory } from "@/lib/investment-income-category";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { mapOperationError, cascadeDeleteForReplace } from "../_helpers";

const schema = z.object({
  accountId: z.number().int().positive(),
  currency: z.string().min(2).max(8),
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
    const { editId, incomeType, ...input } = body;
    if (editId != null) {
      const refusal = await cascadeDeleteForReplace(userId, editId);
      if (refusal) return refusal;
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
    const result = await recordPortfolioIncomeOrExpense({
      ...input,
      categoryId,
      userId,
      dek,
      source: "manual",
    });
    invalidateUserTxCache(userId);
    // Snapshot history is stale from this trade date forward — auto-rebuild.
    await markSnapshotsDirty(userId, input.date);
    return NextResponse.json(
      editId != null ? { ...result, replaced: editId } : result,
      { status: 201 },
    );
  },
);
