# Getting Started

Finlynq is an open-source personal finance app for tracking income, expenses, budgets, investments, loans, and goals — with a built-in AI assistant and an MCP server so you can also query and manage your money from Claude, Cursor, or any MCP-compatible client. This guide gets you from zero to your first imported transactions.

There are two ways to run Finlynq:

- **Hosted (finlynq.com/cloud)** — we run the server; you just sign in. Nothing to install.
- **Self-hosted** — you run the app and a PostgreSQL database on your own machine or VPS.

Both run the exact same code and have the same features and the same encryption. The only difference is who operates the server.

## Option A — Use the hosted app (fastest)

1. Go to **[finlynq.com/cloud](https://finlynq.com/cloud)**.
2. Click **Create Account** and fill in the form (see [Creating your account](#creating-your-account) below).
3. You land on your dashboard. Add accounts, import transactions, and set budgets.

That's it — there's nothing to install and no paid tier.

### Try the live demo first

Want to look around before signing up? Open **[finlynq.com/cloud?demo=1](https://finlynq.com/cloud?demo=1)** — the demo credentials are pre-filled, so you just click **Sign In**. The demo account is read-friendly and **resets every night**, so feel free to explore.

## Option B — Self-host

### Prerequisites

- **Node.js** 20 or later
- **PostgreSQL** 14 or later (a database and a user Finlynq can connect to)
- **npm** 9 or later
- A modern browser (Chrome, Firefox, Safari, Edge)

### Install

```bash
git clone https://github.com/finlynq/finlynq.git
cd finlynq/pf-app
npm install
```

### Configure

Finlynq connects to PostgreSQL and needs a few secrets for encryption and sessions. Create a `.env.local` file in `pf-app/`:

```bash
# PostgreSQL connection string
DATABASE_URL=postgresql://finlynq:password@localhost:5432/finlynq

# Secrets — generate long random values (≥ 32 characters each)
PF_JWT_SECRET=<random 32+ char string>     # signs your login session
PF_PEPPER=<random 32+ char string>         # hardens password hashing
PF_STAGING_KEY=<random 32+ char string>    # protects email-staged imports
```

You can generate a strong random value with `openssl rand -base64 48`. Keep these secrets safe and consistent — if `PF_PEPPER` changes, existing logins stop working.

Apply the database schema, then start the app:

```bash
npm run db:push     # create/update tables in your database
npm run dev         # start the dev server at http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) and create your account.

For production deployment (systemd, HTTPS, automated migrations, backups), see **DEPLOY.md** in the repository.

## Creating your account

Finlynq accounts use a **username and password**. Email is optional.

| Field | Required? | Notes |
|-------|-----------|-------|
| **Display name** | Optional | A friendly name shown in the UI. |
| **Username** | Required | 3–254 characters: lowercase letters, digits, and `. @ + _ -`. An email-shaped handle (e.g. `cool-dragon@madeup.fake`) is allowed if you'd rather not expose a real identity. |
| **Email** | Optional | Used **only** for password reset. Leave it blank for a fully zero-knowledge account — but then a forgotten password can't be reset at all. |
| **Password** | Required | At least **12 characters**. Mix at least three of: lowercase, uppercase, digits, symbols — or use a passphrase of 16+ characters. Very common passwords are rejected. |

To sign in later, use the **Sign In** tab and enter either your username **or** your email, plus your password.

### Important: your password protects your data

Finlynq encrypts your sensitive fields (payees, notes, account and category names, and more) with a key derived from your password. That key never leaves your session — the operator can't see it.

- **If you set an email**, you can reset your *login* if you forget your password — but the previously encrypted content **cannot be recovered** and will show as `—`. Your amounts, dates, and balances are unaffected.
- **If you skipped email**, there is no reset at all. A forgotten password means the data is gone.

**Store your password in a password manager.** See the [FAQ](./faq.md#security--privacy) for the full security model.

### Two-factor authentication (optional)

You can enable an authenticator-app (TOTP) second factor in **Settings → Account**. Once on, sign-in asks for a 6-digit code after your password.

## Adding accounts

From **Accounts** (`/accounts`), add the accounts that match your finances — checking, savings, credit cards, investment/brokerage accounts, loans, and so on. Each account has its own currency, so a USD card and a CAD chequing account live side by side and reports convert between them automatically.

## Importing transactions

Finlynq imports from five sources:

| Source | Details |
|--------|---------|
| **CSV** | Upload, map columns to fields, preview, and confirm. |
| **Excel** (.xlsx / .xls) | Visual column mapper with a preview before import. |
| **OFX / QFX** | Standard bank-statement format. |
| **PDF** | Statement table extraction (works best on common layouts). |
| **Email** | Each account gets a private `import-<code>@finlynq.com` address — forward your bank's statement emails and the attachments are parsed automatically. |

Start an upload from the **Import** page (`/import`), or use the **Upload** button and let your AI assistant take it from there.

Every import lands in a **review queue** before anything is committed. You preview the parsed rows, fix payees/categories/notes, flag transfers between your own accounts, and only then approve them into your ledger. A **deduplication engine** fingerprints each incoming row (by date, account, amount, and payee) so re-importing the same file doesn't create duplicates.

> Direct bank-feed connections (Plaid / SnapTrade and similar) are on the roadmap but not available yet — for now, use file or email import.

## Creating your first budget

1. Go to **Budgets** (`/budgets`).
2. Click **Add Budget**.
3. Pick a category (e.g. Groceries, Dining Out).
4. Set a monthly amount.
5. Finlynq tracks spending in that category against the budget, with progress bars showing how much remains.

## Connecting an AI assistant (optional)

Finlynq's standout feature is its **MCP server**: it lets AI assistants query and manage your finances in natural language — "how much did I spend on groceries last month?", "record a $45 coffee from yesterday", "show an avalanche debt-payoff plan". The server exposes **94 tools over HTTP and 87 over stdio** (server v3.1.0) covering accounts, transactions, transfers, budgets, portfolio holdings, goals, loans, subscriptions, rules, and imports.

You don't even need an external client to start — the web UI ships a **built-in AI chat** (`/chat`) that runs over the same tools.

To connect an external client, the easiest path is **Claude on the web or mobile**:

1. In Claude, open **Settings → Integrations → Add custom integration** (or the **+** in the chat input).
2. Set the **Server URL** to `https://finlynq.com/api/mcp` (or your self-hosted URL + `/api/mcp`).
3. Click **Add**, then **Connect**, and authorize when Finlynq prompts you. OAuth handles authentication — no keys to paste.

For desktop/CLI clients (Claude Desktop, Cursor, Windsurf, Cline), generate an API key in **Settings → Account → API Key** (shown once — store it safely) and point the client at `/api/mcp` with an `Authorization: Bearer <your-key>` header:

```json
{
  "mcpServers": {
    "finlynq": {
      "type": "streamable-http",
      "url": "https://finlynq.com/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

Self-hosters can also run the MCP server locally over stdio (`npm run build:mcp`, then point the client at the built file with `DATABASE_URL` and `PF_USER_ID` set). Destructive actions (deletes, bulk edits) always use a preview-then-confirm step so the assistant can't change anything without showing you first.

The in-app **[Connect Your AI guide](https://finlynq.com/mcp-guide)** has copy-paste setup for every client, example prompts, and troubleshooting.

## Next steps

- **Dashboard** (`/dashboard`) — net worth, financial-health score, and spending insights at a glance.
- **Reports** (`/reports`) — income statement, balance sheet, and a Sankey cash-flow view.
- **Portfolio** (`/portfolio`) — holdings, lot-tracked cost basis, and realized gains.
- **Goals** (`/goals`) — set and track savings targets.
- **Settings** (`/settings`) — categories, rules, security, and data export.
- [FAQ](./faq.md) — common questions about hosting, security, imports, and the AI assistant.
- [Mobile Setup](./mobile-setup.md) — connect the companion mobile app.
