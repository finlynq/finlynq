import type { GuideModule } from "../types";

export const guide: GuideModule = {
  id: "budgeting",
  title: "Budgets",
  summary: "Read a month's budget, set amounts, use rules that repeat or grow, and roll money over.",
  order: 40,
  markdown: `# Budgets

A Finlynq budget is a cash-flow budget: it covers income as well as spending, plus loan payments and expense groups budgeted as one line.

## Reading a month
\`get_budget_summary(month)\` returns every line for the month (\`YYYY-MM\`): budgeted, spent or received, left, any amount carried in from last month, and the rules behind each line. It is the same calculation the Budgets page shows.

How transactions are counted (each one counts in at most one line):
- Only income and expense categories count; transfers do not.
- Transactions on an account that pays down a loan count under that loan's debt line, not under their category.
- Accounts the user left out count nowhere.
- A split transaction counts each part under its own category.

## Setting amounts
\`manage_budgets\` with \`op\`:
- \`set\` / \`delete\`: one line's amount for one month.
- \`fill\`: fill several months at once from past spending or a fixed amount, optionally growing each month or year. Preview first.
- \`settings\`: per-line options: leave out, budget a group as one line, roll over unspent money, carry overspending.
- \`carryover\`: reset or set what a rolled-over line carries into a month.

## Rules
A rule is an amount for a line from a start month to an optional end month, with an optional increase (a percent or an amount, every month or every year in a chosen month). Use rules when the user describes something that repeats ("$600 groceries from March, up 3% every January").
- \`rules\`, \`add_rule\`, \`update_rule\` (fields you leave out are kept), \`delete_rule\`.
- \`adjust\`: add a one-off amount on top of the rules for a month (\`adjustment\`), or use only a typed amount for that month (\`only_this_amount\`).
Rules fill the current month and later. A month that has ended keeps the budget it had; rules never rewrite the past.

## Good habits
- Ask before overwriting months that already have amounts; \`fill\` can be told to fill empty months only.
- Budgets are stored in the user's display currency.
- "Not budgeted" lines are normal: every category is listed, budgeted or not.
`,
};
