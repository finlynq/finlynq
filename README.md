# PF -- Personal Finance App

A local-first personal finance app with an MCP server for AI assistant integration. Track income, expenses, budgets, investments, loans, and goals -- then query your financial data from Claude, ChatGPT, or any MCP-compatible AI.

## Quick Start

```bash
npm install
npm run db:push     # Create database tables
npm run dev          # Start at http://localhost:3000
```

### Import Your Data

1. Go to `/import` in the app
2. Upload CSV files in order: Accounts -> Categories -> Portfolio -> Transactions
3. CSV format matches the files in `/Data/`

### MCP Server

Build and configure the MCP server for AI assistant access:

```bash
npm run build:mcp
```

Add to your Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pf-finance": {
      "command": "node",
      "args": ["<path-to>/pf-app/mcp-server/dist/index.js"]
    }
  }
}
```

The MCP server provides 15 tools (11 read, 4 write) for querying and managing your financial data through AI.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) + TypeScript |
| Database | SQLite (better-sqlite3) + Drizzle ORM |
| UI | Tailwind CSS + shadcn/ui v4 |
| Charts | Recharts |
| MCP | @modelcontextprotocol/sdk |
| Prices | Yahoo Finance API (free, no key) |

## Pages

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/dashboard` | Net worth, income vs expenses, spending breakdown, insights |
| Accounts | `/accounts` | All accounts grouped by type with balances |
| Transactions | `/transactions` | Full transaction list with filters and CRUD |
| Budgets | `/budgets` | Monthly budget management with progress bars |
| Portfolio | `/portfolio` | Investment holdings, allocation charts |
| Loans | `/loans` | Loan tracker, amortization schedules, what-if scenarios |
| Goals | `/goals` | Financial goals with progress tracking |
| Reports | `/reports` | Income statement, balance sheet, CSV export |
| Tax | `/tax` | TFSA/RRSP/RESP room, RRSP vs TFSA calculator |
| Import | `/import` | CSV import wizard |
| Settings | `/settings` | Data export, MCP config |

## API Routes

19 API routes under `/api/`: accounts, transactions, categories, budgets, portfolio, dashboard, import, loans, goals, snapshots, prices, fx, recurring, forecast, insights, tax, reports, notifications, rebalancing.

## Database

SQLite with 15 tables. Database file (`pf.db`) is gitignored and stays on your machine.

```bash
npm run db:push      # Apply schema to database
npm run db:generate  # Generate migration files
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run build:mcp` | Build MCP server |
| `npm run db:push` | Push schema to database |
| `npm run db:generate` | Generate Drizzle migrations |

## Project Structure

```
src/
  app/           # Pages and API routes
  components/    # UI components (nav, shadcn/ui)
  db/            # Schema (15 tables) and connection
  lib/           # Business logic
    csv-parser.ts        # CSV import
    currency.ts          # Formatting helpers
    queries.ts           # DB queries
    loan-calculator.ts   # Amortization, debt payoff
    investment-returns.ts # XIRR, TWR
    price-service.ts     # Yahoo Finance, ETF decomposition
    fx-service.ts        # FX rates, currency conversion
    recurring-detector.ts # Recurring detection, cash flow forecast
    spending-insights.ts # Anomalies, trends, merchants
    tax-optimizer.ts     # Canadian tax optimization
mcp-server/
  index.ts       # MCP server (15 tools)
```
