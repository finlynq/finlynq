# Getting Started

This guide walks you through installing PF, setting up your encrypted database, and importing your first transactions.

## Prerequisites

- **Node.js** 18 or later
- **npm** 9 or later
- A modern browser (Chrome, Firefox, Safari, Edge)

## Installation

```bash
git clone <repo-url> pf-app
cd pf-app
npm install
```

## Start the App

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## First-Time Setup

On first launch the **Setup Wizard** guides you through five steps:

### 1. Create a Passphrase

Choose a strong passphrase (8+ characters). This passphrase encrypts your entire database with AES-256 (SQLCipher). **There is no recovery mechanism** -- if you forget your passphrase, your data cannot be decrypted.

Tips for a strong passphrase:
- Use 12 or more characters
- Mix uppercase, lowercase, numbers, and special characters
- Consider a memorable phrase rather than a single word

### 2. Choose Storage Mode

| Mode | Description |
|------|-------------|
| **Local** | Database stored on your machine. Fast, fully offline. |
| **Cloud Sync** | Database stored in a Google Drive / OneDrive / Dropbox synced folder. Access from multiple devices (single-writer at a time). |

You can change this later in **Settings > Storage**.

### 3. Set Up Accounts

The wizard offers common account presets:

- Checking Account
- Savings Account
- Credit Card
- Investment Account

Select the ones that match your finances, or add custom account names. You can always create more accounts later.

### 4. Import Data (Optional)

Choose one of:

- **Demo data** -- pre-loaded sample transactions to explore the app
- **Import a file** -- upload a CSV, Excel, OFX, or PDF bank statement
- **Skip** -- start with a blank slate and add transactions manually

### 5. Done

You are ready to go. The app redirects to your dashboard.

## Unlocking on Return Visits

Every time you open PF, you will see the **Unlock** screen. Enter your passphrase to decrypt and access your data.

## Importing Transactions

Navigate to the **Import** page (`/import`). PF supports five file formats:

| Format | Details |
|--------|---------|
| **CSV** | Drag-and-drop, preview with column mapping, deduplication |
| **Excel** (.xlsx/.xls) | Visual column mapper, preview before import |
| **PDF** | Bank statement table extraction, assign to account |
| **OFX/QFX** | Bank statement format with fitId-based deduplication |
| **Email** | Generate an import email address, forward bank statements to it |

All imports run through a **deduplication engine** that fingerprints transactions by date, account, amount, and payee to prevent duplicates.

## Creating Your First Budget

1. Go to **Budgets** (`/budgets`)
2. Click **Add Budget**
3. Select a category (e.g., Groceries, Dining Out)
4. Set a monthly amount
5. PF tracks your spending against the budget automatically

## Connecting an AI Assistant (Optional)

PF includes an MCP server that lets AI assistants (Claude, ChatGPT, or any MCP-compatible tool) query and manage your financial data.

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

The MCP server exposes 27 tools (21 read, 6 write) for querying accounts, transactions, budgets, portfolio, and more.

## Next Steps

- **Dashboard** (`/dashboard`) -- overview of net worth, health score, spending insights
- **Reports** (`/reports`) -- income statement, balance sheet, Sankey cash flow
- **Goals** (`/goals`) -- set and track financial targets
- **Settings** (`/settings`) -- manage categories, security, storage, and data export
- [FAQ](./faq.md) -- common questions and answers
- [Mobile Setup](./mobile-setup.md) -- connect the React Native mobile app
