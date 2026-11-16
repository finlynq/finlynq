import type { GuideModule } from "../types";

export const guide: GuideModule = {
  id: "loans",
  title: "Loans, payments and interest",
  summary: "Record loan payments and interest correctly, and work with a loan's schedule.",
  order: 30,
  markdown: `# Loans, payments and interest

## Tools
- Reading: \`manage_loans(op='list')\`, \`get_loan_amortization\`, \`get_debt_payoff_plan\`.
- Writing: \`manage_loans\` with \`op\` = \`add\`, \`update\`, \`delete\`, \`post_interest\`, \`set_schedule\`, \`set_interest\`, \`set_payment\`, \`reset_schedule\`.

## Recording a payment
A loan payment is ONE plain transfer into the loan's linked account (\`manage_transfers\`). Never split it into principal and interest.

## Recording interest
Interest is a separate expense on the loan's linked account. \`manage_loans(op='post_interest', loan_id)\` books the oldest period that is due at the schedule's figure (pass \`amount\` when the lender charged something else). You can also record it with \`manage_transactions\` on that account in the loan's interest category. Interest adds to what is owed, the payment takes the full amount off, so the balance falls by the principal only.

Any transaction on the linked account in the loan's interest category counts as booked, however it was entered, and is matched to the nearest payment date. \`post_interest\` refuses a period that already has interest, and refuses to book interest as the very first entry on an empty account (record the opening balance first).

## The schedule
A schedule is calculated from the principal, rate and term (or payment), unless the loan has its own:
- \`set_interest\`: replace the interest of single rows.
- \`set_payment\`: replace the payment of single rows; interest stays calculated, so later rows and the payoff date follow.
- \`set_schedule\`: supply full rows \`{date, payment, interest}\` that replace the calculation (\`merge: true\` to change a few).
- \`reset_schedule\`: back to calculated.
\`get_loan_amortization\` returns the rows in effect and \`scheduleMode\`.

How interest is worked out is the loan's \`interest_method\`: \`rate\` (the annual rate on the balance owed), \`flat\` (a fixed interest amount with every payment, how some loans are advertised) or \`total\` (one interest total over the whole loan). Calculated schedules return \`effectiveAnnualRate\`, the real yearly rate on the balance owed; show it when a loan was quoted flat.

## Checking what the lender charged
Once interest is booked, \`get_loan_amortization\` returns \`interestCheck\`: whether the lender charged more or less than the schedule, with a suggested rate when the difference is steady. It looks at recent payments only, because an extra payment or a change of terms shifts every later period. Always tell the user the \`window\` it covers, and never change the rate without the user agreeing.

## Currency
A loan has its own currency. Per-loan amounts are in that currency; totals across loans use the converted (display currency) figures.
`,
};
