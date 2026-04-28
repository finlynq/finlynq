# Import Connectors — Architecture & Contribution Guide

**Status:** Production. First connector (WealthPosition) ships on 2026-04-24.
**Audience:** Anyone adding support for a new external service (Mint, YNAB,
Lunch Money, Monarch, QuickBooks, …) or maintaining the existing ones.

---

## 1. Why a dedicated connector layer?

Finlynq already imports CSV, Excel, PDF, OFX, and email-forwarded files
via [src/lib/import-pipeline.ts](../src/lib/import-pipeline.ts). Those are
_file formats_. Connectors are _services_ — named providers with their
own data model, API, and export conventions. Separating them keeps the
generic file path simple and lets each provider own its quirks.

**Guiding principles:**

1. **Prefer the service's export file over its live API** when both are
   available. A one-shot upload is faster, doesn't burn rate limit, and
   usually carries richer data (e.g., `Portfolio.csv` holding→brokerage
   mappings that the API doesn't expose).
2. **Keep the API for what the export can't do** — typically reconciliation,
   live balances, or ongoing sync.
3. **One connector = one directory** under `packages/import-connectors/src/<provider>/`
   + one orchestrator under `src/lib/external-import/` + one route tree
   under `src/app/api/import/connectors/<provider>/`. Adding a provider
   should not require changes anywhere else in the tree.
4. **Transform functions stay pure** (no DB, no encryption, no Finlynq
   imports). They take external data + a resolved mapping, return
   `RawTransaction[]` + split parents + errors.
5. **Orchestrators own side effects** — credential load/save, auto-create
   mapping materialization, DB writes, reconciliation.

---

## 2. File layout

```
pf-app/
├── packages/import-connectors/           — npm workspace, private, no Finlynq deps
│   ├── package.json
│   ├── tsconfig.json
│   ├── README.md                         — package overview + lessons
│   └── src/
│       ├── index.ts                      — barrel; re-exports types + every provider
│       ├── types.ts                      — Connector<Credentials>, RawTransaction,
│       │                                   ConnectorClient, ConnectorMappingResolved,
│       │                                   TransformResult, TransformSplitTx
│       ├── rate-limited-fetch.ts         — per-bucket queue on globalThis
│       └── <provider>/
│           ├── index.ts                  — exports metadata + createClient + transform
│           ├── client.ts                 — typed HTTP client (if the provider has an API)
│           ├── csv.ts                    — if the provider has a CSV/ZIP export
│           ├── zip-parser.ts             — if the provider has a ZIP export
│           ├── transform.ts              — API-path transform (if applicable)
│           ├── transform.test.ts
│           └── zip-parser.test.ts        — if the provider has a ZIP export
├── src/lib/external-import/              — Finlynq-side glue (DB, encryption, routes)
│   ├── credentials.ts                    — AES-GCM-encrypted per-user credentials
│   ├── mapping.ts                        — ConnectorMapping persistence in settings
│   ├── orchestrator.ts                   — API-path preview/execute (WealthPosition)
│   ├── zip-orchestrator.ts               — ZIP-path preview/execute (WealthPosition)
│   └── reconciliation.ts                 — WP-specific reconciliation (portable pattern)
├── src/app/api/import/connectors/
│   └── <provider>/
│       ├── credentials/route.ts          — POST / DELETE / GET
│       ├── probe/route.ts                — fetches live-service shapes if API exists
│       ├── preview/route.ts              — API-path preview
│       ├── execute/route.ts              — API-path execute
│       ├── reconcile/route.ts            — balance reconciliation (if API available)
│       ├── zip-probe/route.ts            — if ZIP export
│       ├── zip-preview/route.ts          — if ZIP export
│       └── zip-execute/route.ts          — if ZIP export
└── src/app/(app)/import/components/
    ├── connector-tab.tsx                 — generic UI shell, one section per connector
    ├── connector-mapping-dialog.tsx      — shared mapping dialog
    └── connector-reconciliation-dialog.tsx — shared reconciliation dialog
```

**Naming conventions:**
- Settings keys: `connector:<connectorId>:credentials`, `connector:<connectorId>:mapping`.
- Synthetic external ids (CSV-flow): `csv:acct:<name>`, `csv:cat:<name>`.
- Confirmation-token operations: `<connectorId>_sync` (API path),
  `<connectorId>_zip_sync` (ZIP path).

---

## 3. The `Connector<Credentials>` contract

Every provider exports a default object implementing:

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

See [packages/import-connectors/src/types.ts](../packages/import-connectors/src/types.ts) for full definitions.

**`ConnectorMetadata`** — displayed by the UI, no runtime side effects:

```ts
{
  id: "wealthposition",
  displayName: "WealthPosition",
  homepage: "https://www.wealthposition.com",
  credentialFields: [{ key: "apiKey", label: "API key", type: "password" }],
  rateLimit: { requestsPerSecond: 1 },
}
```

**`ConnectorClient`** — async-iterable paging, optional balances:

```ts
interface ConnectorClient {
  listAccounts(): Promise<ExternalAccount[]>;
  listCategories(): Promise<ExternalCategory[]>;
  listTransactions(opts?: { startDate?: string; endDate?: string }): AsyncIterable<ExternalTransaction[]>;
  getBalances?(date: string): Promise<Record<string, number>>;  // for reconciliation
}
```

**`transform`** — pure; takes already-mapped external data, returns:

```ts
interface TransformResult {
  flat: RawTransaction[];                         // → executeImport
  splits: TransformSplitTx[];                     // → transaction_splits post-insert
  errors: Array<{ externalId: string; reason: string }>;  // → preview dialog
}
```

---

## 4. Adding a new connector (checklist)

Assume you're adding `Mint`.

### 4.1 Scaffold the package directory

```
packages/import-connectors/src/mint/
├── index.ts          — export metadata, createClient, transform
├── client.ts         — API client if applicable
├── zip-parser.ts     — if Mint has a CSV/ZIP export (it does)
├── csv.ts            — reuse ../wealthposition/csv.ts or copy if distinct
├── transform.ts      — for the API path
├── transform.test.ts
└── zip-parser.test.ts
```

Then expose from `packages/import-connectors/src/index.ts`:

```ts
export * as mint from "./mint";
```

### 4.2 Glue module

Add `src/lib/external-import/mint-orchestrator.ts` (ZIP path) and/or
extend `orchestrator.ts`. Mirror the WealthPosition functions:

```ts
export async function runMintPreview(userId, dek, input);
export async function runMintExecute(userId, dek, input, token);
```

The glue is where you:
1. Load credentials via `loadConnectorCredentials(userId, "mint", dek)`.
2. Materialize mapping (auto-create missing Finlynq accounts/categories).
3. Call the pure transform.
4. Run `previewImport` / `executeImport`.
5. Insert splits + portfolio holdings post-import.
6. Sign/verify confirmation token via [src/lib/mcp/confirmation-token.ts](../src/lib/mcp/confirmation-token.ts).
7. Auto-run reconciliation if creds exist (optional).

### 4.3 Routes

```
src/app/api/import/connectors/mint/
├── credentials/route.ts   (usually copy from wealthposition/credentials/route.ts)
├── probe/route.ts          or zip-probe/route.ts
├── preview/route.ts        or zip-preview/route.ts
├── execute/route.ts        or zip-execute/route.ts
└── reconcile/route.ts      (if applicable)
```

Everything uses `requireEncryption()` (DEK-bearing session) for routes that
read/write encrypted data; `requireAuth()` for simple presence checks.

### 4.4 UI

Extend `connector-tab.tsx` with a second provider section, OR (if the UI
starts getting cramped as more providers land) split into per-provider
components and add a provider picker. The mapping dialog + preview dialog
+ reconciliation dialog are already generic — reuse them.

### 4.5 Tests

- **Unit tests on `transform.ts` / `zip-parser.ts`** with inline synthetic
  fixtures. Do NOT commit real user exports — they contain personal
  financial data and the repo is public.
- **Route tests** (mock the orchestrator) verify auth, validation, and
  the plumbing between routes and orchestrator.
- Run from repo root: `npx vitest run packages/import-connectors/`.

### 4.6 Docs

- Add a row to the "First-class connectors" table below.
- Update `packages/import-connectors/README.md` if you discover a new
  pattern worth propagating.
- Add CHANGELOG entry with file index.

### 4.7 No schema migration required

The `settings` table + existing `transactions` / `transaction_splits` /
`portfolio_holdings` schema are sufficient. If a connector needs new
tables (e.g., incoming webhook state), that's a signal to reconsider —
usually the existing tables + a JSON blob in `settings` is enough.

---

## 5. Common patterns (use these; don't reinvent)

### Credentials

```ts
import {
  saveConnectorCredentials,
  loadConnectorCredentials,
  hasConnectorCredentials,
  deleteConnectorCredentials,
} from "@/lib/external-import/credentials";

// Write — requires DEK
await saveConnectorCredentials(userId, "mint", dek, { apiKey, apiSecret });

// Read — requires DEK
const creds = await loadConnectorCredentials<{ apiKey: string }>(userId, "mint", dek);
```

Credentials are AES-GCM-encrypted under the user's DEK via
[src/lib/crypto/envelope.ts](../src/lib/crypto/envelope.ts). One row per
(user, connector) in `settings`.

### Mapping

```ts
import { loadConnectorMapping, saveConnectorMapping } from "@/lib/external-import/mapping";

const mapping = await loadConnectorMapping(userId, "mint");
// { accountMap, categoryMap, transferCategoryId, openingBalanceCategoryId, lastSyncedAt }
```

**Always rebuild from scratch on every preview.** Carry over prior entries
only if the referenced Finlynq account/category still exists — stale ids
from deleted accounts otherwise silently error every row.

### Rate limiting

```ts
import { createRateLimitedFetch } from "@finlynq/import-connectors";
import { createHash } from "crypto";

const bucketKey = `mint:${createHash("sha256").update(apiKey).digest("hex")}`;
const fetchImpl = createRateLimitedFetch({
  minIntervalMs: 1200,  // provider limit + safety margin
  bucketKey,
});
```

Same `bucketKey` across client instances = shared queue on `globalThis`.
Critical — without this, consecutive HTTP requests (probe → preview →
execute) stampede the upstream limit.

### Confirmation tokens

```ts
import { signConfirmationToken, verifyConfirmationToken } from "@/lib/mcp/confirmation-token";

// At preview time:
const token = signConfirmationToken(userId, "mint_sync", canonicalizeMappingInput(input));

// At execute time (the input must match byte-for-byte):
const check = verifyConfirmationToken(token, userId, "mint_sync", canonicalizeMappingInput(input));
if (!check.valid) throw new Error(`Confirmation token rejected (${check.reason})`);
```

5-minute TTL. Idempotent replay: execute re-runs the full pipeline; the
importHash on each row keeps inserts deduped across retries.

### Splits post-insert

The import pipeline doesn't know about splits — they're a separate table.
After `executeImport` returns, look up each parent tx by its `importHash`
and insert `transaction_splits` rows. Delete any existing splits for the
same parent first (idempotent re-runs).

See `runZipExecute` in [zip-orchestrator.ts](../src/lib/external-import/zip-orchestrator.ts)
for the reference implementation.

### Portfolio holdings

If the provider exposes a holding→brokerage relationship (WP's
`Portfolio.csv`, YNAB's payees, Monarch's holdings), write one row per
holding to `portfolio_holdings` during execute, linking to the mapped
brokerage account. Idempotent check: skip if a row with the same
`(user_id, account_id, name_lookup)` already exists — the partial UNIQUE
index `portfolio_holdings_user_account_lookup_uniq` enforces this at the
DB level too. The orchestrator can rely on the resolver
([buildHoldingResolver](../src/lib/external-import/portfolio-holding-resolver.ts))
which handles legacy plaintext + Stream-D-encrypted-only cohorts in one
dual-index lookup; pre-creating the holdings up front (like
`syncPortfolioHoldings` does for WP) is still recommended so rows have
proper symbols + currency rather than the resolver's auto-create
defaults.

### Reconciliation

Reuse [runWealthPositionReconciliation](../src/lib/external-import/reconciliation.ts)
as a template. Core pattern:

1. Fetch WP's balances via `client.getBalances(date)`.
2. Fetch the provider's `/accounts` to build a name→UUID bridge (if the
   saved mapping uses synthetic ids like `csv:acct:<name>`).
3. For each mapped Finlynq account, compute `SUM(amount) WHERE date <= X`.
4. Diff vs. provider balance. Surface per-account rows + an "Add opening
   balance" button for constant-offset mismatches.

---

## 6. Transform conventions

### Sign convention — two worlds exist

- **Finlynq-native:** `amt < 0 + qty > 0` = buy (paid cash, got shares).
- **WP / external-import:** `amt > 0 + qty > 0` = position balance grew.

The portfolio aggregator in
[/api/portfolio/overview](../src/app/api/portfolio/overview/route.ts)
classifies buys by `qty > 0` regardless of amount sign, and sells by
`qty < 0`. **Don't flip signs in the transform** — preserve the
provider's convention so balances reconcile against their API, and let
the aggregator handle both.

### `RawTransaction.portfolioHolding` = holding NAME, not symbol

Connectors set `portfolioHolding` to the human display name of the
position (e.g., "TFSA - Canada", "Joint - USD"). The import pipeline
runs that name through `buildHoldingResolver` and writes the resolved
integer FK to `transactions.portfolio_holding_id` — that FK is what the
aggregator joins on, not the name. Ticker still lives only in
`portfolio_holdings.symbol`/`symbol_ct`. Writing the symbol on the
transaction is a footgun: the resolver auto-creates a holding named
after the ticker, which then doesn't match the user's actual portfolio
row, leaving every position display as `Qty: --`. Always emit the name.

### Route position legs to their own brokerage

A stock buy funded from "RBC Checking" has:
- cash leg on RBC Checking (amount preserved as `-X` — cash out)
- position leg on the brokerage named in Portfolio.csv (e.g., "Questrade - RESP"),
  with `portfolioHolding` + `quantity` set

Both legs are needed: cash leg for reconciliation against the cash
account; position leg for the portfolio page.

### Grouping multi-row transactions

Providers that preserve multi-leg shape (WP's `#SPLIT#`, YNAB's `^Split`,
Mint's grouped rows) need row-order grouping, **not** (date, payee)
grouping. Child rows often have empty payee/note fields even when the
parent's are populated.

### Linking multi-leg legs (transfer / conversion / liquidation)

Every multi-leg group emits rows that share one `randomUUID()`
`linkId` (field on `RawTransaction`). `executeImport` persists it on
`transactions.link_id`. The UI's transactions edit dialog fetches
siblings via `GET /api/transactions/linked?linkId=…&excludeId=…` so the
user can jump between the legs of a transfer pair, a same-account FX
conversion, or a position sell + cash receive. Category splits stay
UNLINKED — the `transaction_splits` table already encodes that parent/
child relation.

### Always emit the parent leg

For a holding-parent + holding-children group (a liquidation: parent is
the position being sold, children are cash / other holdings receiving),
the parent leg MUST be emitted on its brokerage with
`portfolioHolding = parent holding name`, `quantity < 0`, and the
Transfer category. Dropping the parent leaves the aggregator blind to
the sell and the position stays at its pre-sell quantity.

### Dividend / distribution rows with a source holding

If a provider encodes a dividend as `Account=<cash holding>,
Category=Dividends, Amount=20, Quantity=14.29, Portfolio holding=<stock
holding>`, the meaning is "the cash holding received the dividend; the
stock holding generated it". The balance + quantity change land on the
`account` (the cash sleeve), and the source holding goes into `tags` as
`source:<holding name>`. Do NOT set `tx.portfolio_holding` to the source
holding — the aggregator would credit +qty shares to a position that
didn't actually receive any, zeroing its cost basis. Verified against
WP's UI (Jan 2026) — "Link category amounts to portfolio holding" is
reporting attribution, not a share move.

### Orphan rows

If a provider row can't be classified (no preceding parent, unmapped
account, etc.), push it to `TransformResult.errors` with a clear message
and the provider's external id. Surface these in the preview dialog via
`errorRows` — don't let them fall through to the generic "No data to
import" pipeline error.

---

## 7. Load-bearing invariants

These aren't obvious from reading the code; they cost real debugging time.
Don't regress on them without a new comment explaining the change.

1. **`importHash` on plaintext payee.** Finlynq's AES-GCM envelope uses a
   random IV per row, so ciphertext hashes aren't stable. All connectors
   emit plaintext payees; `executeImport` encrypts downstream.
2. **`RawTransaction.portfolioHolding` = holding NAME (not ticker), and the import pipeline resolves it to `transactions.portfolio_holding_id` via `buildHoldingResolver`.** The integer FK is what the aggregator joins on; the encrypted text column stays in place for the dual-write window through Phase 5. See §6.
3. **Portfolio aggregator classifies by `qty` direction, not `amt` sign.**
   See §6.
4. **Position legs route to their OWN brokerage.** See §6.
5. **Reconciliation bridges synthetic ids to provider UUIDs** by
   fetching the provider's `/accounts` at reconcile time and matching by
   name. Without this, mapped accounts silently fail lookup.
6. **Mapping is rebuilt from scratch on every preview**, carrying over
   prior entries only if the referenced Finlynq account / category still
   exists. Stale ids (from accounts deleted outside the import flow)
   otherwise route every row to a nonexistent target and the transform
   silently returns zero rows.
7. **`#SPLIT#` / multi-leg chains grouped by CSV row order**, never by
   (date, payee) — child rows have empty metadata.
8. **Dedup maps in the orchestrator match the DB's
   `UNIQUE (user_id, name_lookup)` partial index.** Keep TWO indexes per
   table — one keyed by `trim().toLowerCase()` plaintext (legacy rows)
   and one keyed by the `name_lookup` HMAC (Stream D Phase 3 rows whose
   plaintext is nulled). On auto-create, compute `nameLookup(dek,
   desiredName)` and check both before INSERTing. Case-sensitive
   plaintext-only lookup misses both same-CSV collisions (`Balance
   adjustments` vs `Balance Adjustments`) and Phase 3 encrypted rows.
9. **Parent leg always emitted in multi-leg groups**, including when the
   parent itself is a holding (liquidation). Dropping the parent blinds
   the aggregator to sell-side qty changes.
10. **CSV `Portfolio holding` column may be attribution, not a share
   move.** When `csv.portfolio_holding != row.account` on a dividend /
   distribution row, the source holding goes to `tags` as `source:<name>`
   and the balance change lands on the `account`. The aggregator would
   otherwise credit phantom shares to the tagged holding.
11. **Multi-leg groups share one `linkId`** so the UI can surface them
   as siblings. Category-split groups (parent + N splits) intentionally
   don't share a linkId — the `transaction_splits` table already encodes
   that relation.

---

## 8. Testing

| Layer | Where | What to cover |
|---|---|---|
| `transform.ts` / `zip-parser.ts` | `packages/import-connectors/src/<provider>/*.test.ts` | One test per shape: simple 1A+1C, transfer, split with categories, split with holdings, orphans, bad amounts, unmapped entries, edge cases. Use inline synthetic fixtures (no real user exports). |
| Orchestrator | `tests/lib/external-import/*.test.ts` | Mock `db` + encryption helpers. Verify mapping materialization, stale-id filtering, splits post-insert, reconciliation bridge. |
| Routes | `tests/api/import/connectors/<provider>/*.test.ts` | Mock the orchestrator. Cover auth (401/423), validation (400), and happy path shape. |

Run everything: `cd pf-app && npm test`.

---

## 9. First-class connectors

| Provider | ID | Added | Paths | Reconciliation | Notes |
|---|---|---|---|---|---|
| WealthPosition | `wealthposition` | 2026-04-24 | ZIP + API | via API `/account_balances` | Portfolio.csv is the holding→brokerage ground truth. `#SPLIT#` sentinel preserves multi-leg shape. |

### Candidate providers (not yet started)

| Provider | Export path? | API? | Known quirks |
|---|---|---|---|
| **Mint** | Yes — Excel export of transactions | No (shut down, export-only) | Splits marked with `^Split` categorization; no holding info. |
| **YNAB** | Yes — CSV + full API | REST API with OAuth | Categorized, no holdings. Accounts tagged by type. |
| **Monarch Money** | Yes — CSV export | Private API (undocumented) | Holdings tracked separately; transactions carry account + merchant. |
| **Lunch Money** | Yes — CSV + full API | REST API with token | Tags are structured; categories nested. |
| **Quicken** | Yes — QIF/CSV | No | QIF parser would live alongside csv.ts. |
| **Personal Capital / Empower** | Yes — CSV | No public API | Strong holdings + balances in CSV. |

Before starting a new connector:
1. Download an export from a real account. Inspect the shape.
2. Decide ZIP-first vs API-first based on what the export carries.
3. Draft the transform rules per shape BEFORE writing code.
4. Scrub synthetic fixtures; don't commit real data.

---

## 10. Deprecation + removal

When a connector becomes obsolete (provider shut down, API changed
beyond recognition, <10 users per quarter):

1. Mark deprecated in `metadata.displayName` (e.g., "Mint (deprecated)").
2. Hide the UI section behind a feature flag or admin-only gate.
3. Migration path: export an admin-only "download my data" for existing
   users, leave credentials/mapping in `settings` for 90 days, then drop
   the settings rows with a one-off migration.
4. Remove the connector directory + route tree + orchestrator.

Don't leave dead code sitting. The `Connector<Credentials>` interface is
designed so a directory rename == "this provider is gone."

---

## 11. Open questions / future work

- **Provider registry.** Right now `connector-tab.tsx` hardcodes
  WealthPosition. Once a second provider lands, refactor to a registry
  (`const CONNECTORS: Connector<unknown>[] = [wealthposition, mint]`) and
  a provider-picker UI.
- **Dev-mode sandbox keys.** Some providers (YNAB, Lunch Money) offer
  sandbox tokens that make test automation much easier. Document per
  provider.
- **Cron-scheduled sync.** Today the API path is user-initiated. A
  background-sync wrapper that runs `runXExecute` nightly on users with
  a saved key is the obvious next capability, gated by a per-user
  `syncEnabled` flag in the mapping settings.
- **Per-connector reconciliation UI.** The dialog assumes the reconcile
  endpoint exists. Add a feature flag on `ConnectorMetadata` for providers
  that don't support reconciliation.

---

_Questions, please leave a comment on the PR that touches the connector
you're working on. If you're re-learning something painful while reading
this doc, add a row to §7._
