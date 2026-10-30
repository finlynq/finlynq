/**
 * PUT /api/budgets/line { key: "c:<categoryId>" | "g:<group>", month, amount | null }
 * Sets one budget cell (null clears it). Amounts are in the display currency.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { getDisplayCurrency } from "@/lib/fx-service";
import { MONTH_RE } from "@/lib/budgets/lines";
import { setBudgetCell } from "@/lib/budgets/write";
import { budgetMapError } from "@/lib/budgets/api-errors";

const body = z.object({
  key: z.string().min(3),
  month: z.string().regex(MONTH_RE, "month must be YYYY-MM"),
  amount: z.number().nonnegative().nullable(),
});

export const PUT = apiHandler({ auth: "auth", body, mapError: budgetMapError }, async ({ userId, body }) => {
  const currency = await getDisplayCurrency(userId);
  await setBudgetCell(userId, currency, body.key, body.month, body.amount);
  return { key: body.key, month: body.month, amount: body.amount };
});
