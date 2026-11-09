/**
 * /api/loans/schedule — a loan's own schedule.
 *
 *   GET ?loanId=N → { mode, manualSchedule, interestOverrides, paymentOverrides, summary }
 *   PUT { loanId, manualSchedule?, mergeRows?, interestOverrides?, clearInterestOverrides?,
 *         paymentOverrides?, clearPaymentOverrides? }
 *       → the same shape, after the change
 *
 * `manualSchedule`: rows `{ date, payment, interest }` that replace the
 * calculation (`null` goes back to calculated; `mergeRows` lays them over the
 * current schedule by date instead of replacing it). `interestOverrides`: a
 * date -> amount map for single calculated rows (`null` amount removes one).
 * `paymentOverrides`: the same for the payment of single calculated rows; the
 * interest stays calculated, so principal and later balances follow.
 *
 * Everything is validated in `saveLoanSchedule` by building the resulting
 * schedule, so a change that cannot be scheduled is refused with a message and
 * nothing is stored. Shared with the MCP `manage_loans` schedule ops.
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { MAX_SCHEDULE_ROWS } from "@/lib/loan-calculator";
import { readLoanSchedule, saveLoanSchedule } from "@/lib/loans/schedule-store";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId }) => {
  const loanId = Number(new URL(request.url).searchParams.get("loanId"));
  if (!Number.isInteger(loanId) || loanId <= 0) return apiError("loanId is required.", 400);
  return readLoanSchedule(userId, loanId);
});

const rowSchema = z.object({
  date: z.string(),
  payment: z.number(),
  interest: z.number(),
});

const putSchema = z.object({
  loanId: z.number().int().positive(),
  manualSchedule: z.array(rowSchema).max(MAX_SCHEDULE_ROWS).nullable().optional(),
  mergeRows: z.boolean().optional(),
  interestOverrides: z.record(z.string(), z.number().nullable()).nullable().optional(),
  clearInterestOverrides: z.boolean().optional(),
  paymentOverrides: z.record(z.string(), z.number().nullable()).nullable().optional(),
  clearPaymentOverrides: z.boolean().optional(),
});

export const PUT = apiHandler({ auth: "auth", body: putSchema }, async ({ userId, body }) => {
  const { loanId, ...change } = body;
  return saveLoanSchedule(userId, loanId, change);
});
