# Loans & Debt v2 (FINLYNQ-136)

Status: **generally available since 2026-10-12** (the `DevModeGuard` on the page and
`requireDevMode` on `/api/loans` were removed). Phases 1–3 + 5 shipped 2026-06-10;
Phase 4 (ledger posting) deferred — see "Deferred" below.

## Model

A loan row (`loans` table, [src/db/schema-pg.ts](../src/db/schema-pg.ts)) is either:

- **Term-driven** — `term_months` set; the per-period payment is derived from
  principal/rate/term (balloon-aware when `residual_value` is set).
- **Payment-driven** — `payment_amount` set; the schedule solves for the number
  of periods and the payoff/end date. `term_months` is nullable
  (migration `20260619_loans_v2.sql`); the application layer enforces that at
  least one of (`term_months`, `payment_amount`) is present.

When both are set, **the payment wins** (the term is informational).

## Calculator (`src/lib/loan-calculator.ts`)

Pure, dependency-free (bundled into the MCP server build — keep it that way).
Single entry point:

```ts
buildLoanSchedule({
  principal, annualRate, startDate,        // required
  termMonths?, paymentAmount?,             // at least one
  paymentFrequency?, extraPayment?, residualValue?,
}): LoanSummary
```

- **Frequencies** — `PAYMENT_FREQUENCIES = weekly | biweekly | semi_monthly |
  monthly | quarterly | annual` (52/26/24/12/4/1 periods per year via
  `PERIODS_PER_YEAR`). "Bimonthly" is deliberately NOT in the enum — it is
  ambiguous (every-2-weeks vs twice-a-month vs every-2-months); biweekly +
  semi_monthly cover the two common readings. Unknown legacy strings degrade to
  monthly (`normalizeFrequency`), matching v1's fall-through.
- **Per-period rate** = `annualRate / 100 / periodsPerYear`. v1 charged the
  *monthly* rate per biweekly period — that bug is fixed; biweekly schedules
  computed before v2 differ (the feature is dev-only, no migration concern).
- **`monthlyPayment` keeps its legacy name** and means *payment per period*
  (every pre-v2 consumer reads it). Use `paymentPerPeriod` for clarity and
  `monthlyEquivalentPayment` (= payment × periodsPerYear / 12) for
  cross-frequency comparisons/sums (the UI "Monthly Payments" tile sums this).
- **Per-month interest accrual** — `summary.monthlyAccrual: {month: "YYYY-MM",
  interest}[]`. Each period's interest is day-weighted across the calendar
  months the period spans (interval `(prevPaymentDate, paymentDate]`). This is
  the *reportable* monthly figure regardless of payment frequency; it sums to
  `totalInterest` within per-entry cent rounding.
- **Lease residual** — `residualValue` amortizes the balance down to the
  residual instead of 0: term-driven payments use the balloon annuity formula
  (`calculatePeriodPayment(principal, r, n, residual)`), payment-driven
  schedules stop when the balance reaches the residual. Balance at term end ==
  residual, NOT 0.
- **Validation** — `LoanValidationError` (name `LoanValidationError`) is thrown
  for user-correctable inputs and MUST be mapped to a 4xx/refusal, never a 500:
  payment + extra ≤ first period's interest ("never amortizes"), residual ≥
  principal, principal ≤ 0, neither term nor payment, payoff > 100 years
  (runaway-loop backstop for payments barely above interest).
- **Dates** are UTC-anchored and month-stepping clamps to month-end
  (Jan 31 + 1mo = Feb 28/29). Semi-monthly alternates +15 days / next month
  anchor day.
- `generateAmortizationSchedule(principal, rate, termMonths, start, extra?,
  freq?)` survives as the term-driven back-compat wrapper (what-if + scenarios
  still use it).

## Account-linked balance

`GET /api/loans` and MCP `list_loans` read the outstanding balance from the
linked account (`loans.account_id`) when that account has ledger activity:

- `remainingBalance = |SUM(transactions.amount)|` over the linked account —
  liability accounts carry negative balances, the absolute value also covers
  users who track the loan balance as positive.
- `txCount > 0` gates the switch: an account with no transactions falls back to
  the projection (so a freshly-linked empty account doesn't zero the loan).
- `balanceSource: "account" | "projection"` tells the UI which it got (the
  loans page shows a "· from account" badge).
- When account-driven, the payoff date / periods remaining are **re-anchored**:
  a payment-driven schedule is run from today's actual balance with the loan's
  payment (falling back to projection dates if that payment no longer
  amortizes the actual balance).

`principal` stays the opening balance (NOT mutated). The "dedicated liability
account as source of truth" model from the ticket can layer on in Phase 4 when
posting starts writing transactions — nothing here blocks it.

## Surfaces

- **REST** ([src/app/api/loans/route.ts](../src/app/api/loans/route.ts)) —
  POST/PUT validate via the calculator and return the validation message as a
  400 (`LoanValidationError` mapping; PUT validates the **merged** row).
  The `amortization` action accepts `paymentAmount` + `residualValue` and
  returns `monthlyAccrual`.
- **UI** ([src/app/(app)/loans/page.tsx](<../src/app/(app)/loans/page.tsx>)) —
  Payment ("From term" placeholder) + Frequency + lease-only Residual/Buyout
  inputs; term placeholder "From payment"; server 400s surface inline in the
  dialog; schedule view has a **Monthly Interest** tab.
- **MCP HTTP** — `add_loan` / `update_loan` accept `residual_value`, the
  6-value `payment_frequency` enum, optional `term_months`; both refuse
  non-amortizing inputs with the validation message. `get_loan_amortization`
  honors stored payment/residual and returns `monthlyAccrual`.
  `get_debt_payoff_plan` excludes non-amortizing rows per-row (in `excluded`)
  instead of throwing. Same for the **stdio** read tools (stdio writes still
  refuse per Stream D Phase 4).

## Currency (2026-08-05)

A loan is denominated in `loans.currency`, resolved on create as **explicit >
linked account's currency > the user's display currency** via the shared pure
`pickRecordCurrency` ([src/lib/fx/record-currency.ts](../src/lib/fx/record-currency.ts)).
The column default is USD and exists only as a backstop.

Every read surface is **dual basis**, matching accounts and transactions:

- Amounts stay in the loan's **own** currency — that is what
  `buildLoanSchedule` computed, and what the schedule/amortization/what-if
  tables display.
- Each row also carries an **additive current-rate companion** for totalling
  across a mixed-currency book: `remainingBalanceDisplay` /
  `monthlyEquivalentPaymentDisplay` (REST `GET /api/loans`, alongside
  `displayCurrency`) and `remainingBalanceReporting` /
  `monthlyEquivalentPaymentReporting` (MCP `manage_loans(op:list)`, alongside
  `reportingCurrency`). **Only these may be summed** (FINLYNQ-123) — the
  Total Debt / Monthly Payments tiles read them and caveat "converted at
  today's rates" whenever a foreign-currency loan is present.

`get_debt_payoff_plan` **converts balances and minimum payments into
`reportingCurrency` before ranking**, on both transports. This is a
correctness fix, not a labelling one: snowball orders by balance and the single
`extra_payment` budget is pooled across every debt, so an unconverted foreign
balance could outrank every other debt purely on magnitude and absorb the whole
budget. `inputs.debts` echoes each loan's native currency and amount next to the
converted figures; `extra_payment` is interpreted in `reportingCurrency`.
Interest **rates are percentages and are never converted** — avalanche ordering
was always sound.

`manage_loans` add/update accept `currency`. On update it **re-denominates**
the loan (reinterprets the stored numbers); it does not convert them. That is
the repair path for loans created before the parameter existed — those were
stamped with the old CAD table default, and the migration deliberately does not
rewrite them, since "the user chose CAD" and "MCP never sent a currency" are
indistinguishable after the fact.

## Editing a loan (2026-08-05)

`PUT /api/loans` has existed since v2 but nothing in the app called it, so a
loan was create-or-delete only in the browser — including when its currency was
wrong. The loan card now carries an **Edit** action.

Create and edit share **one** `DialogContent` and **one** `buildPayload()`,
switched solely by an `editingLoan` state flag: add a field to the form and it
becomes editable in the same change. Keep it that way — a second dialog or a
second payload shape is how the two modes drift apart.

- The edit form seeds from the loan's **native** fields, never the converted
  `*Display` companions; seeding from those would rewrite the principal in the
  display currency on save.
- Changing the currency **re-denominates** (re-labels the stored numbers) and
  never converts, matching `manage_loans(op:update)`. An inline amber note
  appears as soon as the picker changes, and saving routes through a
  `ConfirmDialog` that spells out what will happen.
- The save handler follows the standard contract: a `saving` re-entry guard
  (`/api/loans` has no idempotency key), a `try/catch` around the request, and
  `parseSaveError` on `!res.ok` with the dialog left open and input preserved.

## How the interest is worked out (2026-10-12)

`loans.interest_method` (CHECK `loans_interest_method_check`) with
`loans.interest_amount`:

| Method | `interest_amount` | Schedule |
|---|---|---|
| `rate` (default) | unused | `annual_rate` on the balance still owed. The original behaviour; every existing loan. |
| `flat` | interest with EACH payment | Every row carries that same interest; principal is the payment less it. With a term instead of a payment, the payment is principal over the term plus the interest. |
| `total` | interest over the WHOLE loan | Level payment of (principal + total) over the periods, then the per-period rate that makes a declining-balance loan cost exactly that total is solved by bisection (`solvePeriodRate`) and applied to the balance owed. More interest early, less late. |

`flat` is how such loans are advertised ("60 payments of 587, 87 of it
interest"), not how interest accrues. It is supported because users arrive with
those numbers and their lender's statements show them, and `total` is offered
beside it as the financially standard allocation of the same money. So that the
difference is visible, every calculated schedule returns
**`effectiveAnnualRate`**: the yearly rate on the balance owed that a loan with
this payment and length carries. For `rate` it is the loan's own rate; for the
other two it is the comparable figure. The feedback loan (30,000 over 60 months,
5,220 of interest) is 3.48% a year quoted flat and about 6.5% effective. The
loan card labels it "Effective rate".

Rules:

- The method is a property of the loan row and travels through
  `loanScheduleExtras`, so it reaches every surface the same way as the
  loan's own schedule (and every raw `SELECT ... FROM loans` feeding a
  schedule must name `interest_method` and `interest_amount` too; pinned).
- An update that CHANGES the method is validated with the new one: the stored
  extras are spread first and the merged fields after (REST `PUT /api/loans`
  and MCP `manage_loans(op:"update")`; pinned).
- Interest overrides still apply on top of any method. A manual schedule still
  replaces the calculation entirely.
- No rate is suggested by the interest check unless the method is `rate`.
- An unknown or missing method reads as `rate`.

Surfaces: the loan form's **Interest** select (Yearly rate / Fixed amount each
payment / Total for the whole loan), REST `POST`/`PUT /api/loans`
(`interestMethod`, `interestAmount`), MCP `manage_loans` add/update
(`interest_method`, `interest_amount`); `list` and `get_loan_amortization`
return `interestMethod` and `effectiveAnnualRate`.

## The loan's own schedule (2026-10-12)

A schedule is calculated from the loan's terms unless the user says otherwise.
Three ways to say otherwise, all stored on the loan row:

| Column | Shape | Effect |
|---|---|---|
| `loans.interest_overrides` | `{ "YYYY-MM-DD": amount }` | Replaces the calculated interest for that payment date only. The payment is unchanged, so the principal and every later balance follow. Ignored when a manual schedule exists. |
| `loans.payment_overrides` (2026-11-09) | `{ "YYYY-MM-DD": amount }` | Replaces the WHOLE payment for that payment date (regular payment and any extra payment). The interest is still calculated from the balance owed, so principal = payment - interest, and every later row and the payoff date follow: a bigger payment shortens the loan, a smaller one or 0 (a skipped payment) adds the unpaid interest to the balance. Combines with an interest override on the same row. Ignored when a manual schedule exists. |
| `loans.manual_schedule` | `[{ date, payment, interest }]` | REPLACES the calculation. Principal (`payment - interest`, negative when a payment did not cover its interest) and the running balance are derived, never stored. |

All are nullable and NULL means calculated, so existing loans are untouched.

Edited payments exist so that a different payment no longer means switching to
a manual schedule and typing every row's interest by hand.

**One rule for readers.** `buildLoanSchedule` takes `interestOverrides`,
`paymentOverrides` and `manualSchedule` as options, and the pure `loanScheduleExtras(row)`
([loan-calculator.ts](../src/lib/loan-calculator.ts)) turns a stored loan row
(Drizzle or raw-SQL shape, JSON as object or text) into those options. **Every
caller that builds a schedule from a stored loan spreads it in**: `GET
/api/loans`, the `amortization` action (which now takes `loanId`), `PUT
/api/loans` validation, interest entries, the health score's debt service, the
MCP HTTP tools (list, update validation, post_interest, amortization, payoff
plan) and the stdio tools. A caller that forgets shows the calculated schedule
while the Loans page shows the user's, and balances then disagree. The one
deliberate exception is the re-projection from today's account balance, which
is a fresh calculation; a manual schedule skips that re-projection and keeps
its own dates. `tests/loan-manual-schedule.test.ts` pins the callers and the
raw SELECT column lists.

**One write path.** `saveLoanSchedule`
([schedule-store.ts](../src/lib/loans/schedule-store.ts), SERVER ONLY) serves
REST `GET/PUT /api/loans/schedule` and the MCP ops. It validates by BUILDING
the resulting schedule, so nothing that cannot be scheduled is stored, and it
refuses an interest or payment override for a date that is not a payment date
(it would be stored and never applied). Edited payments can move the payoff
date, so an edit left on a date after the new payoff is refused by name ("paid
off on X, so Y is no longer on its schedule"); reset it first. Setting a manual
schedule drops both kinds of override. `tests/loan-payment-overrides.test.ts`
pins the calculator and the store.

Surfaces:

- **UI** — the schedule panel's **Table** tab is now an editor
  ([_components/schedule-editor.tsx](<../src/app/(app)/loans/_components/schedule-editor.tsx>)).
  Calculated: edit or reset any row's payment (interest recalculated) or
  interest, "Reset edited payments" / "Reset edited interest", or "Switch to manual" (keeps
  the current rows as the starting point). Manual: "Edit rows" (date, payment,
  interest, add, remove), "Back to calculated". Both: **Download template** and
  **Upload schedule**.
- **CSV, fixed layout, no mapping** ([manual-schedule.ts](../src/lib/loans/manual-schedule.ts),
  pure, parsed in the browser). The template is the format: `date, payment,
  interest, principal, balance`, pre-filled with the loan's current schedule.
  Only the first three are read back; principal and balance are reference.
  The parser tolerates what a spreadsheet does on save (BOM, CRLF, quotes,
  thousands separators, currency symbols, blank lines, reordered columns) and
  reports every bad line with its number. **Dates:** ISO is taken as is. A
  spreadsheet-reformatted column (9/7/2026) is read as a whole, and a reading
  must be real dates at least 6 days apart, which is what tells day-first from
  month-first on a monthly schedule. If both readings pass, the upload is
  refused and asks for YYYY-MM-DD; it never guesses.
- **MCP HTTP** — `manage_loans(op:"set_schedule", loan_id, rows, merge?)`
  (replace, or lay rows over the current schedule by date),
  `op:"set_interest", loan_id, overrides:[{date, interest|null}]`,
  `op:"set_payment", loan_id, overrides:[{date, payment|null}]`,
  `op:"reset_schedule", loan_id` (drops the manual schedule and both kinds of
  override).
- **REST** — `PUT /api/loans/schedule` takes `paymentOverrides` (date -> amount,
  `null` removes one) and `clearPaymentOverrides`; `GET` returns
  `paymentOverrides`. Schedule rows carry `paymentOverridden: true`, and
  `GET /api/loans` adds `paymentOverrideCount`.
- **Mobile** — not yet: the phone's schedule screen still edits interest only.

The rate suggestion on the Interest entries tab is not offered for a manual
schedule, since its interest is not derived from the rate.

Known limit: a manual schedule built from a calculated one can end a few cents
away from zero, because the rows carry amounts to the cent while the
calculation keeps fractions of a cent.

## Interest entries (2026-10-12)

How a payment with an interest component is recorded:

- **The payment is a plain transfer** from the paying account into the loan's
  linked account. It is never split.
- **The interest is a separate expense transaction on the loan account**
  (negative amount, an expense category). It adds to what is owed; the payment
  then takes the full amount off, so the balance falls by the principal only,
  and the interest shows in the income statement.

**"Booked" is read from the ledger, not tracked separately.** Every transaction
on the linked account in the loan's interest category
(`loans.interest_category_id`) counts, whether it was typed in by hand,
recorded by an assistant with `manage_transactions`, or generated from the
schedule. Transfer legs are excluded (`link_id IS NULL`), so a payment
mis-filed under the interest category is not read as negative interest. The
pure `matchInterestToSchedule` ([interest-plan.ts](../src/lib/loans/interest-plan.ts))
credits each transaction to the schedule period whose payment date is
**nearest** (a tie goes to the earlier period), sums several in one period,
nets refunds, and returns anything more than one payment interval outside the
schedule's date range as `unmatched`. The web panel, the server and the MCP
tool all call that one function, so they cannot disagree about which periods
are booked.

Surfaces:

- **UI** — the schedule panel's **Interest entries** tab
  ([_components/interest-entries.tsx](<../src/app/(app)/loans/_components/interest-entries.tsx>)):
  every payment date that has come due (plus the next upcoming one) with the
  calculated interest beside what is booked, the difference when they disagree,
  an editable amount and a Generate button for unbooked periods, and a
  "Generate N due entries" button. Picking a category saves it on the loan.
- **REST** `/api/loans/interest` (`apiHandler`, enveloped) — `GET ?loanId=[&categoryId=]`
  returns the ledger entries (`categoryId` previews another category without
  saving), `PUT { loanId, categoryId }` saves the category,
  `POST { loanId, categoryId, entries: [{ periodDate, amount, date? }] }` generates.
- **MCP HTTP** — `manage_loans(op:"post_interest", loan_id, period_date?, amount?,
  category_id? | category?, date?)`. With no `period_date` it takes the oldest
  due period with nothing booked; with no `amount` it uses the schedule's
  figure; with no category it uses the loan's saved one, else the single
  expense category with "interest" in its name, and refuses if there are none
  or several.

Generation rules live in `postLoanInterest`
([src/lib/loans/interest-entries.ts](../src/lib/loans/interest-entries.ts)),
the one chokepoint both surfaces call. It refuses, before writing anything: a
loan with no linked account, an investment account, a `periodDate` that is not
on the loan's current schedule, and a period the ledger already holds interest
for (checked under the requested category AND the loan's saved one, so
switching category cannot double-charge a period). Inside one
`withDbTransaction` it locks the loan row (`FOR UPDATE`), checks the ledger
again (two racing requests both pass the first check), creates the
transactions through `createTransaction`, and saves the category on the loan.
Reporting amounts are resolved before the transaction opens, because the FX
lookup can reach the network.

Known limits:

- Interest cannot be the FIRST entry on an empty linked account. A linked
  account with no entries leaves the loan on its projected balance; with one
  entry its balance becomes the loan's, so `postLoanInterest` refuses and asks
  for the account's opening balance first.
- Nothing posts automatically on the due date; generation is one click.

### Booked versus calculated (2026-10-12)

The Interest entries tab compares what the lender charged with what the
schedule calculates and says whether the loan's rate looks wrong. The pure
`assessBookedInterest` ([interest-plan.ts](../src/lib/loans/interest-plan.ts))
returns one of: `insufficient` (fewer than two recent booked payments, nothing
is shown), `in_line`, `over`, `under` (charged more or less by a steady
factor), or `inconsistent` (it differs, but not by a steady factor).

The owner's rules, which the function and the panel both honour:

- **Judge on recent payments only.** At most the `ASSESSMENT_MAX_PERIODS` (3)
  most recent booked payments, never older than `ASSESSMENT_LOOKBACK_DAYS`
  (365), and never one that has not come due. An extra payment or a change to
  the loan's terms shifts every later period, so an older payment can
  legitimately differ from today's schedule and must not drive the verdict.
- **Say so where it is shown.** The panel names the window (count and dates)
  and states why older payments are left out.
- **A suggestion is accepted, never applied silently.** `suggestedRate` is
  offered only when the factor is steady (each payment within 5% of the
  median): if the lender charged k times the calculated figure, the rate that
  explains it is k times the loan's. "Use N%" goes through a confirm dialog
  and `PUT /api/loans`, then the schedule is rebuilt. Booked entries are never
  touched.

Within 2% (or a cent per payment) is treated as rounding and reads as in line.
`fixedAmount` is set when every payment in the window was charged the same
figure while the schedule's figures differ, which points at a fixed charge
rather than a rate.

Where the verdict is shown, each time with its window:

- **Loans page** — the Interest entries tab (the callout above the table).
- **Dashboard Action Center** — `getLoanInterestMismatches` in
  [spotlight.ts](../src/lib/spotlight.ts) raises a card for `over` (warning),
  `under` and `inconsistent` (info); `in_line` and `insufficient` raise
  nothing. Amounts are converted to the display currency. The card links to
  `/loans?loan=<id>&tab=entries`, which opens that loan's panel on the Interest
  entries tab.
- **MCP** — `get_loan_amortization` returns `interestCheck` (the verdict plus
  `window`) and `scheduleMode`; `finlynq_help(topic:"loans")` tells an
  assistant how payments, interest and schedules are recorded and to relay the
  window with any verdict. The dashboard card also reaches `get_spotlight_items`.

The read side lives in [interest-check.ts](../src/lib/loans/interest-check.ts),
apart from the transaction-writing `interest-entries.ts`, so the Action Center
does not pull the writer onto the dashboard's hot path. Only loans with a
linked account AND an interest category are read at all.

## Deferred (Phase 4 — tracked on FINLYNQ-136)

- Interest posting shipped 2026-10-12 as one-click entries (see "Interest
  entries" above). Still deferred: auto-generate (recurring-style) vs
  import-and-reconcile modes, FI-sync duplicate matching, balance
  reconciliation surface (warn-but-allow), and the posting-trigger /
  categorization decisions that come with it.
- Variable / floating rates (schema designed so a rate-schedule table can slot
  in additively — do NOT widen `annual_rate` semantics).
