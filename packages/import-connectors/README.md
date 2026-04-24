# @finlynq/import-connectors

Pluggable connectors for importing transactions from third-party personal-finance
services into Finlynq. Designed so migrating from Mint, YNAB, Lunch Money, or any
future provider is a copy-paste of the WealthPosition directory with a new client.

Currently ships:

- **WealthPosition** — [docs](https://www.wealthposition.com/api/v0.1)

## Package layout

```
src/
  types.ts                 — Connector<Credentials> interface + shared shapes
  rate-limited-fetch.ts    — async queue, minIntervalMs knob
  wealthposition/
    client.ts              — typed fetches for /accounts, /categories,
                             /transactions, /account_balances
    transform.ts           — pure: ExternalTransaction[] → RawTransaction[] flat,
                             splits, transfers, errors
    index.ts               — metadata + createClient + transform export
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
   `getBalances(date)` for post-import reconciliation. Rate limiting lives
   inside the client — the orchestrator just awaits.
3. `transform()` is a pure function. It receives resolved Finlynq-side maps
   (external-id → Finlynq numeric id) and returns:
   - `flat` — single-row transactions ready for Finlynq's `executeImport()`.
   - `splits` — parent row + N split rows (written to `transaction_splits`
     after the parent is inserted).
   - `errors` — per-external-id reasons for anything unmapped.

See `src/wealthposition/transform.ts` for a reference implementation; the
test file alongside it doubles as documentation for how every shape class
should be handled.

## Rules we learned the hard way

- **`importHash` must be computed on plaintext payee.** Finlynq's AES-GCM
  envelope uses a random IV per row, so ciphertext dedup doesn't work. All
  transforms here emit plaintext payees; encryption happens later in
  `executeImport`.
- **Rate limiting is the connector's problem, not the caller's.** A single
  user-initiated sync may fan out to hundreds of pages, and failing halfway
  through with a 429 is much worse than adding a sleep. Wrap `fetch` with
  `createRateLimitedFetch()`.
- **Account-side vs category-side detection** is by name lookup against
  both lists — external services rarely tag which is which on the entry
  itself. Keep the lookup maps inside the transform so the orchestrator's
  database access doesn't leak in.
- **Splits are identified by shape, not a flag.** WealthPosition calls
  everything with ≥ 2 entries a "split transaction" but the common case is
  2 entries (1 account + 1 category) which we flatten. True splits have
  1 account + 2+ categories. Don't rely on a `SPLIT` tag — we verified
  against 5,403 real transactions and no such tag exists.

## Testing

Unit tests run under the main Finlynq repo's vitest config — they're
included via the `packages/**/*.test.ts` glob. No separate test runner
needed in dev. Once published, the package ships its own vitest dep.

```sh
npx vitest run packages/import-connectors/
```

## License

AGPL-3.0-only, same as the rest of Finlynq.
