# Changelog

All notable changes to Finlynq are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

## [Unreleased]

### Changed
- **Premium fintech dark redesign.** Landing page ([src/app/page.tsx](src/app/page.tsx)) rebuilt from the claude.ai/design handoff — sticky blur nav, animated hero chart (scrolling ticker + draw-on SVG line), 6-tile feature grid, 3-step flow, MCP query demo, 4-node zero-knowledge privacy diagram, $0 pricing. Styles scoped under `.fl-landing` in [src/app/landing.css](src/app/landing.css). Scroll reveals via `IntersectionObserver`.
- **App-wide design system refreshed to match.** shadcn CSS tokens in [globals.css](src/app/globals.css) remapped from indigo `hue 265` to amber `#f5a623` primary + teal/coral chart semantics; ink palette `#0b0d10`/`#101317`/`#161a1f`/`#1e242b`. Light mode shares the amber accent. `.text-gradient` retuned to amber→warm-orange.
- **Logo & favicon** updated to the new amber-stroked rounded square with ascending bar-chart path (`#f5a623`). Old indigo/violet "F + chain link" mark removed. See [FinlynqLogo.tsx](src/components/FinlynqLogo.tsx) + [public/favicon.svg](public/favicon.svg).
- **Nav** collapsed 12 per-category icon accents (blue, violet, indigo, emerald, pink, sky, cyan, rose, slate, teal, purple, red) down to a single `text-primary` amber accent on active state. Inactive icons muted. `ACTIVE_ACCENT` constant in [nav.tsx](src/components/nav.tsx).
- **Typography.** Added `Instrument Serif` (italic) via `next/font/google` for display accents in `<em>` on the landing; `--font-instrument-serif` available to any component that wants it.

### Added
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
