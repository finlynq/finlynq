/** Client calls for the budgets page (Budget v2). Every call throws a readable message on failure. */
import { parseSaveError } from "@/lib/save-error";
import type { BudgetMonth } from "@/lib/budgets/month";
import type { FillAdjust, FillSource } from "@/lib/budgets/fill";
import type { BudgetRole } from "@/lib/budgets/lines";
import type { RuleIncrease } from "@/lib/budgets/rules";
// Type-only imports from server modules: erased at build, nothing server-side reaches the bundle.
import type { LineRulesView } from "@/lib/budgets/rule-store";
import type { FillRulePreview } from "@/lib/budgets/write";

export type { LineRulesView, FillRulePreview };

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
    mode?: "values" | "this_month" | "rules";
    noEnd?: boolean;
  }) =>
    call<{
      rows: Array<{ key: string; name: string; month: string; amount: number; previous: number | null }>;
      rules: FillRulePreview[];
      applied: boolean;
      total: number;
      currency: string;
    }>(
      "/api/budgets/fill",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      "Couldn't fill the budgets",
    ),

  /** The cell of an open month on a line with rules. */
  adjust: (key: string, month: string, change: { adjustment?: number | null; override?: number | null }) =>
    call<unknown>("/api/budgets/adjust", put({ key, month, ...change }), "Couldn't save the budget"),

  rules: (key: string, month: string) =>
    call<LineRulesView>(`/api/budgets/rules?key=${encodeURIComponent(key)}&month=${encodeURIComponent(month)}`, undefined, "Couldn't load the rules"),

  createRule: (key: string, rule: RuleInput) =>
    call<{ id: number }>(
      "/api/budgets/rules",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, ...rule }) },
      "Couldn't save the rule",
    ),

  updateRule: (id: number, rule: RuleInput) => call<unknown>("/api/budgets/rules", put({ id, ...rule }), "Couldn't save the rule"),

  deleteRule: (id: number) => call<unknown>(`/api/budgets/rules?id=${id}`, { method: "DELETE" }, "Couldn't delete the rule"),
};

export interface RuleInput {
  amount: number;
  startMonth: string;
  endMonth: string | null;
  increase: RuleIncrease | null;
}
