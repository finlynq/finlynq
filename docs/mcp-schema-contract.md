# Finlynq MCP schema and currency contract

This document is the source-of-truth example for the HTTP MCP surface. Examples
must match the runtime Zod schemas and the validation performed by the handler.

## Loans

Use `manage_loans` with `op: "add"` (or the compatibility alias `add_loan`).
The required fields are:

```json
{
  "op": "add",
  "name": "Demo mortgage",
  "type": "mortgage",
  "principal": 18000,
  "annual_rate": 6.99,
  "term_months": 48,
  "start_date": "2025-08-01"
}
```

Field names are exact:

- `annual_rate` is the accepted name; `interest_rate` is not accepted.
- `start_date` is required and must be `YYYY-MM-DD`.
- `principal` must be greater than zero.
- The loan must provide either `term_months` or `payment_amount`; the
  amortization validator also rejects non-amortizing combinations.
- `payment_frequency` defaults to `monthly`.
- `extra_payment` defaults to `0`.
- `residual_value` is for leases and must be below principal.
- `account_id` is preferred for an exact account link; `account` is the
  name/alias resolver alternative and refuses unmatched or ambiguous names.

`manage_loans` update validates the merged existing row, so changing only a
payment or rate cannot create a non-amortizing loan.

## Display/reporting currency

The single user-facing currency is stored in the per-user setting:

```text
settings.key = "display_currency"
```

The HTTP API operation to change it is:

```text
PUT /api/settings/display-currency
{"displayCurrency":"CHF"}
```

There is currently **no MCP operation** that changes this setting. Configure it
through the web/API endpoint, then MCP reporting tools read it automatically.
An explicit `reportingCurrency` argument still overrides the saved setting for
one call. When the setting is absent or unreadable, the documented final
fallback is `CAD`.

## Subscriptions

`manage_subscriptions(op: "add")` accepts an optional `currency`.

- Explicit `currency` always wins.
- When omitted, the subscription inherits `settings.display_currency`.
- It does not inherit an account currency; a subscription may have no linked
  account and the display setting is deterministic for both cases.
- If `display_currency` is configured as `CHF`, an omitted currency is stored as
  `CHF`; it is not silently stored as `CAD`.
- If no display currency is configured, the final fallback is `CAD`.
- Bulk subscription creation follows the same rule and resolves the default
  once for the operation.

Budget and report totals use the resolved reporting currency: explicit
`reportingCurrency`, otherwise `settings.display_currency`, otherwise `CAD`.

## Safety

Examples contain synthetic values only. Never put credentials, tokens,
user identifiers, ciphertext, database URLs, or live financial data in MCP
help, schemas, tests, issues, commits, or pull requests.
