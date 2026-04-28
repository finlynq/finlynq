# Finlynq — Personal Finance App

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

An open-source personal finance web app with a first-party MCP server. Track income, expenses, budgets, investments, loans, and goals — then query your financial data from Claude, Cursor, Windsurf, or any MCP-compatible AI assistant.

**"Track your money here, analyze it anywhere."**

> **License:** AGPL v3 · **Repo:** [github.com/finlynq/finlynq](https://github.com/finlynq/finlynq) · **Support:** [GitHub Sponsors](https://github.com/sponsors/finlynq) · [Ko-fi](https://ko-fi.com/finlynq)

---

## Try the Demo

No signup needed — a public demo account is always available on production:

- **URL:** [finlynq.com](https://finlynq.com)
- **Username:** `demo` (or email `demo@finlynq.com` — login accepts either)
- **Password:** `finlynq-demo`

Comes preloaded with 6 months of sample transactions, accounts, budgets, investments, and goals. Data resets nightly at 03:00 UTC, so feel free to change anything.

**Connect it to Claude:** in Claude → Customize → Connectors → "+" and paste `https://finlynq.com/mcp`. OAuth handles the rest — no config file.

---

## Running Locally (Windows)

### Prerequisites

- [Node.js 18+](https://nodejs.org/)
- PostgreSQL 14+ installed and running (the Windows service `postgresql-x64-*` should start automatically)
- Git

### 1. Clone & install

```bash
git clone https://github.com/finlynq/finlynq.git
cd finlynq/pf-app
npm install
```

### 2. Create your `.env` file

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Minimum required values for local dev:

```env
NODE_ENV=development
APP_URL=http://localhost:3000
DATABASE_URL=postgres://<user>:<password>@localhost:5432/finlynq
PF_JWT_SECRET=<run: openssl rand -hex 32>
```

> **Windows tip:** If you know a working PostgreSQL user from another project (e.g. `epm:epm_dev_password`), use those credentials — you just need a user with `CREATEDB` privilege.

### 3. Create the database

Open PowerShell in the `pf-app` directory and run:

```powershell
# Set your psql path (adjust version number as needed)
$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
$env:PGPASSWORD = "<your-db-password>"

# Create the finlynq database (connect to an existing DB first, e.g. epm_agent_v3 or postgres)
"CREATE DATABASE finlynq;" | & $psql -U <your-user> -h 127.0.0.1 -p 5432 -d <existing-db>
```

Or open **pgAdmin 4** and run:
```sql
CREATE DATABASE finlynq;
```

### 4. Push the schema

```powershell
powershell -ExecutionPolicy Bypass -Command "npm run db:push:pg"
```

> **Note:** On Windows, running `npm` directly in PowerShell may fail with a script execution policy error. Always prefix with `powershell -ExecutionPolicy Bypass -Command "..."` or run from Git Bash / Command Prompt.

### 5. Start the dev server

```powershell
powershell -ExecutionPolicy Bypass -Command "npm run dev"
```

App will be available at **http://localhost:3000**

### 6. Create your account

Navigate to **http://localhost:3000/cloud** and click **Create Account**. Pick a username (3–254 chars, lowercase letters / digits / `. @ + _ -`) — email is optional.

> Heads up: Finlynq encrypts everything with your password. There's no recovery key — if you forget your password, all data is wiped on reset. Adding an email lets you trigger a reset; without one you have no way to regain access.

---

## Running Locally (macOS / Linux)

### Prerequisites

- Node.js 18+
- PostgreSQL 14+ (`brew install postgresql@16` on macOS, or `apt install postgresql` on Ubuntu)

### Steps

```bash
# Clone
git clone https://github.com/finlynq/finlynq.git
cd finlynq/pf-app

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL and PF_JWT_SECRET

# Create the database (assuming default postgres superuser)
psql -U postgres -c "CREATE DATABASE finlynq;"

# Push schema
npm run db:push:pg

# Start dev server
npm run dev
```

App will be available at **http://localhost:3000**

---

## Docker (Self-hosted)

The easiest way to run Finlynq with zero manual setup:

```bash
git clone https://github.com/finlynq/finlynq.git
cd finlynq/pf-app

# Copy and configure env
cp .env.example .env
# Edit .env — at minimum set PF_JWT_SECRET

# Start app + PostgreSQL
docker compose up -d
```

App will be available at **http://localhost:3000**

The Docker Compose file starts both the app and a PostgreSQL 16 container. Data is persisted in a named volume (`postgres_data`).

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string — activates managed mode |
| `PF_JWT_SECRET` | ✅ | 64-char hex secret for JWT signing (`openssl rand -hex 32`) |
| `NODE_ENV` | | `development` or `production` |
| `APP_URL` | | Public URL of the app (used in email links) |
| `PF_SMTP_HOST` | | SMTP host for password reset emails (leave blank to disable) |
| `NEXT_PUBLIC_GITHUB_REPO` | | Link to your fork (shown in donation banner) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) + TypeScript |
| Database | PostgreSQL 16 + Drizzle ORM (22 tables) |
| UI | Tailwind CSS + shadcn/ui v4 (`@base-ui/react`) |
| Charts | Recharts + custom Sankey SVG |
| Animations | Framer Motion |
| Theming | next-themes (dark/light/system) |
| MCP | @modelcontextprotocol/sdk (86 tools, Streamable HTTP + stdio) |
| Auth | OAuth 2.1 + DCR (MCP), session-cookie + Bearer API key (REST) |
| Prices | Yahoo Finance API + CoinGecko (crypto) — both free, no key needed |

---

## MCP Server

Finlynq includes a first-party MCP server with 86 tools for querying and managing your financial data from AI assistants — accounts, transactions, budgets, goals, loans, portfolio, subscriptions, FX rates, rules, splits, bulk edits, and CSV/OFX file imports.

### Connect via Claude Desktop (stdio)

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "finlynq": {
      "command": "npx",
      "args": ["tsx", "/path/to/pf-app/mcp-server/index.ts"],
      "env": {
        "DATABASE_URL": "postgres://epm:epm_dev_password@localhost:5432/finlynq"
      }
    }
  }
}
```

### Connect via Claude Web / Mobile (HTTP)

1. Go to **Settings > API Keys** in the app and generate a key (prefix `pf_`)
2. Add the MCP server URL in your AI assistant: `https://your-domain.com/api/mcp`
3. Use Bearer token auth with your generated key

The `.well-known/mcp.json` server card at the root enables auto-discovery.

---

## Import Your Data

Go to `/import` in the app. Supported formats:

| Format | Notes |
|--------|-------|
| CSV | Preview with column mapping + deduplication |
| Excel (.xlsx/.xls) | Visual column mapper |
| PDF | Bank statement table extraction |
| OFX / QFX | fitId-based deduplication |

All imports include a deduplication engine that fingerprints transactions to prevent duplicates.

---

## Pages

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/dashboard` | Net worth, health score, sparklines, weekly recap, spotlight alerts |
| Transactions | `/transactions` | Full list with filters, bulk edit, splits |
| Budgets | `/budgets` | Monthly budgets with envelope-style rollover |
| Goals | `/goals` | Financial goals with progress tracking |
| Accounts | `/accounts` | All accounts grouped by type |
| Portfolio | `/portfolio` | Holdings, allocation, benchmarking, crypto |
| Loans | `/loans` | Amortization schedules, payoff scenarios |
| Reports | `/reports` | Income statement, balance sheet, Sankey, YoY |
| Tax | `/tax` | TFSA/RRSP/RESP room + RRSP vs TFSA calculator |
| Chat | `/chat` | Natural language financial queries with inline charts |
| Subscriptions | `/subscriptions` | Recurring subscription tracker with auto-detection |
| Calendar | `/calendar` | Monthly bill calendar |
| Scenarios | `/scenarios` | What-if modeling (home, savings, debt, income) |
| FIRE | `/fire` | FIRE/retirement calculator + Monte Carlo simulation |
| Import | `/import` | Multi-format import |
| MCP Guide | `/mcp-guide` | Setup guide (Claude Desktop / Web / Mobile / API) |
| API Docs | `/api-docs` | Developer API documentation |
| Settings | `/settings` | Categories, API keys, backup/restore |

---

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server at http://localhost:3000 |
| `npm run build` | Production build |
| `npm run build:mcp` | Build MCP server |
| `npm run db:push:pg` | Push schema to PostgreSQL |
| `npm run db:generate:pg` | Generate Drizzle PG migrations |

---

## Project Structure

```
pf-app/
  src/
    app/               # 21 pages + 50+ API routes
    components/        # Nav, unlock gate, setup wizard, sparkline, sankey, shadcn/ui
    db/                # Schema (22 tables), PostgreSQL adapter, Drizzle ORM
    lib/               # Business logic (parsers, calculators, AI chat engine, MCP tools)
  mcp-server/          # MCP server v3 (86 tools, stdio + Streamable HTTP)
  drizzle-pg/          # PostgreSQL migration files
  mobile/              # React Native (Expo) mobile app
  docs/                # Getting started, FAQ, mobile setup guide
```

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

- Bug reports → [GitHub Issues](https://github.com/finlynq/finlynq/issues)
- Feature requests → [GitHub Discussions](https://github.com/finlynq/finlynq/discussions)
- Pull requests → fork, branch, PR against `main`

---

## Support the Project

Finlynq is free and open-source (AGPL v3). If it's useful to you, consider supporting development:

- ⭐ Star the repo
- 💛 [GitHub Sponsors](https://github.com/sponsors/finlynq)
- ☕ [Ko-fi](https://ko-fi.com/finlynq)
