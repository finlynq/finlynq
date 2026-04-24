# @finlynq/import-connectors

Pluggable connectors for importing transactions from third-party personal-finance
services into Finlynq. Designed so migrating from Mint, YNAB, Lunch Money, or any
future provider is a copy-paste of an existing directory with a new client.

Currently ships:

- **WealthPosition** — [docs](https://www.wealthposition.com/api/v0.1). Supports
  both a live API client (`WealthPositionClient`) and a ZIP-export parser
  (`parseWealthPositionExport` + `transformWealthPositionExport`). Finlynq
  uses the ZIP path as primary and the API path for balance reconciliation
  only.

## Package layout

```
src/
  types.ts                       — Connector<Credentials>, RawTransaction,
                                   ConnectorMappingResolved, TransformResult
  rate-limited-fetch.ts          — per-bucket async queue on globalThis so
                                   state survives across HTTP requests
  wealthposition/
    client.ts                    — WealthPositionClient — typed fetches with
                                   1 req/s throttle + retry on RATE_LIMIT_ERROR
    csv.ts                       — RFC-4180 CSV parser (quoted fields, escaped
                                   quotes) + header-indexed dict form
    zip-parser.ts                — parseWealthPositionExport() reads the 4
                                   CSVs; transformWealthPositionExport() walks
                                   rows (ordered #SPLIT# groups) and emits
                                   RawTransaction + TransformSplitTx
    transform.ts                 — API-path transform (separate code path for
                                   live-API ingestion; deprecated vs. ZIP)
    transform.test.ts
    zip-parser.test.ts
    index.ts
  index.ts
```

## Contract for a new connector

Every connector exports an object conforming to `Connector<Credentials>`:

```ts
interface Connector<Credentials> {
  metadata: ConnectorMetadata;
  createClient(creds: Credentials): ConnectorClient;
  transform(
    externalTxs: ExternalTransaction[],
    mapping: ConnectorMappingResolved,
  ): TransformResult;
}
```

1. `ConnectorMetadata` describes the service (id, display name, credential
   fields, rate limit). Finlynq's UI renders a credentials form from this.
2. `ConnectorClient` exposes `listAccounts()`, `listCategories()`,
   `listTransactions()` (async-iterable pages), and optionally
   `getBalances(date)` for reconciliation. Rate limiting lives inside the
   client — the orchestrator just awaits.
3. `transform()` is a pure function. It receives resolved Finlynq-side maps
   (external-id → Finlynq numeric id) and returns:
   - `flat` — single-row transactions ready for Finlynq's `executeImport()`.
   - `splits` — parent row + N split rows (written to `transaction_splits`
     after the parent is inserted).
   - `errors` — per-external-id reasons for anything unmapped.

See `src/wealthposition/zip-parser.ts` for the reference implementation.
Tests alongside double as spec documentation for the expected behavior per
transaction shape.

## Rules we learned the hard way

- **`importHash` must be computed on plaintext payee.** Finlynq's AES-GCM
  envelope uses a random IV per row, so ciphertext dedup doesn't work. All
  transforms here emit plaintext payees; encryption happens later in
  `executeImport`.

- **Transactions store the holding NAME, not the ticker symbol**, in
  `portfolio_holding`. Finlynq's portfolio overview joins by
  `portfolio_holdings.name`. Symbol lives on `portfolio_holdings.symbol` for
  the price service. Writing the symbol on the transaction quietly makes
  every holding display `Qty: --` because the join misses.

- **Route position legs to their OWN brokerage, not the parent's cash account.**
  In a "cash → position" group the parent tells you which cash account
  funded the buy, but the shares belong to the brokerage named in
  `Portfolio.csv`. Emit both: the parent tx on the cash account (for
  reconciliation) + each position tx on its brokerage (for portfolio
  aggregation).

- **The portfolio aggregator classifies by quantity direction.** A buy is
  `qty > 0` regardless of amount sign; a sell is `qty < 0`. WP's position-
  side records show `amt > 0 + qty > 0` (position balance grew), while
  Finlynq's native data shows `amt < 0 + qty > 0` (cash out, shares in).
  Both need to count. Don't paper over this with sign-flipping in the
  transform — let the aggregator tolerate both.

- **Rate limiting is the connector's problem, not the caller's.** A single
  user-initiated sync may fan out to hundreds of pages, and failing halfway
  through with a 429 is much worse than adding a sleep. Wrap `fetch` with
  `createRateLimitedFetch({ bucketKey })` — same key across client
  instances keeps the queue shared on `globalThis` so consecutive HTTP
  requests don't stampede.

- **Account-side vs category-side detection** is by name lookup against
  both lists — external services rarely tag which is which on the entry
  itself. Keep the lookup maps inside the transform so the orchestrator's
  database access doesn't leak in.

- **Splits are identified by structural shape, not a flag.** WealthPosition
  calls everything with ≥2 entries a "split transaction," but the common
  case is 2 entries (1 account + 1 category) which we flatten. True splits
  have 1 account + 2+ categories and go through `transaction_splits`. Don't
  rely on a `SPLIT` tag in the API data — we verified against 5,403 real
  transactions and no such tag exists. The CSV export does use a `#SPLIT#`
  sentinel to preserve multi-leg groups across rows.

- **Group `#SPLIT#` children by CSV order, not by (date, note).** Parent
  rows carry the transaction's note; child rows have empty notes. Grouping
  by (date, note) orphans every child. Walk the rows sequentially and
  buffer a parent until the next real-account row.

- **Stale saved mappings bite when accounts are deleted outside the import
  flow.** The PostgreSQL sequence advances even when an INSERT is rolled
  back, so a stale `accountMap.csv:acct:X = 100` can point at an id that
  was reclaimed. Every `preview` / `execute` rebuilds the mapping from
  scratch and only carries over entries whose referenced Finlynq account /
  category still exists. Do the same if you clone this pattern.

- **Surface `transformErrors` in the preview dialog.** If the transform
  emits zero rows because every account is unmapped, the pipeline's
  default "No data to import" error tells the user nothing actionable.
  Merge `transformErrors` into the preview dialog's `errorRows` (first N
  with a summary line for the rest) so the real failure is visible.

## Testing

Unit tests run under the main Finlynq repo's vitest config — they're
included via the `packages/**/*.test.ts` glob. No separate test runner
needed in dev. Once published, the package ships its own vitest dep.

```sh
npx vitest run packages/import-connectors/
```

## License

AGPL-3.0-only, same as the rest of Finlynq.
