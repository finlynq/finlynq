/** Client calls for the budgets page (Budget v2). Every call throws a readable message on failure. */
import { parseSaveError } from "@/lib/save-error";
import type { BudgetMonth } from "@/lib/budgets/month";
import type { FillAdjust, FillSource } from "@/lib/budgets/fill";
import type { BudgetRole } from "@/lib/budgets/lines";

async function call<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Network error. Please try again.");
  }
  if (!res.ok) throw new Error(await parseSaveError(res, fallback));
  const json = await res.json();
  return (json?.data ?? json) as T;
}

const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const budgetApi = {
  month: (month: string) =>
    call<BudgetMonth>(`/api/budgets/month?month=${encodeURIComponent(month)}`, undefined, "Couldn't load the budget"),

  setLine: (key: string, month: string, amount: number | null) =>
    call<unknown>("/api/budgets/line", put({ key, month, amount }), "Couldn't save the budget"),

  settings: (body: {
    target: { categoryId: number } | { group: string } | { accountId: number };
    month?: string;
    excluded?: boolean;
    rollover?: boolean;
    rolloverNegative?: "carry" | "reset";
    byGroup?: boolean;
    role?: BudgetRole | null;
    paymentAmount?: number | null;
  }) => call<{ movedBudgets?: number }>("/api/budgets/settings", put(body), "Couldn't save the setting"),

  carryover: (key: string, month: string, amount: number | null) =>
    call<unknown>("/api/budgets/carryover", put({ key, month, amount }), "Couldn't save the carryover"),

  fill: (body: {
    months: string[];
    source: FillSource;
    adjust?: FillAdjust | null;
    overwrite: boolean;
    scope: { kind: "all" } | { kind: "keys"; keys: string[] } | { kind: "group"; group: string };
    section: "spending" | "income";
    preview: boolean;
  }) =>
    call<{ rows: Array<{ key: string; name: string; month: string; amount: number; previous: number | null }>; applied: boolean; total: number; currency: string }>(
      "/api/budgets/fill",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      "Couldn't fill the budgets",
    ),
};
