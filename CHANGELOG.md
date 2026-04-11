# Changelog

All notable changes to Finlynq are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

## [Unreleased]

### Changed
- Pivoted to open source under AGPL v3 with commercial exception
- Replaced Stripe subscription billing with donation model (GitHub Sponsors, Ko-fi)
- Removed SQLite support — PostgreSQL only for simpler, cleaner self-hosting
- Added staging/demo environment (demo.finlynq.com)
- Multi-branch CI/CD pipeline (dev → staging → main)
- Docker image published to ghcr.io/finlynq/finlynq on every release

### Removed
- Stripe billing integration
- SQLite / SQLCipher database adapter
- Trial banner and subscription gating

### Added
- Donation banner (shown after 30 days, fully dismissible)
- Support page with donation links
- docker-compose.yml for one-command self-hosting

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
