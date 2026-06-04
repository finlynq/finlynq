# apiHandler rollout checklist (FINLYNQ-107 → FINLYNQ-116)

**Status:** `apiHandler` shipped + the `/api/portfolio/operations/*` group migrated as the proof-of-pattern (2026-06-03). The broad rollout of the remaining ~113 hand-rolled-try/catch routes is the deferred follow-up tracked as **FINLYNQ-116** (`postponed`, `relates_to` FINLYNQ-107). This file enumerates the remaining work so the increment is explicitly partial.

## What `apiHandler` is

`src/lib/api-handler.ts` — one wrapper folding the four concerns every mutating REST route re-implements by hand:

1. **auth gate** — `requireAuth` (401) or `requireEncryption` (423), via `auth: "auth" | "encryption"`.
2. **body validation** — `validateBody(json, schema)` → 400 on failure (or bad JSON), via `body: zodSchema`.
3. **catch → status map** — optional `mapError` (e.g. `mapOperationError`) runs first; then `safeErrorMessage` + `logApiError`, honouring `AppError.status` (vs a bare 500).
4. **success envelope** — `apiSuccess(value)` → `{ success: true, data }`.

### Two output modes — the load-bearing knob

- **enveloped (default)** — handler returns a plain value; the wrapper wraps it with `apiSuccess`. Catch branch emits `{ success: false, error }`. Use for **new routes** and groups with **no bare-shape consumer**.
- **raw / compat (`raw: true`)** — handler returns its own `NextResponse` verbatim; the catch branch stays **bare** (`{ error }`). Use to centralize auth + validation + error handling for a **bare-shape route group WITHOUT changing the wire contract**.

> **Behaviour preservation is mandatory.** Before flipping any route to the default (enveloped) mode, **grep its web + mobile consumers**. The web/mobile clients read several routes BARE; we have a documented history of the mobile REST-envelope mismatch blanking every screen. Migrate route-group-by-route-group with a consumer check, not a sweep.

## Migrated (this increment) — `/api/portfolio/operations/*`

All 8 POST routes now run through `apiHandler` in **raw/compat mode** (bare `{ id, ... }` 2xx + bare structured errors preserved — the web portfolio forms + mobile `postPortfolioOperation` depend on this exact shape):

- [x] `buy/route.ts`
- [x] `sell/route.ts`
- [x] `swap/route.ts`
- [x] `transfer/route.ts`
- [x] `deposit/route.ts`
- [x] `withdrawal/route.ts`
- [x] `fx-conversion/route.ts`
- [x] `income-expense/route.ts`

`load/route.ts` (GET) is intentionally **left as-is for now**: it already returns the `{ success, data }` envelope AND is consumed as `res.data` by the web forms + mobile `OperationLoadData` — so it is already envelope-consistent; rewrapping it through `apiHandler` (non-raw) is a no-op-shape follow-up, not a fix.

Tests:
- `tests/api-handler.test.ts` — 15 wrapper unit tests (envelope, raw mode, validation, 401/423, AppError.status, mapError short-circuit).
- `tests/api/portfolio-operations-buy.test.ts` — 4 route tests pinning the bare contract (201 bare `{id}`, bare 400, bare structured domain error, 423 no-DEK).

## Migrated (FINLYNQ-116, increment 1, 2026-06-04) — `notifications` + `holding-accounts`

Lowest-contract-risk group per the item body (internal/admin, no-mobile-consumer first). Both migrated in **raw/compat mode (`raw: true`)** — byte-identical wire shape, so zero blank-screen risk:

- [x] `notifications/route.ts` (GET + POST) — **Category B → raw/compat.** Consumer grep: **ZERO callsites** in `pf-app/src` or `pf-app/mobile/src`. Returns bare `{ notifications, unreadCount }` (GET) / `{ success }` / `{ generated }` / bare 201 row (POST action-dispatch). No `body` schema passed (POST self-dispatches on `body.action` across multiple shapes, keeps its own validation). Auth + bare `{ error }` catch centralized.
- [x] `holding-accounts/route.ts` (GET + POST + PUT + DELETE) — **Category B → raw/compat.** Consumer grep: ONLY the web `src/app/(app)/settings/holding-accounts/page.tsx`; **no mobile consumer**. The page reads a BARE array (GET, iterates `pairings` directly), checks only `res.ok` on success bodies (POST 201 row / PUT row / DELETE `{success:true}`), and reads bare `{ error }` on failure — so the shape was preserved exactly. POST/PUT pass their existing single Zod schema to `apiHandler`'s `body` option (bad JSON / invalid body → bare 400); the in-handler ownership / duplicate-409 / not-found-404 / last-pairing-409 guards return their own NextResponse, passed through verbatim. DELETE reads `holdingId`/`accountId` query params (no body schema).

Tests:
- `tests/api/holding-accounts.test.ts` — 8 route tests pinning the bare contract (GET bare array; POST 201 bare row, bare 400 invalid body, bare 409 duplicate; DELETE bare 409 last-pairing + bare 400 missing params; notifications GET bare `{ notifications, unreadCount }`; 401 unauth).

## Remaining routes (FINLYNQ-116)

~111 `route.ts` files still hand-roll try/catch (was ~113; `notifications` + `holding-accounts` migrated 2026-06-04). Migrate incrementally. For each, classify FIRST:

- **A. enveloped-safe** — internal-only or already-`{success}` consumers → migrate to default mode.
- **B. bare-compat** — web/mobile reads a bare array/object/error → migrate in `raw: true` mode (centralize auth+validation+error, keep the shape).
- **C. leave** — webhooks / health / CSP-report / OAuth protocol endpoints whose response shape is fixed by an external spec.

### Known bare-shape consumers (Category B — must stay bare unless the client changes too)

These are confirmed via consumer greps; do NOT envelope without a coordinated client change:

- `bank-transactions/[bankId]/{approve,categorize}/route.ts`, `bank-transactions/[bankId]/route.ts` — mobile inbox + web reconcile read bare `{ id }` / bare structured errors (`code`, `blockingClosureTxIds`).
- `transactions/route.ts` (GET) — paginated `{ data, total }` envelope (issue #59); mobile `endpoints.getTransactions` unwraps `{data,total}`, NOT `{success,data}`.
- `accounts/route.ts`, `categories/route.ts`, `goals/route.ts` (GET) — bare arrays consumed by mobile + web list screens.
- `dashboard/route.ts`, `portfolio/route.ts`, `portfolio/overview/route.ts` — bare JSON; mobile `request()` synthesizes its own envelope from HTTP status.
- `settings/display-currency`, `settings/reconcile-thresholds`, `accounts/[id]/mode`, `reconcile/suggestions`, `reconcile/links/bulk`, `reconcile/auto-rule-recent` — mixed bare/enveloped; check each.

### Protocol / fixed-shape (Category C — likely leave)

- `mcp/route.ts`, `mcp/upload/route.ts`, `oauth/{authorize,token,register}/route.ts`, `import/email-webhook/route.ts`, `csp-report/route.ts`, `healthz/route.ts`.

### Full remaining list (grep `} catch` under `src/app/api`, 2026-06-03; `notifications` + `holding-accounts` struck 2026-06-04)

```
accounts/[id]/mode, accounts, admin/announcements/[id], admin/announcements,
admin/feedback/[id]/reply, admin/feedback/[id], admin/users, age-of-money,
auth/delete-account, auth/login, auth/logout, auth/mfa/setup, auth/mfa/verify,
auth/password-reset/confirm, auth/password-reset/request, auth/register,
auth/wipe-account, bank-transactions/[bankId]/approve,
bank-transactions/[bankId]/categorize, bank-transactions/[bankId],
budget-templates, budgets, budgets/seed, categories, chat, csp-report, dashboard,
data/export, data/import, data, feedback/[id]/reply, feedback, fire/monte-carlo,
fire, fx/overrides, goals, healthz, import/backfill,
import/connectors/wealthposition/{credentials,execute,preview,probe,reconcile,
zip-execute,zip-preview,zip-probe}, import/csv-map, import/email-config,
import/email-webhook, import/excel-map, import/execute, import/preview, import,
import/staged/[id]/apply-rules, import/staged/[id]/approve, import/staged/[id]/bind,
import/staged/[id]/create-rule, import/staged/[id], import/staged/[id]/rows/[rowId],
import/staging/upload, import/templates/[id], import/templates,
import/uploads/[batchId], loans, mcp, mcp/upload, net-worth-history,
oauth/authorize, oauth/register, oauth/token, onboarding/sample-data,
portfolio/benchmarks, portfolio/crypto, portfolio/holdings/cash-sleeve,
portfolio/lots, portfolio/operations/load, portfolio/overview, portfolio,
portfolio/snapshots/rebuild, portfolio/symbol-info, rebalancing,
reconcile/links/bulk, reconcile/links, reconcile/materialize, reconcile/suggestions,
rules, scenarios, settings/active-currencies, settings/backfill/[runId]/apply,
settings/backfill/[runId], settings/backfill/[runId]/undo/[proposalId],
settings/backfill/coverage, settings/backfill/fix-cash-sleeve-symbols,
settings/backfill, settings/display-currency, settings/dropdown-order,
settings/reconcile-thresholds, settings/tx-columns, settings/tx-filters,
settings/tx-sort, snapshots, subscriptions, tax,
transactions/[id]/reconciliation-flag, transactions/audit, transactions/bulk,
transactions/linked, transactions, transactions/splits, transactions/suggest,
transactions/transfer
```

## Convention for new routes

New mutating routes SHOULD use `apiHandler`. Default to the enveloped mode for brand-new endpoints (no legacy consumer); use `raw: true` only when matching an existing bare-shape sibling group.
