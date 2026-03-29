# PF -- Personal Finance App

A local-first, encrypted personal finance app with an MCP server for AI assistant integration. Track income, expenses, budgets, investments, loans, and goals -- then query your financial data from Claude, ChatGPT, or any MCP-compatible AI.

All data is encrypted at rest with AES-256 (SQLCipher). Your passphrase never leaves your device.

## Quick Start

```bash
npm install
npm run dev          # Start at http://localhost:3000
```

On first launch, the **Setup Wizard** will guide you through:
1. Setting a passphrase (AES-256 encryption key)
2. Choosing storage mode (local or cloud sync)
3. Migrating existing data (if any)

Every subsequent launch requires your passphrase to unlock the database.

### Import Your Data

Go to `/import` in the app. Three import methods are available:

**Upload Files** (drag-and-drop)
- **CSV**: Drop a transaction CSV file, preview with deduplication, then confirm
- **Excel (.xlsx/.xls)**: Upload a spreadsheet, map columns to transaction fields visually, preview, and import
- **PDF**: Upload a bank statement, transactions are extracted via table detection, assign an account, then import
- **OFX/QFX**: Upload bank statements in OFX/QFX format with fitId-based deduplication

**Email Import**
1. Generate a unique import email address in the Email Import tab
2. Forward bank statements or attach CSV/Excel/PDF files to that address
3. Attachments are auto-parsed and imported with duplicate detection

**Structured CSV** (initial setup)
1. Upload CSV files in order: Accounts -> Categories -> Portfolio -> Transactions
2. CSV format matches the files in `/Data/`

All import methods include a **deduplication engine** that fingerprints transactions (date + account + amount + payee) to prevent importing the same transaction twice.

### MCP Server

Add to your Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pf-finance": {
      "command": "npx",
      "args": ["tsx", "<path-to>/pf-app/mcp-server/index.ts"],
      "env": {
        "PF_PASSPHRASE": "<your passphrase>"
      }
    }
  }
}
```

The MCP server provides 27 tools (21 read, 6 write) for querying and managing your financial data through AI. The `PF_PASSPHRASE` environment variable is required to unlock the encrypted database.

### Cloud Sync (Optional)

Sync your encrypted database across devices using your own cloud drive:

1. Go to **Settings > Storage** and set the database path to a Google Drive / OneDrive / Dropbox synced folder
2. Switch mode to **Cloud Sync**
3. Only one device can write at a time (single-writer lock with heartbeat)
4. Other devices open in read-only mode automatically

Zero infrastructure cost -- the sync is handled entirely by your cloud drive provider.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) + TypeScript |
| Database | SQLite (better-sqlite3-multiple-ciphers) + Drizzle ORM + SQLCipher AES-256 |
| UI | Tailwind CSS + shadcn/ui v4 |
| Charts | Recharts |
| Animations | Framer Motion |
| Theming | next-themes (dark/light/system) |
| MCP | @modelcontextprotocol/sdk |
| Prices | Yahoo Finance API (free, no key) |

## Pages (19)

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/dashboard` | Net worth hero with spotlight glow, health score, sparklines, weekly recap, spotlight alerts, insights |
| Accounts | `/accounts` | All accounts grouped by type with balances |
| Account Detail | `/accounts/[id]` | Individual account view |
| Transactions | `/transactions` | Full transaction list with filters, CRUD, advanced fields |
| Budgets | `/budgets` | Monthly budget management with progress bars |
| Portfolio | `/portfolio` | Investment holdings, allocation charts |
| Loans | `/loans` | Loan tracker, amortization schedules, what-if scenarios |
| Goals | `/goals` | Financial goals with progress tracking |
| Reports | `/reports` | Income statement, balance sheet, Sankey cash flow, YoY comparisons |
| Tax | `/tax` | TFSA/RRSP/RESP room, RRSP vs TFSA calculator |
| Chat | `/chat` | AI chat UI with natural language financial queries |
| Subscriptions | `/subscriptions` | Recurring subscription tracker with auto-detection |
| Calendar | `/calendar` | Monthly bill calendar with income/expense indicators |
| Scenarios | `/scenarios` | What-if modeling: home purchase, savings, debt payoff, income change |
| FIRE | `/fire` | FIRE calculator with projections, Coast FIRE, Monte Carlo simulation |
| Import | `/import` | Multi-format import (CSV/Excel/PDF/OFX/Email) with deduplication |
| API Docs | `/api-docs` | Developer API documentation |
| Settings | `/settings` | Security, storage, sync status, category management, data export |

## API Routes (44)

44 API routes under `/api/`: accounts, age-of-money, auth/unlock, budget-templates, budgets, categories, chat, dashboard, data, fire, fire/monte-carlo, forecast, fx, goals, health-score, import, import/backfill, import/email-config, import/email-webhook, import/excel-map, import/execute, import/preview, insights, loans, notifications, portfolio, portfolio/benchmarks, portfolio/crypto, prices, rebalancing, recap, recurring, reports, reports/yoy, rules, scenarios, settings/storage, settings/sync-status, snapshots, spotlight, subscriptions, tax, transactions, transactions/suggest.

## Features

- **Premium dark mode** — near-black OKLCH palette, 3-layer depth system, noise texture, ambient glow
- **Polished UI** — glassmorphism tooltips, mouse-following spotlight, card hover elevation, gradient borders, animated theme toggle
- **Collapsible sidebar** (desktop) + bottom tab bar (mobile) with glowing active indicator
- **Financial health score** (0-100 composite from 6 components) with animated ring and per-component progress bars
- **Animated dashboard** — time-based greeting, count-up numbers, sparklines, staggered fade-in, chart line glow
- **Dashboard spotlight** — actionable alerts with severity colors and dismissible cards
- **Weekly recap** — collapsible spending summary with top categories bar chart
- **Sankey cash flow** diagram (income sources → expense categories)
- **FIRE calculator** with Coast FIRE and sensitivity analysis
- **Scenario planner** for home purchase, savings, debt, income changes
- **Subscription tracker** with auto-detection from transaction patterns
- **Bill calendar** with monthly grid view
- **Year-over-year** spending comparisons
- **Form validation** with inline error messages
- **Category management** (add, edit, delete via settings)
- **Encryption at rest** — SQLCipher AES-256, passphrase-based setup wizard, re-key support
- **HMR-safe auth** — connection state persists across hot reloads, 423 fetch interceptor auto-locks UI
- **Unencrypted-to-encrypted migration** — seamless in-place migration with FK integrity verification
- **Auto-categorization** — rules engine with payee-based suggestions
- **OFX/QFX import** — bank statement import with fitId deduplication
- **AI chat** — natural language queries over financial data with inline chart visualization
- **Monte Carlo simulation** — retirement projections with randomized market scenarios
- And more — see [FEATURES.md](/FEATURES.md)

## Mobile App

PF includes a React Native (Expo) mobile app in the `mobile/` directory. It connects to the PF web server and provides Dashboard, Transactions, Import, Budgets, and Settings screens on iOS and Android.

```bash
cd mobile
npm install
npx expo start
```

See the [Mobile Setup Guide](docs/mobile-setup.md) for full instructions on connecting to your server.

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Installation, first-time setup, importing data, creating budgets |
| [FAQ](docs/faq.md) | Common questions about security, privacy, syncing, and troubleshooting |
| [Mobile Setup](docs/mobile-setup.md) | How to connect the React Native mobile app to your PF server |

## Database

SQLite with 18 tables. Database file (`pf.db`) is encrypted with AES-256 (SQLCipher) and gitignored.

```bash
npm run db:push               # Apply schema (unencrypted dev DB only)
npm run db:generate           # Generate migration files
PF_PASSPHRASE="..." npm run db:push:encrypted  # Apply schema to encrypted DB
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run build:mcp` | Build MCP server |
| `npm run db:push` | Push schema to database (unencrypted) |
| `npm run db:push:encrypted` | Push schema to encrypted database |
| `npm run db:generate` | Generate Drizzle migrations |

## Project Structure

```
src/
  app/           # 19 pages and 44 API routes
  components/    # Nav, theme, unlock gate, setup wizard, sparkline, sankey, shadcn/ui
  db/            # Schema (18 tables), encrypted connection, sync, migration
    connection.ts      # HMR-safe encrypted connection with globalThis persistence
    migration.ts       # Unencrypted-to-encrypted DB migration
    sync.ts            # Single-writer lock for cloud sync
    sync-checks.ts     # File integrity and conflict detection
  lib/           # Business logic
    csv-parser.ts        # CSV import
    ofx-parser.ts        # OFX/QFX bank statement parser
    import-hash.ts       # Deduplication engine (SHA-256 + fitId)
    import-pipeline.ts   # Unified import pipeline (CSV/Excel/PDF/OFX)
    pdf-parser.ts        # PDF bank statement parser
    excel-parser.ts      # Excel parser with column mapping
    auto-categorize.ts   # Transaction rules engine + payee suggestions
    chat-engine.ts       # Natural language query parser for AI chat
    monte-carlo.ts       # Monte Carlo retirement simulation
    currency.ts          # Formatting helpers
    queries.ts           # DB queries
    chart-colors.ts      # Shared chart color palette
    loan-calculator.ts   # Amortization, debt payoff
    investment-returns.ts # XIRR, TWR
    price-service.ts     # Yahoo Finance, ETF decomposition
    crypto-service.ts    # CoinGecko API for crypto prices
    fx-service.ts        # FX rates, currency conversion
    recurring-detector.ts # Recurring detection, cash flow forecast
    spending-insights.ts # Anomalies, trends, merchants
    tax-optimizer.ts     # Canadian tax optimization
shared/
  config.ts      # Config file management (pf-config.json)
  crypto.ts      # Key derivation (PBKDF2) + salt generation
mcp-server/
  index.ts       # MCP server v2.3 (27 tools: 21 read, 6 write)
```
