# Frequently Asked Questions

## Security & Privacy

### Is my data safe?

Yes. PF encrypts your entire database with **AES-256 (SQLCipher)**. Your passphrase is used to derive the encryption key and never leaves your device. Without the passphrase, the database file is unreadable.

### What happens if I forget my passphrase?

**Your data cannot be recovered.** There is no password reset, no master key, and no backdoor. This is by design -- your privacy is the top priority. We strongly recommend storing your passphrase in a password manager.

### Does PF send my financial data anywhere?

No. In **Local** mode, all data stays on your machine. In **Cloud Sync** mode, the encrypted database file is stored in your own cloud drive (Google Drive, OneDrive, or Dropbox) -- PF never operates a server that holds your data.

### Can I change my passphrase?

Yes. Go to **Settings > Security** to re-key your database with a new passphrase.

## AI & LLM Integration

### How do I connect an AI assistant?

PF includes an MCP (Model Context Protocol) server. You configure your AI tool (Claude Desktop, ChatGPT, or any MCP-compatible client) to connect to PF's MCP server. See the [Getting Started guide](./getting-started.md#connecting-an-ai-assistant-optional) for setup instructions.

### Does PF have a built-in AI?

No. PF follows a "bring your own AI" approach. You connect your own LLM through the MCP server. This means your data is only shared with the AI provider you choose, and only when you explicitly connect it.

### What can the AI assistant do?

The MCP server provides 27 tools (21 read, 6 write) that let your AI assistant query accounts, transactions, budgets, portfolio data, and more. It can also create transactions, update budgets, and perform other write operations.

## Data Import

### What file formats can I import?

PF supports five import methods:

| Format | Description |
|--------|-------------|
| **CSV** | Standard comma-separated files with column mapping |
| **Excel** (.xlsx/.xls) | Spreadsheets with visual column mapper |
| **PDF** | Bank statements with automatic table extraction |
| **OFX/QFX** | Standard bank statement format |
| **Email** | Forward bank statements to your per-user `import-<uuid>@finlynq.com` address. Rows land in a review queue at `/import/pending` — nothing is imported until you approve. See [resend-inbound-setup.md](./resend-inbound-setup.md) for the ops side. |

### Will importing the same file create duplicates?

No. PF has a built-in **deduplication engine** that fingerprints transactions by date, account, amount, and payee. Duplicate transactions are detected and skipped automatically.

### Can I connect directly to my bank?

Not in v1. Direct bank connections (via Plaid or Open Banking) are planned for a future release. For now, use file-based import by downloading statements from your bank's website.

## Syncing & Multi-Device

### How do I access PF from multiple devices?

Two options:

1. **Cloud Sync** -- Store your encrypted database in a Google Drive, OneDrive, or Dropbox synced folder. Only one device can write at a time (single-writer lock); others open in read-only mode.
2. **Mobile app** -- Run the PF web server on your computer and connect the React Native mobile app over your local network, or use a hosted deployment.

See the [Mobile Setup guide](./mobile-setup.md) for details on connecting the mobile app.

### Can two people edit at the same time?

No. PF uses a single-writer lock to prevent conflicts. When one device has write access, other devices open in read-only mode. The lock is released when the writing device closes PF or after a heartbeat timeout.

## Budgets & Tracking

### How do budgets work?

Create a budget by picking a category and setting a monthly limit. PF automatically tracks your spending in that category against the budget. Progress bars show how much you have spent and how much remains.

### Can I use multiple currencies?

Yes. PF supports multi-currency accounts with automatic FX rate fetching. You can set a currency per account and view reports in your base currency with converted amounts.

## Mobile App

### Is there a mobile app?

Yes. PF has a React Native (Expo) mobile app that connects to your PF web server. It includes Dashboard, Transactions, Import, Budgets, and Settings screens. See the [Mobile Setup guide](./mobile-setup.md).

### Do I need to run the web app for mobile to work?

Yes. The mobile app connects to the PF Next.js backend (running on your computer or a hosted server). The web server must be running for the mobile app to access your data.

## Troubleshooting

### The app shows "Database locked"

Another device or process has the write lock. Close PF on other devices, or wait for the heartbeat timeout (usually a few minutes). You can also check lock status in **Settings > Storage**.

### Import failed with an error

Common causes:
- **CSV**: Column headers don't match expected format. Use the column mapper to align fields.
- **PDF**: Some bank statement layouts aren't recognized. Try exporting as CSV or OFX from your bank instead.
- **Large files**: Very large imports may time out. Try splitting into smaller batches.

### The unlock screen won't accept my passphrase

Ensure you're typing the exact passphrase (case-sensitive, including spaces). If you've changed your passphrase recently, use the new one. There is no recovery option if the passphrase is lost.
