/**
 * PUT /api/budgets/settings — how something counts in the budget.
 *   { target: { categoryId } , month, excluded?, rollover?, rolloverNegative? }
 *   { target: { group },       month, excluded?, byGroup?, rollover?, rolloverNegative? }
 *   { target: { accountId },   role: "categories" | "debt_payment" | "excluded" | null, paymentAmount? }
 * `month` is the month on screen: rollover starts there, and budgeting a group
 * as one line moves its categories' budgets from that month on into it.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { getDisplayCurrency } from "@/lib/fx-service";
import { BUDGET_ROLES, MONTH_RE } from "@/lib/budgets/lines";
import { setAccountBudgetRole, updateLineSettings } from "@/lib/budgets/write";
import { budgetMapError } from "@/lib/budgets/api-errors";

const body = z.object({
  target: z.union([
    z.object({ categoryId: z.number().int().positive() }),
    z.object({ group: z.string() }),
    z.object({ accountId: z.number().int().positive() }),
  ]),
  month: z.string().regex(MONTH_RE, "month must be YYYY-MM").optional(),
  excluded: z.boolean().optional(),
  rollover: z.boolean().optional(),
  rolloverNegative: z.enum(["carry", "reset"]).optional(),
  byGroup: z.boolean().optional(),
  role: z.enum(BUDGET_ROLES).nullable().optional(),
  paymentAmount: z.number().nonnegative().nullable().optional(),
});

export const PUT = apiHandler({ auth: "auth", body, mapError: budgetMapError }, async ({ userId, body }) => {
  const t = body.target;
  if ("accountId" in t) {
    if (body.role === undefined && body.paymentAmount === undefined) return apiError("Nothing to change.", 400);
    await setAccountBudgetRole(userId, t.accountId, body.role ?? null, body.paymentAmount);
    return { accountId: t.accountId, role: body.role ?? null };
  }
  if (!body.month) return apiError("month is required.", 400);
  const currency = await getDisplayCurrency(userId);
  const result = await updateLineSettings(
    userId,
    currency,
    "categoryId" in t ? { categoryId: t.categoryId } : { group: t.group },
    { excluded: body.excluded, rollover: body.rollover, rolloverNegative: body.rolloverNegative, byGroup: body.byGroup },
    body.month,
  );
  return result;
});
