# Table Artifact Registry

> Single source of truth for every table artifact in the web app, classifying
> each as **centrally-managed** (renders via the shared `DataTable`) or
> **custom** (stays bespoke, with a one-line reason). Seeded by the FINLYNQ-196
> feature audit (2026-06-18). **Every future table PR must update this doc** —
> flip a row custom → central as it migrates, or add a new row classified at
> creation time.

## The shared component

`src/components/ui/data-table.tsx` (FINLYNQ-196) — `DataTable<T>`, a generic,
descriptor-driven, sortable (+ optionally filterable / column-hideable) table
layout. It **composes** the presentational `ui/table.tsx` primitives (does not
replace them). Configured by a `DataTableColumn<T>[]` array mirroring
`exportCsv`'s `{ header, accessor }` descriptor philosophy
(`src/lib/csv-export.ts`, FINLYNQ-144).

### Capabilities (the prop surface the audit drove)

| Axis | Prop | Notes |
|---|---|---|
| Per-column sort | `column.sortable` (default `true`) | Click-to-sort header, **2-state** asc ↔ desc, starts unsorted. `aria-sort` on every sortable header. Null-safe comparator. |
| Non-sortable action column | `sortable: false` | e.g. an "Open" / row-action button. |
| Right-align + `tabular-nums` | `column.align: "right"` | For numeric / currency cells. |
| Custom cell renderer | `column.render` | Badges, links, buttons, multi-part cells. Falls back to the stringified `accessor`. |
| Per-column header filter | `column.filter: "text" \| "select"` | Client-side over `accessor`. Opt-in per column. |
| Show / hide columns | `column.hideable` + `column.defaultHidden` | Renders a checkbox control above the table. |
| Empty state | `emptyState` prop | Rendered in place of the table when there are zero source rows. |
| Controlled sort | `sort` + `onSortChange` | Optional; uncontrolled (internal state) by default. |

### Conventions (load-bearing)

- **Sort = 2-state**, applied consistently: first click on a sortable header →
  ascending; subsequent clicks toggle asc ↔ desc; a different header switches to
  that column, ascending. The default (no column sorted) is the natural `rows`
  order. This matches the pre-existing securities / admin / holdings tables.
- **Comparators defend against null** (decrypted name fields can be null — see
  CLAUDE.md "String methods on decrypted-name fields must defend against null"):
  string accessors via `(a ?? "").localeCompare(b ?? "")`, numeric via a
  null-safe numeric compare (null sorts smallest). The exported `compareValues`
  is the single comparator.
- **Sort is client-side** — the data tables it serves have tiny row counts
  (≤ #accounts / #holdings). No server-side sort param.

## Registry

### Centrally-managed (renders via `DataTable`)

| Table | File | Notes |
|---|---|---|
| Reconciliation summary | `src/components/inbox/reconcile-summary-panel.tsx` | FINLYNQ-196 — first consumer. Account / Current balance / Last import / Last reconciled / Pending (sortable) + Open (action). |

### Central-path candidate — not yet migrated (hand-rolled sort today)

These are flat data tables that hand-roll their own sort state machine. They are
the Phase 3 migration targets; flip them to **centrally-managed** as each is
moved onto `DataTable`.

| Table | File | Current state |
|---|---|---|
| Securities catalog (Securities tab) | `src/app/(app)/settings/investments/page.tsx` | Per-column header filters (text/select) + 4-key 2-state click-to-sort. The filter/sort reference. |
| Admin users | `src/app/(app)/admin/page.tsx` | Sortable with `aria-sort`, 8-column 2-state. |
| Portfolio All-Holdings | `src/app/(app)/portfolio/_components/holdings-table.tsx` | `sortField`/`sortDir` 2-state + type filter + hide-empty; top rows have an expand region (the expand region itself stays custom — see below). |
| Subscriptions | `src/app/(app)/subscriptions/page.tsx` | Has its own sort state. Evaluate during Phase 3. |

### Central-path candidate — flat, no sort yet

Flat tables that could adopt `DataTable` to gain sort (lower priority — they
have no hand-rolled sort to consolidate).

| Table | File |
|---|---|
| Realized gains | `src/app/(app)/portfolio/realized-gains/page.tsx` |
| Dividends (per-holding view) | `src/app/(app)/portfolio/dividends/page.tsx` |
| Tax summary | `src/app/(app)/tax/page.tsx` |
| Loans | `src/app/(app)/loans/page.tsx` |
| FIRE | `src/app/(app)/fire/page.tsx` |
| Scenarios | `src/app/(app)/scenarios/page.tsx` |
| Transactions | `src/app/(app)/transactions/_components/transaction-table.tsx` | (large; SWR-backed — migrate carefully) |

### Custom (deliberately bespoke — out of scope for `DataTable`)

The shared component should **not** contort to absorb these. Recorded here so we
always know they are intentionally off the shared path.

| Table | File | Reason |
|---|---|---|
| Securities **By security** / **By account** tabs | `src/app/(app)/settings/investments/page.tsx` | Collapsible tree (security → accounts / account → securities) with per-row expand + inline add/unlink actions. |
| Holdings by account | `src/app/(app)/portfolio/_components/holdings-by-account.tsx` | Collapsible per-account groups with nested holding rows. |
| Portfolio All-Holdings expand region | `src/app/(app)/portfolio/_components/holdings-table.tsx` | The top rows are a `DataTable` candidate, but the per-row drill-down (per-account breakdown + metrics grid + lot inspector) stays custom. |
| Reports grouped breakdown | `src/app/(app)/reports/page.tsx` | `GroupedTable` — parent/child period rows, per-period columns, group sums (FINLYNQ-185). Pivoted, not flat. |
| ETF X-ray | `src/app/(app)/portfolio/_components/etf-xray-card.tsx` | Composition breakdown, not a flat data grid. |
| Account detail | `src/app/(app)/accounts/[id]/page.tsx` | Mixed layout (cash sleeves + transactions + metrics), not a single flat grid. |
| Backfill review | `src/app/(app)/settings/backfill/[runId]/page.tsx` | Proposal review with inline pickers / variant radios / per-row apply state. |
| Import preview | `src/app/(app)/import/components/import-preview-dialog.tsx` | Two-pane / reconcile-flow with per-row edit + dedup match surfacing. |
| Column-mapping dialog | `src/app/(app)/import/components/column-mapping-dialog.tsx` | Field-mapping confirm grid (header → field selects). |
| OFX confirm dialog | `src/app/(app)/import/components/ofx-confirm-dialog.tsx` | Reconcile-flow confirm grid. |
| Excel mapper dialog | `src/app/(app)/import/components/excel-mapper-dialog.tsx` | Sheet/column mapping grid. |
| Connector reconciliation dialog | `src/app/(app)/import/components/connector-reconciliation-dialog.tsx` | Reconcile-flow. |
| Connector tab | `src/app/(app)/import/components/connector-tab.tsx` | Connector status / action panel, not a flat grid. |
| Two-pane reconcile | `src/components/reconcile/*`, `src/components/import/reconcile/*` | Reconcile-flow (bank rows ↔ ledger), inline accept/unlink/materialize actions. The `BankPane` renders gated **Ticker / Security / Qty** columns when `isInvestment` (FINLYNQ-207, display-only, per-`encryption_tier`-decrypted; cash view byte-identical). |
| Admin inbox / email-inbox | `src/app/(app)/admin/inbox/page.tsx`, `src/app/(app)/admin/email-inbox/page.tsx` | Triage surfaces with per-row actions + encryption-aware redaction. |
| Settings → Data | `src/app/(app)/settings/data/page.tsx` | Backup/restore controls + its own CSV builder, not a flat data grid. |
| Chat | `src/app/(app)/chat/page.tsx` | Renders tables inside AI-chat markdown — not app data. |
| API docs / marketing | `src/app/(app)/api-docs/page.tsx`, `/vs`, etc. | Static / documentation tables. |
