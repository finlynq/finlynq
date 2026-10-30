/**
 * GET /api/budgets/month?month=YYYY-MM — the month's cash-flow budget (Budget
 * v2): income, spending (by category or by expense group), debt payments,
 * excluded lines, account roles and totals, all in the display currency.
 * Built by `loadBudgetMonth`, which MCP `get_budget_summary` also uses.
 */
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { isMonth } from "@/lib/budgets/lines";
import { loadBudgetMonth } from "@/lib/budgets/load-month";
import { todayISO } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const month = new URL(request.url).searchParams.get("month") ?? todayISO().slice(0, 7);
  if (!isMonth(month)) return apiError("month must be YYYY-MM.", 400);
  return loadBudgetMonth(userId, dek, month);
});
