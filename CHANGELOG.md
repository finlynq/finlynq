# Changelog

All notable changes to Finlynq are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

## [Unreleased]

### Fixed
- **Admin nav gate restored (2026-04-23, commit [4656656](https://github.com/finlynq/finlynq/commit/4656656)).** `db9fd75` (SQLite purge) removed `/api/auth/unlock` but `src/components/nav.tsx` was still fetching it — the 404 put `isAdmin` at `false` for every user and the **Admin** link never rendered. Repointed nav at `/api/auth/session`, and taught that endpoint to emit `authMethod`, `isAdmin` (looked up from `users.role` in managed mode), plus `email` and `displayName` for future client consumers. No schema change. See [src/app/api/auth/session/route.ts](src/app/api/auth/session/route.ts).

### Security
- **Full audit remediation (2026-04-22).** Addressed 3 critical, 4 high, 4 medium findings in one commit. Plan: [AUDIT_REMEDIATION_PLAN.md](../AUDIT_REMEDIATION_PLAN.md).
  - **Critical — stdio MCP user isolation.** `mcp-server/index.ts` now requires `PF_USER_ID` at boot (exits otherwise). ~68 SQL queries across `register-core-tools.ts`, `tools-v2.ts`, `tools-import-templates.ts` now filter by `user_id`. Every UPDATE/DELETE has an ownership pre-check. INSERTs bind userId from closure, never from tool arguments. Before the fix, a stdio caller against a multi-user DB could read and destructively write across all tenants.
  - **Critical — SQL injection in MCP `update_account`.** Replaced `sql.raw()` + manual quote escaping with parameterized `sql` fragments.
  - **Critical — CSV import cross-user attach.** All name-based lookups in `src/lib/csv-parser.ts` now filter by userId. Before, one user's import could attach transactions to another user's account if names collided.
  - **High — `encryptionV` bump in `wipeUserDataAndRewrap`.** Multi-tab password resets now correctly invalidate cached DEKs.
  - **High — `PF_JWT_SECRET` fatal in prod.** `src/lib/auth/jwt.ts` throws at module load if missing in production; dev still falls back with a one-time warn.
  - **High — OAuth DCR rate limit.** `/api/oauth/register` capped at 10 registrations/hour/IP.
  - **High — Security headers in `next.config.ts`.** HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy enforced. CSP ships as Report-Only — flip to enforced after a week of clean console.
  - **Medium — Input/request caps.** `/api/chat` message ≤ 2000 chars. `/api/data/import` and `/api/import/execute` reject bodies > 20 MB (413) and imports > 50 000 transactions (422).
  - **Medium — Verified OAuth DEK envelope** end-to-end in `src/lib/oauth.ts` (authorize → token-exchange → refresh all wrap/unwrap correctly; audit's "unknown" was a wrong path).
  - **Deferred:** `xlsx@0.18.5` has CVE-2023-30533 — fix lives only in SheetJS paid/CDN channel, not npm. `pdf-parser.ts:55` pre-existing type error.

### Changed
- **Premium fintech dark redesign.** Landing page ([src/app/page.tsx](src/app/page.tsx)) rebuilt from the claude.ai/design handoff — sticky blur nav, animated hero chart (scrolling ticker + draw-on SVG line), 6-tile feature grid, 3-step flow, MCP query demo, 4-node zero-knowledge privacy diagram, $0 pricing. Styles scoped under `.fl-landing` in [src/app/landing.css](src/app/landing.css). Scroll reveals via `IntersectionObserver`.
- **App-wide design system refreshed to match.** shadcn CSS tokens in [globals.css](src/app/globals.css) remapped from indigo `hue 265` to amber `#f5a623` primary + teal/coral chart semantics; ink palette `#0b0d10`/`#101317`/`#161a1f`/`#1e242b`. Light mode shares the amber accent. `.text-gradient` retuned to amber→warm-orange.
- **Logo & favicon** updated to the new amber-stroked rounded square with ascending bar-chart path (`#f5a623`). Old indigo/violet "F + chain link" mark removed. See [FinlynqLogo.tsx](src/components/FinlynqLogo.tsx) + [public/favicon.svg](public/favicon.svg).
- **Nav** collapsed 12 per-category icon accents (blue, violet, indigo, emerald, pink, sky, cyan, rose, slate, teal, purple, red) down to a single `text-primary` amber accent on active state. Inactive icons muted. `ACTIVE_ACCENT` constant in [nav.tsx](src/components/nav.tsx).
- **Typography.** Added `Instrument Serif` (italic) via `next/font/google` for display accents in `<em>` on the landing; `--font-instrument-serif` available to any component that wants it.

### Added
- **MCP parity expansion — 41 new tools bringing the surface to 86 HTTP / 80 stdio (2026-04-23).** Plan: [Research/mcp-parity-plan.md](../Research/mcp-parity-plan.md).
  - **Loans (6):** `list_loans`, `add_loan`, `update_loan`, `delete_loan`, `get_loan_amortization`, `get_debt_payoff_plan` (avalanche / snowball comparison)
  - **FX rates (5):** `get_fx_rate`, `list_fx_overrides`, `set_fx_override`, `delete_fx_override`, `convert_amount`
  - **Subscriptions (9):** `list_subscriptions`, `add_subscription`, `update_subscription`, `pause_subscription`, `resume_subscription`, `cancel_subscription`, `delete_subscription`, plus `detect_subscriptions` + `bulk_add_subscriptions` (payee-grouping runs against the per-user in-memory tx cache since SQL GROUP BY on encrypted ciphertext is broken)
  - **Rules (5):** `list_rules`, `update_rule`, `delete_rule`, `reorder_rules`, `test_rule` (dry-run against user's transactions before committing)
  - **Transaction splits (5):** `list_splits`, `add_split`, `update_split`, `delete_split`, `replace_splits` (atomic, validates sum equals parent amount)
  - **Bulk edit (6):** `preview_bulk_update`/`execute_bulk_update`, `preview_bulk_delete`/`execute_bulk_delete`, `preview_bulk_categorize`/`execute_bulk_categorize` — all preview/execute pairs gated by a confirmation token so Claude cannot widen scope between steps
  - **Suggest (1):** `suggest_transaction_details` returns top-N category + tag suggestions using rule matches + historical frequency
  - **File import (4) + upload endpoint:** `POST /api/mcp/upload` (CSV/OFX/QFX, 5 MB cap) → `list_pending_uploads` → `preview_import` → `execute_import` / `cancel_import`. Uploads expire after 24 h; a 30-min cleanup sweep runs from [instrumentation.ts](instrumentation.ts)
- **Foundation primitives supporting the MCP expansion:**
  - [src/lib/mcp/confirmation-token.ts](src/lib/mcp/confirmation-token.ts) — HMAC-SHA256 signed, 5-min TTL, canonical-JSON payload hash; distinct rejection reasons (`payload-mismatch`, `expired`, `user-mismatch`, `operation-mismatch`, `bad-signature`, `malformed`) so tool errors are actionable
  - [src/lib/mcp/user-tx-cache.ts](src/lib/mcp/user-tx-cache.ts) — per-user LRU (10 users × 50k rows) of decrypted transactions; `invalidateUser(userId)` wired into 11 API routes + 6 existing MCP write tools
  - Deploy-generation force-logout: JWT `gen` claim rotates on every deploy, 401s carry `{code: "deploy-reauth-required"}`; [deploy.sh](deploy.sh) installs a systemd drop-in stamping `DEPLOY_GENERATION` before restart
- **Schema:** [drizzle-pg/0003_add_mcp_uploads.sql](drizzle-pg/0003_add_mcp_uploads.sql) adds the `mcp_uploads` table tracking upload lifecycle (pending → previewed → executed / cancelled / expired). Apply per environment with `psql -f` before deploying (same pattern as prior migrations).
- **Public demo account** (`demo@finlynq.com` / `finlynq-demo`) seeded on production with 6 months of realistic sample data (253 transactions across 4 accounts, 4 investment buys, 4 budgets, 3 portfolio holdings, 2 goals) so first-time visitors can explore the app without signing up
- `scripts/seed-demo.ts` — idempotent demo seeder; `npm run seed:demo`
- `deploy/finlynq-demo-reset.{service,timer}` — systemd unit + timer that reseeds the demo account nightly at 03:00 UTC; install script at `deploy/install-demo-reset.sh`
- `login_count` and `last_login_at` columns on the users table; incremented on every successful login (and every MFA-completed login) so demo engagement can be measured with one SQL query
- `/mcp` and `/mcp/*` vanity redirects (308) to `/api/mcp` — shorter URL for the "Connect to Claude" paste flow
- `src/lib/holdings-value.ts` — computes live market value of portfolio holdings grouped by account, with FX conversion to the account's native currency
- Dashboard account balances now include market value of holdings (previously cash-only — brokerage accounts looked artificially negative)
- ETF registry expanded from 19 to ~65 symbols in `src/lib/price-service.ts`: SPY, IVV, QQQ, SCHB, SCHD, VUG, VTV, VYM, DIA, ITOT, SPLG, VO, VB, VXF, IJH, IJR, IWM, sector ETFs (XLK/XLF/XLV/XLE/…), VEA/IEFA/EFA/SCHF, VWO/IEMG/EEM/SCHE, VXUS/VT/ACWI/IXUS, bond ETFs (BND/AGG/TLT/SHY/LQD/HYG/MUB/BNDX), VNQ/VNQI/GLD/IAU/SLV, and Canadian ETFs (VFV/XIC/XIU/ZCN/VGRO/VEQT/VBAL/XEQT/XGRO/XBAL/ZSP/ZEA/XEC/XUU/XEF/VDY/XAW). Fixes common ETFs being miscategorized as "stock"
- Donation banner (shown after 30 days, fully dismissible)
- Support page with donation links
- docker-compose.yml for one-command self-hosting

### Changed
- Pivoted to open source under AGPL v3 with commercial exception
- Replaced Stripe subscription billing with donation model (GitHub Sponsors, Ko-fi)
- Removed SQLite support — PostgreSQL only for simpler, cleaner self-hosting
- Added staging/demo environment (demo.finlynq.com)
- Multi-branch CI/CD pipeline (dev → staging → main)
- Docker image published to ghcr.io/finlynq/finlynq on every release
- CSP `img-src` now allows CoinGecko image domains so crypto icons render in the portfolio page

### Removed
- Stripe billing integration
- SQLite / SQLCipher database adapter
- Trial banner and subscription gating
- Redis and S3/AWS backup sections removed from `.env.example` (no longer applicable)

## [0.1.0] - 2026-04-11

### Added
- Initial open-source release
- Transaction management (import CSV, OFX, PDF, Excel; manual entry; bulk edit; splits)
- Budget tracking with envelope budgeting, rollover, and templates
- Investment portfolio (stocks, ETFs, crypto) with XIRR, benchmarking, Monte Carlo
- Goals tracking with progress visualization
- Loan amortization and debt payoff planner
- FIRE / retirement calculator with Monte Carlo simulation
- Reports: income statement, balance sheet, Sankey cash flow, year-over-year
- Dashboard: net worth, health score, spotlight alerts, weekly recap
- Subscription tracker with auto-detection
- Bill calendar
- AI chat UI with natural language financial queries
- What-if scenario modeling
- MCP server v3 with 27+ tools (read + write, Streamable HTTP + stdio)
- OAuth 2.1 + Dynamic Client Registration for MCP
- PostgreSQL database with Drizzle ORM (22 tables)
- Dark / light / system theme
- Mobile-responsive layout with bottom tab bar
- Self-hosting via Docker or manual Node.js setup
