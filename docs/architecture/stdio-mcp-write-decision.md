# Stdio MCP 6-table write support — tradeoff analysis

**Status:** open decision. This doc lays out the options; the founder picks one and a follow-up item is filed for the implementation. Authored 2026-05-17 to track DevManager FINLYNQ-5.

## Background

Stream D Phase 4 (2026-05-03 dev / 2026-05-07 prod) physically dropped the eight plaintext display-name columns from six tables: `accounts.name`/`alias`, `categories.name`, `goals.name`, `loans.name`, `subscriptions.name`, `portfolio_holdings.name`/`symbol`. See [encryption.md §"Phase 3 status"](encryption.md) and the load-bearing gotcha in [../../CLAUDE.md](../../../CLAUDE.md) ("Stream D Phase 4 cutover"). Reads now go through `name_ct` + DEK via `decryptName()`; writes go through `buildNameFields(dek, ...)`. Without a DEK there is no way to compute `name_ct` or its `name_lookup` HMAC, so writes cannot happen.

The HTTP MCP transport carries a DEK through three auth methods (session cookie, Bearer `pf_*` API key, OAuth 2.1 + DCR — see [mcp.md §"Transports"](mcp.md) and [encryption.md §"Secret-derived DEK envelopes"](encryption.md)). The stdio transport has no auth on the wire — it bootstraps from `DATABASE_URL` + `PF_USER_ID` env vars in the Claude Desktop config. There is no password, API key, or OAuth code in scope, so there is nothing to unwrap the DEK with.

**Twelve stdio tools are affected** ([register-core-tools.ts:384](../../mcp-server/register-core-tools.ts) `streamDRefuse` helper, refusal sites at lines 624, 1360, 1380, 1426, 1472, 1534, 1554, 1904, 1930, 2262, 2289, 3089):

- `add_account`, `update_account`
- `create_category`
- `add_goal`, `update_goal`
- `add_loan`, `update_loan`
- `add_subscription`, `update_subscription`, `bulk_add_subscriptions`
- `add_portfolio_holding`, `update_portfolio_holding`

All twelve currently refuse with a single, well-formatted error message pointing the user at HTTP MCP or the web UI. Read tools across the six tables also refuse (separate `streamDRefuseRead` helper at [register-core-tools.ts:401](../../mcp-server/register-core-tools.ts)) because decryption needs the same DEK. Stdio transaction-write tools (`record_transaction`, `bulk_record_transactions`, `update_transaction`, `record_transfer`, `record_trade`) continue to work — `transactions.payee`/`note`/`tags` are encrypted-only with no Stream-D-style display-name surface, and stdio writes those columns as plaintext under the existing self-hosted carve-out (see [mcp.md §"Self-hosted limitation"](mcp.md)).

## Option A — document permanent limitation

Stdio create/update for the six tables stays refused. We invest in clearer docs (Claude Desktop setup guide, error-message links, this file) and route users to HTTP MCP or the web UI.

**Pros:**
- **Zero new attack surface.** No on-disk secret material, no new threat model. The existing DEK lifecycle (in-memory cache keyed by JWT `jti`, 2h sliding idle window per [encryption.md §"Envelope encryption"](encryption.md)) is preserved.
- **Ships today.** The refusal helpers already exist and are user-facing. We are documenting current behavior, not changing it.
- **Aligns with the zero-knowledge policy.** Finlynq's "no recovery on forgot password" stance (see [encryption.md §"Forgot-password policy"](encryption.md)) treats the DEK as ephemeral and session-scoped. Materializing it on disk for a daemon to use is a step back from that posture.
- **HTTP MCP is the strategic surface anyway.** OAuth 2.1 + DCR (Claude Web/Mobile), Bearer API key (CLIs / scripts), and session cookie (web UI) cover every supported integration today. The Anthropic Connectors Directory submission is HTTP-only ([mcp.md §"Tool surface evolution"](mcp.md) #237).

**Cons:**
- **Self-hosted ergonomics get worse.** A user running Finlynq on a homelab who has only wired up stdio (legitimate setup — small one-person deploys often skip the HTTPS / OAuth dance) cannot create accounts or categories from Claude Desktop. They have to either spin up HTTPS + an API key, or open the web UI for every CRUD operation.
- **Asymmetric tool surface confuses users.** Read-and-transaction-write works, account/category/holding CRUD doesn't. Without docs in front of them users misread it as a bug. Issue posts on github.com/finlynq/finlynq with `stdio cannot create` titles are inevitable.

## Option B — stdio-side encrypted keyring

Add a file-backed encrypted DEK cache on the self-hoster's box, unlocked at stdio session start. Two sub-options for the unlock UX:

- **B1 — passphrase prompt at stdio startup.** Claude Desktop has no good prompt path (the stdio handshake is JSON-RPC over stdin/stdout — interleaving an interactive prompt breaks the protocol). The workaround would be a one-shot `pf-mcp unlock` CLI that decrypts the keyring into a memory-mapped region or named pipe the stdio daemon reads from. Operator runs `pf-mcp unlock` once per boot.
- **B2 — OS keyring integration** (`pass`, macOS Keychain, Windows Credential Manager, GNOME Keyring, KWallet). The stdio daemon reads the wrapped DEK from the platform-native secret store. UX is good (OS unlocks the keyring at login) but the integration surface is large (4+ platforms, each with its own library).

**Pros:**
- **Stdio gets full write parity.** All twelve refused tools light up. Self-hosted UX matches the hosted/HTTP experience.
- **Avoids a permanently asymmetric tool surface.** "Why doesn't this work on stdio?" stops being an FAQ.

**Cons:**
- **New attack surface — on-disk DEK material.** An attacker with filesystem read on the self-hoster's box (compromised shell account, container escape, exposed backup, lost laptop without disk encryption) walks away with every encrypted display name. The current model loses only the password hash + ciphertext on a filesystem-read incident — the DEK is in memory only.
- **Unlock UX is brittle on stdio.** Claude Desktop's stdio launcher gives the daemon no terminal. B1 requires a separate manual `pf-mcp unlock` step per boot — operators forget, the daemon comes up half-functional, the next CRUD call fails opaquely. B2 is platform-coupled — Linux server installs without a desktop session can't use most native keyrings.
- **Cross-process secret sharing is harder than it looks.** Memory-mapped regions on Linux are world-readable by default in `/proc/<pid>/maps`; named pipes need careful FIFO permissions; the platform keyrings each have their own gotchas around session vs login keyring scope. Each platform needs its own threat model.
- **Cost is multi-week, not days.** New crypto primitive (file envelope under an operator-supplied passphrase), new CLI command, four platform integrations, ops docs for each, test surface for each. A real implementation is on the order of 800–1500 LoC across four files plus the keyring adapters.

## Option C — hybrid: stdio with env-supplied DEK

The Claude Desktop config gets `PF_DEK` (or `PF_DEK_PATH` pointing at a file the daemon `read()`s once at startup). The operator generates the DEK once (`pf-mcp export-dek` after a web-UI login) and pastes the 64-hex string into the config, or stores it in a file the daemon owns.

**Pros:**
- **Single config surface.** No new prompt, no new CLI, no platform-specific keyring adapter. Same `env:` block self-hosters already touch to set `PF_USER_ID` and `DATABASE_URL`.
- **Opt-in by construction.** Operators who haven't pasted the DEK get the current refusal behavior. No change for non-adopters.
- **Tiny code surface.** Probably ~50 LoC: an `if (process.env.PF_DEK) globalThis.__stdioDek = decodeHex(process.env.PF_DEK)` at startup, plus removing the `streamDRefuse()` early-return in the twelve refused handlers, replaced with `if (!stdioDek) return streamDRefuse(...); else use stdioDek`.

**Cons:**
- **Functionally equivalent to Option B for attack surface.** A DEK in `PF_DEK` (env var) or a file path that the daemon can `read()` is filesystem-readable by the same attacker who would beat Option B. There is no meaningful crypto improvement over storing the wrapped DEK + a passphrase next to it.
- **High user-error risk.** Operators paste DEKs into screenshots, Claude conversations, GitHub issues. Once leaked publicly the attacker can decrypt every encrypted column for that user. The DEK is the crown jewel — pre-Stream D it stayed in memory; pasting it into a config file invites the leak.
- **DEK rotation becomes manual.** Today the DEK rotates automatically on password reset + wipe-account. With `PF_DEK` set, every rotation forces the operator to re-export and re-paste — easy to skip, leaving the stdio daemon stuck on a stale DEK that no longer decrypts new data.
- **`PF_DEK` will leak into systemd journal / `ps auxe` / process inspection.** Env vars on Linux are world-readable through `/proc/<pid>/environ` by default for processes the user can `ptrace`; on shared boxes this is a one-grep attack. `PF_DEK_PATH` mitigates the env-leak but inherits Option B's filesystem-read concerns.

## Recommendation

**Decision: A.**

Three reasons stacked:

1. **The attack-surface delta is not justified by the UX gap.** Options B and C both materialize the DEK outside its current session-scoped in-memory cache. That single change converts "filesystem-read = ciphertext" into "filesystem-read = plaintext on demand" for any self-hoster who opts in. Stream D Phase 4 exists *because* we wanted display names off-disk in plaintext form ([encryption.md §"Phase 3 status"](encryption.md)). Adding a way to put the unwrap key on-disk for a daemon's convenience is the exact reverse of that posture.

2. **The strategic surface is HTTP MCP, not stdio.** OAuth 2.1 + DCR ([mcp.md §"OAuth 2.1 + DCR"](mcp.md)) gives Claude Desktop a clean unlock path today — the user logs in once through the browser, the access token wraps a session DEK, MCP-over-OAuth sees decrypted data. The Anthropic Connectors Directory submission (FINLYNQ-1, in-flight) is HTTP-only. Stdio's role is the self-hosted "I have Claude Desktop and I want to point it at my local DB" path — the operator typing the Claude Desktop config already understands "use the web UI for setup, use Claude for queries and ad-hoc transactions."

3. **Writes that *do* work on stdio cover the high-frequency use cases.** Transaction CRUD (`record_transaction`, `bulk_record_transactions`, `update_transaction`, `record_transfer`, `record_trade`) is unaffected — those are the daily-use tools. Creating a new account or category is a one-time setup operation. Doing it once in the web UI and then talking to Claude over stdio is not a meaningful workflow regression.

The argument for B or C only flips if (a) the Connectors Directory submission gets rejected for an HTTP-related reason and stdio becomes our primary surface, OR (b) we get sustained self-hoster pushback about stdio-only setups. Neither has happened yet.

## Implementation cost — if Option A is picked

Pure docs. Files touched:

- This file (`pf-app/docs/architecture/stdio-mcp-write-decision.md`) — already created.
- [../../CLAUDE.md](../../../CLAUDE.md) line 186 — append `→ [stdio-mcp-write-decision.md](pf-app/docs/architecture/stdio-mcp-write-decision.md)` so the open question is one click from the load-bearing gotcha entry.
- [mcp.md](mcp.md) §"Self-hosted limitation" — add a short forward-link to this doc so anyone reading the MCP architecture doc hits the decision rationale.
- The twelve `streamDRefuse()` error messages in [register-core-tools.ts](../../mcp-server/register-core-tools.ts) — optionally append `See docs/architecture/stdio-mcp-write-decision.md for the rationale.` to the human-readable string. Pure prose change, no logic change. Out of scope for this doc commit.

No migration, no test surface change, no schema change. Ballpark effort: 30 minutes total for the cross-links above plus the optional error-message tweak.

## Implementation cost — if Option B is picked

Multi-week. Touches:

- New `pf-app/src/lib/crypto/keyring-envelope.ts` — file envelope under operator-supplied passphrase or platform keyring secret.
- New `pf-app/bin/pf-mcp-unlock.ts` (or `mcp-server/unlock.ts`) — one-shot CLI that prompts for the passphrase and seeds the cache.
- New cross-process handoff mechanism (named pipe / mmap / platform keyring read).
- [register-core-tools.ts](../../mcp-server/register-core-tools.ts) — remove the twelve `streamDRefuse()` early-returns and the `streamDRefuseRead` symmetries; thread the unlocked DEK through every gated handler.
- Setup docs for each of macOS Keychain, Windows Credential Manager, libsecret/`pass`, KWallet.
- Test surface: new unit tests for the file envelope, integration tests for the four keyring adapters, manual smoke per platform.

Ballpark effort: 2-3 weeks of focused work; longer if we want CI coverage on all four platforms.

## Implementation cost — if Option C is picked

Days. Touches:

- [mcp-server/index.ts](../../mcp-server/index.ts) — read `PF_DEK` / `PF_DEK_PATH` at startup; populate a module-level `stdioDek` symbol.
- [register-core-tools.ts](../../mcp-server/register-core-tools.ts) — in each of the twelve refused handlers, branch on `stdioDek != null` before falling back to `streamDRefuse()`.
- New `pf-mcp export-dek` CLI command — runs against the local DB, prompts for password, unwraps the DEK, prints hex to stdout.
- Setup docs warning about leak modes (paste-into-screenshot, `ps auxe`, `/proc/<pid>/environ`).
- Test surface: small — one new unit test for the env-parsing path; the twelve handler tests need a "DEK present" + "DEK absent" pair.

Ballpark effort: 2-3 days. The cheap option, but it inherits Option B's attack-surface concerns without Option B's keyring polish.

## What the user does next

1. Read this doc.
2. Comment on FINLYNQ-5 with `A`, `B`, or `C`.
3. If A: file a follow-up for the docs sweep listed above. Probably one PR, an hour of work.
4. If B or C: file a follow-up describing the chosen sub-option (B1 / B2 / C-env / C-file) with explicit scope. The scope is wider than a single drain-cycle item — likely a Phase 5 plan, not a single ticket.
