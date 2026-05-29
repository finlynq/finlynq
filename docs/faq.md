# Frequently Asked Questions

## Hosting & Deployment

### Does Finlynq offer a hosted service?

Yes. The free managed cloud lives at **[finlynq.com/cloud](https://finlynq.com/cloud)** — same code, same features as the self-hosted release. Donations via [GitHub Sponsors](https://github.com/sponsors/finlynq) or [Ko-fi](https://ko-fi.com/finlynq) are welcome but never required.

### What's the difference between hosted and self-hosted?

- **Hosted (finlynq.com/cloud)** — zero infra on your end. We run PostgreSQL and the Next.js app. You supply your password; the envelope-encryption key for your sensitive fields is derived from it, lives only in memory while you're signed in, and the operator never sees it.
- **Self-hosted** — you run PostgreSQL and the app yourself (Docker Compose or a Node + Postgres setup on your own VPS). Same encryption guarantees, you control the storage. The DEK still lives only in your running process's memory, derived from your password at login.

Both modes share one codebase and one database schema. The only difference is who operates the server.

### Is there a paid tier?

No. Finlynq is open source under **AGPL v3** and donation-funded ([GitHub Sponsors](https://github.com/sponsors/finlynq), [Ko-fi](https://ko-fi.com/finlynq)). There are no paid plans, feature gates, or seat licenses on either the hosted or self-hosted version.

## Security & Privacy

### Is my data safe?

Sensitive text columns (payees, transaction notes, tags, account names, category names, goal names, loan names, subscription names, portfolio holding names + symbols) are encrypted at rest with **AES-256-GCM** using a per-user **DEK** (data encryption key). Your password is run through **scrypt** to derive a KEK that wraps the DEK on disk; the DEK itself lives only in memory while you're signed in (cleared on logout and on every deploy restart).

Amounts, dates, and account references stay plaintext so aggregations (budgets, portfolio rollups, MCP queries) can run on the server without unwrapping your key. The key itself is derived from your password and never leaves your session.

### What happens if I forget my password?

You can reset your **login** (standard password-reset flow over email), but the **encrypted content cannot be recovered**. The reset issues you a new login credential, but the old DEK was wrapped with a KEK derived from your previous password — without that password we cannot unwrap it, and we never stored it in any form that lets us bypass that.

In practical terms: after a reset you can sign back in, but any pre-reset encrypted fields (payees, notes, tags, account/category/goal/loan/subscription/holding names) will render as `—`. Plaintext fields (amounts, dates, account FKs) are unaffected. **Store your password in a password manager.**

### Does Finlynq send my financial data anywhere?

In **hosted mode**, your encrypted database lives on our server. In **self-hosted mode**, it lives on yours. Either way, the operator never has your DEK — the wrapped DEK is on disk, the unwrap happens in memory after you authenticate, and the cleartext key is discarded on logout / process restart. Outbound calls are limited to public price providers (Yahoo Finance, CoinGecko, Stooq) keyed by ticker symbol only.

### Can I change my password?

Yes. Go to **Settings → Security** to re-key. The flow decrypts your DEK with the old password and re-wraps it with the new one in a single transaction; encrypted content stays intact.

## AI & MCP

### Does Finlynq have a built-in AI assistant?

Yes. The web UI ships a built-in AI chat that runs natural-language queries over your financial data using the same MCP tool surface external clients use — you don't need to wire up an outside AI client to ask "how much did I spend on groceries last month?". The chat is opt-in and runs against your own session, so the same encryption rules apply.

### How do I connect an external AI client?

Finlynq runs an MCP (Model Context Protocol) server that external clients can connect to:

- **HTTP transport** at `/api/mcp` (Streamable HTTP). Auth via session cookie or Bearer API key (`pf_*` prefix). For Claude Web / Claude Mobile / ChatGPT (via the Anthropic Connectors Directory) the server supports **OAuth 2.1 with Dynamic Client Registration**.
- **Stdio transport** for Claude Desktop and other CLI-style clients. Self-hosters set `PF_USER_ID` + `DATABASE_URL` in the client's MCP config.

See the [Getting Started guide](./getting-started.md#connecting-an-ai-assistant-optional) for client-specific setup steps.

### What can the AI assistant do?

The MCP server registers **94 tools on HTTP / 87 tools on stdio** (as of server v3.1.0). They cover reads + writes across accounts, transactions, transfers, budgets, portfolio holdings, goals, loans, subscriptions, recurring transactions, rules, imports, and the staging-review queue. Typical operations: record a transaction, log a transfer between accounts, create a budget or auto-categorize rule, run portfolio analysis, build a debt-payoff plan, review a pending CSV/email import.

Destructive operations (delete account, delete category, bulk-categorize) use a **confirmation-token preview/execute pattern** so the AI has to show you the impact before it can act.

## Data Import

### What file formats can I import?

Finlynq supports five import methods:

| Format | Description |
|--------|-------------|
| **CSV** | Standard comma-separated files with column mapping |
| **Excel** (.xlsx/.xls) | Spreadsheets with visual column mapper |
| **PDF** | Bank statements with automatic table extraction |
| **OFX/QFX** | Standard bank statement format |
| **Email** | Forward bank statements to your per-user `import-<code>@finlynq.com` address; attachments are parsed automatically. |

Every import path lands in a **unified staging queue at `/import/pending`** — you review, edit (payee / category / note / tags / holding / amount + currency), flag transfer pairs, and approve before any row is materialized into your transactions table. Nothing is auto-committed.

### Will importing the same file create duplicates?

No. Finlynq fingerprints each incoming row with a **SHA-256 hash over the payee and the bank's transaction ID**, computed when the row first arrives and stable even if you later edit it. Re-imports of the same file are detected and skipped.

### Can I connect directly to my bank?

Not today. Bank-feed aggregator integration (services like Plaid, SnapTrade, and SimpleFIN) is on the roadmap, but there's no shipping date yet. For now, use file-based import: download statements from your bank's website (CSV / OFX / PDF), or forward email statements to your per-user import address.

## Multi-Device & Mobile

### How do I access Finlynq from multiple devices?

- **Hosted (finlynq.com/cloud)** — just log in from any device. Sessions are per-device; there's no single-writer lock.
- **Self-hosted** — run the Next.js app on a machine, then log in over your LAN from a browser or the mobile app. For a self-hosted setup reachable outside your LAN, put the app behind a reverse proxy (Caddy, nginx, Cloudflare Tunnel) with TLS.

### Is there a mobile app?

Yes — a React Native (Expo) mobile app that talks to your Finlynq backend (hosted or self-hosted). It covers Dashboard, Transactions, Import, Budgets, and Settings. Setup steps in the [Mobile Setup guide](./mobile-setup.md).

### Do I need to run the web app for mobile to work?

Yes. The mobile app is a client; it talks to the Finlynq Next.js backend over HTTP. For hosted users, that backend is finlynq.com — you just point the app at it. For self-hosters, the backend has to be running and reachable on the network the phone is on.

## Budgets & Tracking

### How do budgets work?

Create a budget by picking a category and setting a monthly limit. Finlynq tracks spending in that category against the budget; progress bars show how much you've spent and how much remains.

### Can I use multiple currencies?

Yes. Finlynq supports multi-currency accounts with automatic FX-rate fetching (Yahoo Finance for fiat, CoinGecko for crypto, Stooq for precious metals). Each account has its own currency; reports convert to your base currency on the fly. Pairs without a direct rate (e.g. EUR → CAD) are converted via USD, and Finlynq shows you the source of each rate so you can tell when one is stale or manually overridden.

## Troubleshooting

### Encrypted fields show as "—" or `v1:...`

This means the server has the row but doesn't currently hold the key to decrypt it. Most common cause: your encryption key is loaded only while you're signed in, and it gets cleared by a server restart (a deploy on hosted, or a process restart self-hosted). Sign out and back in — that reloads your key and the names + payees come back.

If they're still missing after a clean re-login, the data may have been encrypted under a different password than the one you're using now. File a GitHub issue with a screenshot if so.

### Import failed with an error

Common causes:

- **CSV** — column headers don't match the expected format. Use the column mapper to align fields, then re-upload.
- **PDF** — some bank-statement layouts aren't recognized by the table extractor. Try exporting as CSV or OFX from your bank instead.
- **Large files** — very large uploads may time out. Split into smaller batches.

For email imports that don't show up in `/import/pending`, check that you sent from an address registered on your account and that the receiving address matches your per-user `import-<hex>@finlynq.com` exactly.

### The login screen won't accept my password

Passwords are case-sensitive (spaces included). If you changed your password recently, use the new one. There's no recovery for **encrypted content** if the password is lost, but you can always reset your login via the standard email-based password-reset flow (see "What happens if I forget my password?" above).
