/**
 * FINLYNQ-261 — apiHandler adoption guardrail.
 *
 * apiHandler (FINLYNQ-107, src/lib/api-handler.ts) folds auth gating, body
 * validation, error mapping, and the success envelope into one wrapper.
 * Adoption is intentionally incremental (FINLYNQ-116) — as of this file's
 * creation only ~17/211 `route.ts` files under src/app/api/ use it. The
 * `api-handler-adoption` invariant in audit-invariants.ts stops the bleeding
 * going forward: any NEW route.ts under src/app/api/ that exports an HTTP
 * method handler MUST reference `apiHandler`, unless it is either
 *
 *   (a) on API_HANDLER_EXEMPT_GLOBS below (a PERMANENT carve-out — routes
 *       that are deliberately hand-rolled to match the auth-route style and
 *       are not expected to ever adopt apiHandler), or
 *   (b) in API_HANDLER_BASELINE below (a SNAPSHOT of the routes that
 *       predate this guardrail and haven't been migrated yet).
 *
 * Migrating a baseline route to apiHandler is encouraged opportunistically —
 * when you do, DELETE its entry from API_HANDLER_BASELINE (don't just leave
 * it there; a stale baseline entry silently masks a regression if the route
 * is later rewritten without apiHandler). The baseline only ever shrinks;
 * never add a NEW route's path here to dodge the guardrail — use an exempt
 * glob only when the route is genuinely, permanently hand-rolled by design.
 *
 * Regenerating the baseline (only if a legitimate pre-existing route was
 * missed): from pf-app/,
 *
 *   for f in $(find src/app/api -name "route.ts" | sort); do
 *     grep -qE "export (async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b" "$f" \
 *       && ! grep -q "apiHandler" "$f" && echo "$f"
 *   done
 *
 * then subtract any path matched by API_HANDLER_EXEMPT_GLOBS.
 */

/**
 * Permanent exemption globs (path prefixes, relative to the repo root,
 * forward-slash separated). A route.ts whose relative path starts with one
 * of these is EXEMPT from the apiHandler guardrail — now and for any future
 * route added under the prefix. Keep this list narrow and documented; it is
 * NOT a place to bulk-exempt routes to avoid migrating them (that's what
 * API_HANDLER_BASELINE is for, and baseline entries are meant to shrink).
 *
 * Rationale per group, per CLAUDE.md:
 *   - src/app/api/auth/**            — "hand-rolled NOT apiHandler to match
 *                                        the auth-route style" (login/
 *                                        register/session/wipe/etc. — the
 *                                        auth boundary predates and is
 *                                        stylistically distinct from the
 *                                        apiHandler auth gate itself).
 *   - src/app/api/oauth/**           — OAuth 2.1 / DCR endpoints (RFC-shaped
 *                                        request/response contracts, CORS *,
 *                                        bespoke error bodies per spec —
 *                                        not apiHandler's JSON envelope).
 *   - src/app/api/settings/change-password/, change-email/
 *                                     — "hand-rolled NOT apiHandler to match
 *                                        the auth-route style" (credential
 *                                        management, same auth-route
 *                                        conventions as src/app/api/auth/).
 *   - src/app/api/admin/**           — hand-rolled `requireAdmin` gate +
 *                                        managed-mode dialect guard; admin
 *                                        routes are deliberately NOT
 *                                        apiHandler (CLAUDE.md: "Routes
 *                                        hand-roll requireAdmin (NOT
 *                                        apiHandler)").
 */
export const API_HANDLER_EXEMPT_GLOBS: string[] = [
  "src/app/api/auth/",
  "src/app/api/oauth/",
  "src/app/api/settings/change-password/",
  "src/app/api/settings/change-email/",
  "src/app/api/admin/",
];

/**
 * Snapshot baseline — existing hand-rolled routes (as of FINLYNQ-261) that
 * are NOT apiHandler and are NOT covered by an exempt glob. These pass the
 * guardrail today; a NEW route is never added here. 157 entries.
 */
export const API_HANDLER_BASELINE: string[] = [
  "src/app/api/accounts/[id]/import-prefs/route.ts",
  "src/app/api/accounts/[id]/mode/route.ts",
  "src/app/api/accounts/[id]/opening-balance/route.ts",
  "src/app/api/accounts/route.ts",
  "src/app/api/age-of-money/route.ts",
  "src/app/api/announcements/[id]/read/route.ts",
  "src/app/api/announcements/route.ts",
  "src/app/api/bank-transactions/[bankId]/approve/route.ts",
  "src/app/api/bank-transactions/[bankId]/categorize/route.ts",
  "src/app/api/bank-transactions/[bankId]/route.ts",
  "src/app/api/budget-templates/route.ts",
  "src/app/api/budgets/route.ts",
  "src/app/api/budgets/seed/route.ts",
  "src/app/api/categories/route.ts",
  "src/app/api/chat/route.ts",
  "src/app/api/csp-report/route.ts",
  "src/app/api/dashboard/route.ts",
  "src/app/api/data/export/route.ts",
  "src/app/api/data/import/route.ts",
  "src/app/api/data/route.ts",
  "src/app/api/email-rules/[id]/route.ts",
  "src/app/api/email-rules/route.ts",
  "src/app/api/feedback/[id]/attachment/route.ts",
  "src/app/api/feedback/[id]/read/route.ts",
  "src/app/api/feedback/[id]/reply/route.ts",
  "src/app/api/feedback/[id]/route.ts",
  "src/app/api/feedback/route.ts",
  "src/app/api/fire/monte-carlo/route.ts",
  "src/app/api/fire/route.ts",
  "src/app/api/forecast/route.ts",
  "src/app/api/fx/overrides/route.ts",
  "src/app/api/fx/preview/route.ts",
  "src/app/api/fx/route.ts",
  "src/app/api/goals/route.ts",
  "src/app/api/health-score/route.ts",
  "src/app/api/healthz/route.ts",
  "src/app/api/import/backfill/route.ts",
  "src/app/api/import/bank-ledger/route.ts",
  "src/app/api/import/connectors/generic-csv/execute/route.ts",
  "src/app/api/import/connectors/generic-csv/preview/route.ts",
  "src/app/api/import/connectors/moneypro/execute/route.ts",
  "src/app/api/import/connectors/moneypro/preview/route.ts",
  "src/app/api/import/connectors/wealthposition/credentials/route.ts",
  "src/app/api/import/connectors/wealthposition/execute/route.ts",
  "src/app/api/import/connectors/wealthposition/preview/route.ts",
  "src/app/api/import/connectors/wealthposition/probe/route.ts",
  "src/app/api/import/connectors/wealthposition/reconcile/route.ts",
  "src/app/api/import/connectors/wealthposition/zip-execute/route.ts",
  "src/app/api/import/connectors/wealthposition/zip-preview/route.ts",
  "src/app/api/import/connectors/wealthposition/zip-probe/route.ts",
  "src/app/api/import/csv-map/route.ts",
  "src/app/api/import/email-config/route.ts",
  "src/app/api/import/email-inbox/[id]/route.ts",
  "src/app/api/import/email-inbox/route.ts",
  "src/app/api/import/email-webhook/route.ts",
  "src/app/api/import/excel-map/route.ts",
  "src/app/api/import/execute/route.ts",
  "src/app/api/import/preview/route.ts",
  "src/app/api/import/route.ts",
  "src/app/api/import/staged/[id]/apply-rules/route.ts",
  "src/app/api/import/staged/[id]/approve/route.ts",
  "src/app/api/import/staged/[id]/bind/route.ts",
  "src/app/api/import/staged/[id]/create-rule/route.ts",
  "src/app/api/import/staged/[id]/route.ts",
  "src/app/api/import/staged/[id]/rows/[rowId]/route.ts",
  "src/app/api/import/staged/route.ts",
  "src/app/api/import/staging/upload/route.ts",
  "src/app/api/import/templates/[id]/route.ts",
  "src/app/api/import/templates/route.ts",
  "src/app/api/import/uploads/[batchId]/route.ts",
  "src/app/api/import/uploads/route.ts",
  "src/app/api/insights/route.ts",
  "src/app/api/loans/route.ts",
  "src/app/api/mcp/.well-known/oauth-protected-resource/route.ts",
  "src/app/api/mcp/route.ts",
  "src/app/api/net-worth-history/route.ts",
  "src/app/api/onboarding/complete/route.ts",
  "src/app/api/onboarding/sample-data/route.ts",
  "src/app/api/portfolio/benchmarks/route.ts",
  "src/app/api/portfolio/crypto/route.ts",
  "src/app/api/portfolio/dividends/route.ts",
  "src/app/api/portfolio/etf-breakdown/route.ts",
  "src/app/api/portfolio/holdings/[holdingId]/lots/allocate/route.ts",
  "src/app/api/portfolio/holdings/[holdingId]/lots/reassign/route.ts",
  "src/app/api/portfolio/holdings/[holdingId]/lots/rebuild/route.ts",
  "src/app/api/portfolio/holdings/[holdingId]/lots/route.ts",
  "src/app/api/portfolio/holdings/cash-sleeve/route.ts",
  "src/app/api/portfolio/lots/route.ts",
  "src/app/api/portfolio/operations/load/route.ts",
  "src/app/api/portfolio/overview/route.ts",
  "src/app/api/portfolio/performance/holdings/route.ts",
  "src/app/api/portfolio/performance/route.ts",
  "src/app/api/portfolio/realized-gains/route.ts",
  "src/app/api/portfolio/route.ts",
  "src/app/api/portfolio/snapshots/rebuild/route.ts",
  "src/app/api/portfolio/snapshots/rebuild/status/route.ts",
  "src/app/api/portfolio/symbol-info/route.ts",
  "src/app/api/prices/route.ts",
  "src/app/api/rebalancing/route.ts",
  "src/app/api/recap/route.ts",
  "src/app/api/reconcile/apply-rules/route.ts",
  "src/app/api/reconcile/auto-rule-recent/route.ts",
  "src/app/api/reconcile/balance-summary/route.ts",
  "src/app/api/reconcile/links/bulk/route.ts",
  "src/app/api/reconcile/links/route.ts",
  "src/app/api/reconcile/materialize/route.ts",
  "src/app/api/reconcile/suggestions/route.ts",
  "src/app/api/reconcile/summary/route.ts",
  "src/app/api/recurring/route.ts",
  "src/app/api/reports/route.ts",
  "src/app/api/reports/trends/route.ts",
  "src/app/api/reports/yoy/route.ts",
  "src/app/api/rules/route.ts",
  "src/app/api/scenarios/route.ts",
  "src/app/api/settings/account-group-order/route.ts",
  "src/app/api/settings/active-currencies/route.ts",
  "src/app/api/settings/api-key/route.ts",
  "src/app/api/settings/backfill/[runId]/apply/route.ts",
  "src/app/api/settings/backfill/[runId]/counterpart-candidates/route.ts",
  "src/app/api/settings/backfill/[runId]/route.ts",
  "src/app/api/settings/backfill/[runId]/undo/[proposalId]/route.ts",
  "src/app/api/settings/backfill/coverage/route.ts",
  "src/app/api/settings/backfill/fix-cash-sleeve-symbols/route.ts",
  "src/app/api/settings/backfill/route.ts",
  "src/app/api/settings/bank-feeds/simplefin/connect/route.ts",
  "src/app/api/settings/bank-feeds/simplefin/disconnect/route.ts",
  "src/app/api/settings/bank-feeds/simplefin/preview/route.ts",
  "src/app/api/settings/bank-feeds/simplefin/status/route.ts",
  "src/app/api/settings/bank-feeds/simplefin/sync/route.ts",
  "src/app/api/settings/confirm-csv-mapping/route.ts",
  "src/app/api/settings/connected-apps/route.ts",
  "src/app/api/settings/dev-mode/route.ts",
  "src/app/api/settings/display-currency/route.ts",
  "src/app/api/settings/dropdown-order/route.ts",
  "src/app/api/settings/email-retention/route.ts",
  "src/app/api/settings/reconcile-hidden-accounts/route.ts",
  "src/app/api/settings/reconcile-thresholds/route.ts",
  "src/app/api/settings/reporting-currency/status/route.ts",
  "src/app/api/settings/tx-columns/route.ts",
  "src/app/api/settings/tx-filters/route.ts",
  "src/app/api/settings/tx-sort/route.ts",
  "src/app/api/snapshots/route.ts",
  "src/app/api/spotlight/route.ts",
  "src/app/api/subscriptions/route.ts",
  "src/app/api/tax/route.ts",
  "src/app/api/transactions/[id]/reconciliation-flag/route.ts",
  "src/app/api/transactions/audit/route.ts",
  "src/app/api/transactions/bulk/route.ts",
  "src/app/api/transactions/linked/route.ts",
  "src/app/api/transactions/lot-replan-preview/route.ts",
  "src/app/api/transactions/reconciliation/route.ts",
  "src/app/api/transactions/route.ts",
  "src/app/api/transactions/splits/route.ts",
  "src/app/api/transactions/suggest/route.ts",
  "src/app/api/transactions/transfer/route.ts",
  "src/app/api/user/me/route.ts",
];
