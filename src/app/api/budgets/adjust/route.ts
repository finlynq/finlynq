/**
 * PUT /api/budgets/adjust { key, month, adjustment?: number | null, override?: number | null }
 *
 * The budget cell of an open month on a line with rules (plan/budget-rules.md):
 *   adjustment - added to the rules' amount (negative takes off; null = none)
 *   override   - "use only this amount" this month (rules ignored); null stops it
 * A month that has ended is refused: type its budget with PUT /api/budgets/line.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { MONTH_RE } from "@/lib/budgets/lines";
import { setBudgetAdjustment } from "@/lib/budgets/write";
import { budgetMapError } from "@/lib/budgets/api-errors";

const body = z
  .object({
    key: z.string().min(3),
    month: z.string().regex(MONTH_RE, "month must be YYYY-MM"),
    adjustment: z.number().finite().min(-1e12).max(1e12).nullable().optional(),
    override: z.number().finite().min(-1e12).max(1e12).nullable().optional(),
  })
  .refine((b) => b.adjustment !== undefined || b.override !== undefined, { message: "Send adjustment or override." });

export const PUT = apiHandler({ auth: "auth", body, mapError: budgetMapError }, async ({ userId, body }) => {
  await setBudgetAdjustment(userId, body.key, body.month, { adjustment: body.adjustment, override: body.override });
  return { key: body.key, month: body.month };
});
