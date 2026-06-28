# Import connectors — architecture & contribution guide

How Finlynq imports a user's history from another personal-finance app. The
pure, provider-specific parsing lives in the **`@finlynq/import-connectors`**
workspace package; everything that touches the database (account/category
resolution, the import pipeline, the UI) lives in the app.

> Package-local README: [packages/import-connectors/README.md](../packages/import-connectors/README.md).
> Referenced from CLAUDE.md "External import connectors".

## The four layers

A connector is the same shape regardless of provider — only the parse step differs.

```
  file / API  →  PURE TRANSFORM (package)  →  ORCHESTRATOR (app)  →  PIPELINE  →  UI
                 RawTransaction[]              resolve/create        previewImport
                 (+ errors)                    accounts+categories   executeImport
```

1. **Pure transform** — `@finlynq/import-connectors`, zero-dep, no `@/…` imports,
   `npm publish`-safe. Turns provider bytes into `RawTransaction[]` (+ per-row
   errors). Never writes to the DB. Tests alongside double as the spec.
2. **Orchestrator** — `src/lib/external-import/*`. Owns side effects: resolve or
   create the Finlynq accounts/categories the rows reference (encrypted names via
   `buildNameFields`), then hand `RawTransaction[]` to the pipeline.
3. **Pipeline** — `src/lib/import-pipeline.ts` `previewImport` / `executeImport`.
   Matches accounts/categories **by name** (it does NOT auto-create them — that's
   the orchestrator's job), dedups on `import_hash` / `fitId`, converts entered→
   account currency, writes the bank-ledger row + lineage, and runs lot hooks.
   Pass `txSource: 'connector'` so connector lineage stays distinct from uploads.
4. **UI** — Settings → Import → **"Migrate from another app"** tab: a
   per-source submenu. Each provider is a tab component (`ConnectorTab`,
   `MoneyProConnectorTab`) that drives `POST /api/import/connectors/<provider>/…`.
   Deep-link: `/settings/import?tab=migrate[&provider=moneypro|wealthposition|generic-csv]`
   (legacy `tab=connect` still accepted).

## Connectors that ship

| Provider | Input | Parse entry point | Notes |
|---|---|---|---|
| **WealthPosition** | ZIP export (4 CSVs) | `transformWealthPositionExport` | + live-API client for balance reconcile only. Splits via `#SPLIT#` groups. |
| **IBKR** | Activity Statement XML / CSV | `ibkr` (`parse-xml`/`parse-csv`/`transform`) | XML preferred (deterministic). |
| **Money Pro** | Transactions report CSV | `parseMoneyProCsv` / `moneyProRowsToRawTransactions` | See below — sign comes from a column, not the amount. |
| **Generic CSV (full ledger)** | Any multi-account CSV | `parseGenericCsv` / `genericCsvRowsToRawTransactions` | See below — **mapping-driven** (not header-locked); for whole-portfolio exports the per-account `/import` mapper can't take. |

## Money Pro (iBear) — the non-1:1 case

Money Pro's CSV (12 columns: `Date, Amount, Account, Amount received, Account (to),
Balance, Category, Description, Transaction Type, Agent, Check #, Class`) does not
fit a generic column-mapping, which is why it's a dedicated transform:

- **Amount is an unsigned magnitude** (e.g. `HK$2,131.64`). The **direction is in
  `Transaction Type`**: `Expense` → −, `Income` → +, `Money Transfer` → two
  `linkId`-paired legs (source `Amount`/`Account` − , dest `Amount received`/
  `Account (to)` +), `Opening Balance` → one tx whose amount is the **Balance**
  column (Amount is 0 on those rows). **Unknown types are returned as errors, not
  sign-guessed** — extend `TYPE_DIRECTION` in `transform.ts` as new types surface.
- **No currency column** — currency is the amount symbol (`HK$`→HKD); falls back to
  `opts.defaultCurrency`. `CURRENCY_SYMBOLS` lists the most-specific symbols first.
- **Day-first dates with a time** — `27/10/2025, 15:04` → `2025-10-27`.
- `Class` → tags; hierarchical `Category` (`Entertainment: Travel`) passed through;
  account names have wrapping parens stripped.
- **Detection:** `isMoneyProCsv(headers)` keys on the `Transaction Type` +
  `Amount received` + `Account (to)` trio (no other supported app emits all three).
- Optional `opts.decimalComma` for European `1.234,56` exports.

Orchestrator [`moneypro-orchestrator.ts`](../src/lib/external-import/moneypro-orchestrator.ts):
`summarizeMoneyProCsv` (read-only preview — account plan + categories + counts) and
`executeMoneyProImport` (resolve/create accounts per the user's per-account choice
[existing | create A/L], create categories incl. the `Transfer` bucket, rewrite each
row onto its Finlynq account name, then `executeImport`). Routes:
`POST /api/import/connectors/moneypro/{preview,execute}`. UI: `MoneyProConnectorTab`.

**Deferred:** Balance → reconciliation anchors; the full `Transaction Type`
vocabulary; MCP/mobile parity; the `.numbers` format (export as CSV instead —
Money Pro produces CSV natively; `.numbers` is Apple Numbers' proprietary binary).

## Generic CSV (full ledger) — the mapping-driven, format-tolerant case

A **multi-account** export (one CSV carrying many accounts, transfers, and
currencies) is the shape the per-account `/import` column mapper can't take — it
is single-account-scoped, has no transfer concept, and assumes the account's
currency. The connector framework is the right home, but unlike Money Pro this
connector is **intentionally NOT keyed on exact header names** (a strict clone
breaks the moment a column is renamed/reordered). Instead it is **mapping-driven**:

- **Tolerant detection** — `suggestGenericCsvMapping(headers)` derives a best-guess
  `GenericCsvMapping` (logical field → header) via case-insensitive **alias**
  matching (`note`/`memo`/`description`/`payee`; `account_to`/`destination`/`to`;
  …), order-independent, unknown columns ignored. `isGenericCsv(headers)` is true
  when the required trio (`date`, `amount`, `account`) auto-maps. A file that
  doesn't fully auto-map isn't rejected — the preview returns `mappingComplete:
  false` and the UI lets the user re-point columns.
- **Signed amount** (negative = outflow), so no Type column. `currency` is a per-row
  ISO column (falls back to the amount symbol, then `opts.defaultCurrency`); HKD +
  CNY can coexist in one file / one account.
- **`account_to` present → single-row transfer** → two `linkId`-paired legs (outflow
  on `account`, inflow on `account_to`). A **same-currency** transfer mirrors the
  source magnitude onto the inflow leg in the row currency. A **cross-currency (FX)
  transfer** that also supplies **`amount_received` + `currency_to`** (mapped to
  `amountTo`/`currencyTo`) records the inflow leg FAITHFULLY in its own currency
  (e.g. `-5000 HKD` out, `+502.18 GBP` in) — each leg then matches its own account's
  currency, so the import pipeline stores it natively (or via locked-at-entry FX if
  the chosen account currency differs). The orchestrator's `refuseCrossCurrencyTransfers`
  now refuses only the AMBIGUOUS case: a same-currency-row transfer (no received
  amount) whose two legs resolve to accounts of different **modal** currency — it's
  dropped + reported as a skipped row with a hint to add the received-amount columns.
  Transfers whose legs carry different currencies (explicit FX) are kept.
- **`(OPENING BALANCE)` category → an `Opening Balance` tx** (gated by
  `opts.includeOpeningBalance`); **`(AUDIT)` → `Adjustment`** (markers configurable
  via `opts.openingBalanceMarkers` / `auditMarkers`).
- **Flexible dates** — `parseFlexibleDate` accepts ISO `YYYY-MM-DD` and slash/dot/
  dash `D/M/Y` (or `M/D/Y` via `opts.dateOrder`), optional trailing time;
  self-disambiguates when a component is clearly the day. `opts.decimalComma` for
  European amounts.

Orchestrator [`generic-csv-orchestrator.ts`](../src/lib/external-import/generic-csv-orchestrator.ts):
`summarizeGenericCsv(csv, mapping, …)` (read-only preview — modal-currency account
plans + categories + transfer count + skipped-row errors) and
`executeGenericCsvImport(csv, mapping, …)` (resolve/create accounts per the user's
per-account choice, create categories incl. the `Transfer` bucket, rewrite each row
onto its Finlynq account name, then `executeImport`). Account currency is the
account's **modal** currency across its rows (so a mostly-CNY account with a few HKD
rows is created CNY, the off-currency rows stored via `entered_currency` + FX).
Routes: `POST /api/import/connectors/generic-csv/{preview,execute}` — `preview`
takes an OPTIONAL `mapping` (suggests one when absent) and always returns
`{ headers, sampleRows, mapping, missingRequired, mappingComplete, summary }`;
`execute` requires the (date/amount/account-complete) `mapping`. UI:
`GenericCsvConnectorTab` (a Match-columns step — incl. the optional `amount received`
/ `currency received` FX-transfer columns — + sample preview + account mapping),
under the **"Migrate from another app"** tab. Deep-link:
`/settings/import?tab=migrate&provider=generic-csv` (legacy `tab=connect` still
accepted).

**Deferred:** using a per-row id column as `fitId` for idempotent re-import;
MCP/mobile parity.

## Load-bearing rules (learned the hard way)

- **`import_hash` is over the plaintext payee.** AES-GCM uses a random IV per row,
  so ciphertext dedup can't work. Transforms emit plaintext; `executeImport`
  encrypts at the boundary.
- **The pipeline matches by name and does NOT create accounts/categories.** The
  orchestrator must ensure every `RawTransaction.account` already exists as a
  Finlynq account name (and create encrypted-name rows for anything new) BEFORE
  calling `previewImport`/`executeImport`, or the rows error as "Unknown account".
- **Rebuild stale mappings every preview/execute** — a saved
  `external-id → Finlynq-id` can point at a reclaimed id (the PG sequence advances
  on rolled-back inserts). Only carry over entries whose target still exists.
- **Transactions store the holding NAME, not the ticker** (`portfolio_holding`).
- **The portfolio aggregator classifies by `qty` direction** (`qty>0` = buy
  regardless of amount sign). Let the aggregator tolerate both sign conventions;
  don't sign-flip in the transform.
- **Surface `transformErrors` / row errors in the preview** so "0 rows imported"
  shows the real reason, not a generic "No data to import".

## Adding a new provider — checklist

1. New dir `packages/import-connectors/src/<provider>/` with a **pure** transform
   `→ RawTransaction[]` (+ errors) and co-located `*.test.ts` (use a real export
   fixture). Export a `is<Provider>…(headers)`-style detector. Re-export via the
   package `index.ts` (`export * as <provider>`) + add the `./<provider>` subpath
   in `package.json` `exports`.
2. Orchestrator `src/lib/external-import/<provider>-orchestrator.ts`: resolve-or-
   create accounts/categories (encrypted names via `buildNameFields`), then
   `executeImport(rows, [], userId, dek, 'connector', …)`.
3. Routes `src/app/api/import/connectors/<provider>/{preview,execute}/route.ts`
   (gate with `requireEncryption`; multipart `file` upload).
4. UI tab `src/app/(app)/import/components/<provider>-connector-tab.tsx` and add it
   to the provider submenu in `src/app/(app)/settings/import/page.tsx`.
5. Run `npx vitest run packages/import-connectors/`, `npx tsc --noEmit`,
   `npm run lint`, `npm run audit:invariants`. Update this doc + CLAUDE.md.
