/**
 * PUT /api/budgets/carryover { key, month, amount | null }
 * Pins what a rollover line carries into `month`: 0 resets it, another amount
 * sets it, null removes the pin so the carry is computed from history again.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { getDisplayCurrency } from "@/lib/fx-service";
import { MONTH_RE } from "@/lib/budgets/lines";
import { setCarryover } from "@/lib/budgets/write";
import { budgetMapError } from "@/lib/budgets/api-errors";

const body = z.object({
  key: z.string().min(3),
  month: z.string().regex(MONTH_RE, "month must be YYYY-MM"),
  amount: z.number().nullable(),
});

export const PUT = apiHandler({ auth: "auth", body, mapError: budgetMapError }, async ({ userId, body }) => {
  const currency = await getDisplayCurrency(userId);
  await setCarryover(userId, currency, body.key, body.month, body.amount);
  return { key: body.key, month: body.month, amount: body.amount };
});
