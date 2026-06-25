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
4. **UI** — Settings → Import → **"Import from another provider"** tab: a
   per-source submenu. Each provider is a tab component (`ConnectorTab`,
   `MoneyProConnectorTab`) that drives `POST /api/import/connectors/<provider>/…`.
   Deep-link: `/settings/import?tab=connect[&provider=moneypro|wealthposition]`.

## Connectors that ship

| Provider | Input | Parse entry point | Notes |
|---|---|---|---|
| **WealthPosition** | ZIP export (4 CSVs) | `transformWealthPositionExport` | + live-API client for balance reconcile only. Splits via `#SPLIT#` groups. |
| **IBKR** | Activity Statement XML / CSV | `ibkr` (`parse-xml`/`parse-csv`/`transform`) | XML preferred (deterministic). |
| **Money Pro** | Transactions report CSV | `parseMoneyProCsv` / `moneyProRowsToRawTransactions` | See below — sign comes from a column, not the amount. |

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
