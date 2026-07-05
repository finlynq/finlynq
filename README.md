# Finlynq

Two ways to use Finlynq: a free managed cloud at [finlynq.com/cloud](https://finlynq.com/cloud), or self-host with Docker.

Open-source personal finance with a first-party MCP server (75 HTTP / 93 stdio tools) so Claude, ChatGPT, Cursor, etc. can query and manage your finances.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

> Track your money here, analyze it anywhere.

---

## Quick start — hosted

[**finlynq.com/cloud**](https://finlynq.com/cloud) — click, register, import a CSV. No infra to manage.

A public demo lives at [finlynq.com/cloud?demo=1](https://finlynq.com/cloud?demo=1) (credentials pre-filled, resets nightly). Connect it to Claude by pasting `https://finlynq.com/mcp` into Claude → Customize → Connectors.

## Quick start — self-hosted

```bash
curl -O https://raw.githubusercontent.com/finlynq/finlynq/main/docker-compose.yml
docker compose up -d
```

Before the first `up`, create a sibling `.env` file with three secrets, each generated with `openssl rand -hex 32`: `PF_JWT_SECRET`, `PF_PEPPER` (≥32 chars), and `PF_STAGING_KEY` (≥32 chars). Compose fails fast with a clear message if any is missing. Then open [http://localhost:3000](http://localhost:3000) and register. App + PostgreSQL run in Docker; sensitive fields are encrypted at rest with a per-user key derived from the account password. Change the default PostgreSQL password (`POSTGRES_PASSWORD` in `.env`) before exposing the container to anything but localhost. Full setup notes at [finlynq.com/self-hosted](https://finlynq.com/self-hosted).

---

## Features

- 100+ MCP tools (HTTP & stdio) — read & write
- AES-256-GCM envelope encryption · scrypt-derived KEK
- CSV, Excel, OFX/QFX, PDF import
- Budgets, portfolio, goals, loans
- Natural-language AI chat
- FIRE calculator & Monte Carlo sim
- Rules & auto-categorize
- Self-host or managed cloud
- REST API + MCP (HTTP & stdio · OAuth 2.1 + DCR)
- Dark mode, mobile-friendly UI

---

## MCP server

First-party Model Context Protocol server with 75 HTTP / 93 stdio tools covering accounts, transactions, budgets, goals, loans, portfolio, subscriptions, FX rates, rules, splits, bulk edits, and file imports.

- **Claude Web / Mobile / Cursor / Windsurf** — OAuth 2.1 + Dynamic Client Registration. Paste `https://finlynq.com/mcp` into the connector setup; no config file.
- **Claude Desktop (stdio)** — point at `mcp-server/index.ts` with `PF_USER_ID` in the env block.
- **Bearer API key** — generate a `pf_*` token in Settings → API Keys for scripts and REST clients.

Submitted to the [Anthropic Connectors Directory](https://www.anthropic.com/news/connectors-directory) on 2026-05-09. Full client setup, tool catalog, and the brokerage-statement recipe live in the [Connect Your AI guide](https://finlynq.com/mcp-guide).

---

## License

[AGPL v3](LICENSE). If you run a modified version as a network service, you owe your users the source. The hosted offering at finlynq.com/cloud runs the same code as this repo.

Donation-based. No paid tiers. If Finlynq is useful to you, [GitHub Sponsors](https://github.com/sponsors/finlynq) or [Ko-fi](https://ko-fi.com/finlynq) keep it shipping.

---

## Docs

- [CHANGELOG.md](CHANGELOG.md) — reverse-chronological log of every shipped change
- [docs/getting-started.md](docs/getting-started.md) — first-run setup walkthrough
- [docs/faq.md](docs/faq.md) — common questions
- [docs/mobile-setup.md](docs/mobile-setup.md) — connect the companion mobile app
- [Connect Your AI guide](https://finlynq.com/mcp-guide) — MCP architecture, tool catalog, and per-client setup
- [CONTRIBUTING.md](CONTRIBUTING.md) — branching, commit style, PR flow
- [SECURITY.md](SECURITY.md) — vulnerability disclosure
