# Webhook events — v1 contract

The webhook event vocabulary is a **public contract** that outlives any single MCP tool rename. Users wiring `n8n` / Zapier / a homebuilt receiver against Finlynq + Claude operate on one mental model: MCP tool names and webhook event names cohere. This doc is the spec; the implementation lives in FINLYNQ-60..64 (the `webhooks` + `webhook_deliveries` schema and the post-commit dispatcher). Anything shipped against this surface must conform to what's documented here.

Authored alongside FINLYNQ-51 (2026-05-18). Pairs with FINLYNQ-43 (decomposed into FINLYNQ-60..64).

## Versioning

Versioning is carried on the wire as the **Content-Type**, not in the event name:

```
Content-Type: application/vnd.finlynq.webhook.v1+json
```

When the envelope shape needs to break, mint `vnd.finlynq.webhook.v2+json`, dispatch both v1 and v2 in parallel for one release cycle, then deprecate v1. **Never** version event names — `transaction.v1.created` is wrong; the entire vocabulary lives inside the Content-Type bump.

**Append-only inside v1.** Adding a new event (e.g. `subscription.cancelled`) is allowed within v1 if and only if (a) the new event's payload conforms to the v1 envelope below and (b) the event name uses the `<entity>.<verb>` convention. Field additions to the envelope must be backward-compatible (new fields optional, no rename of existing fields, no semantic change to existing fields). Shape breaks rev the Content-Type.

## v1 event names

Five events ship in v1. Every event name is `<entity>.<verb>` in lowercase ASCII. Source MCP tools and entity payload references:

| Event | Source MCP tool(s) | Entity referenced | `before` | `after` |
|---|---|---|---|---|
| `transaction.created` | `record_transaction`, `bulk_record_transactions`, `record_trade` (per-leg) | `transactions` row | — | yes |
| `transaction.updated` | `update_transaction` | `transactions` row | yes (pre-state subset) | yes (post-state subset) |
| `transaction.deleted` | `delete_transaction` | `transactions` row id | yes (pre-state subset) | — |
| `transfer.created` | `record_transfer` (and the same-account in-kind path used by `record_trade`) | `transactions` row pair sharing a `link_id` | — | yes (both leg ids + `link_id`) |
| `import.approved` | `approve_staged_rows`, REST `/api/import/staged/[id]/approve` | `staged_imports` row + materialized `transactions` ids | — | yes (counts + ids only) |

`bulk_record_transactions` emits **one** `transaction.created` event per row, NOT a single bulk event — consumers debouncing on event name only would otherwise need to special-case the bulk verb.

The five events above are the v1 set. `transfer.updated` / `transfer.deleted` are deliberately out of scope for v1: today's `update_transfer` / `delete_transfer` cascade through two `transaction.updated` / `transaction.deleted` siblings sharing a `link_id`, which is already represented in the per-row events. Adding `transfer.updated` later (append-only within v1) is allowed if a consumer ergonomics gap emerges.

## Payload envelope

```json
{
  "event":       "transaction.created",
  "delivery_id": "f3a1b2c4-...",
  "occurred_at": "2026-05-18T15:42:07.123Z",
  "user_id":     "ceb24315-35b1-42a1-8553-bb6e87874b29",
  "entity_id":   12345,
  "before":      { "...": "optional, see below" },
  "after":       { "...": "optional, see below" }
}
```

Field semantics:

- **`event`** — one of the five v1 event names above. Mirrors the `X-Finlynq-Event` header so consumers can route on the header without parsing the body.
- **`delivery_id`** — UUID v4. Default semantic is **per delivery attempt** so each retry gets a fresh id and consumer idempotency keys on `delivery_id`. (Open option for the implementer: alternatively per logical event, with retries reusing the same `delivery_id`. Default to **per-attempt** because retry-idempotency at the consumer is the more common need; if FINLYNQ-60..64 lands on per-logical-event, document the deviation in `webhook_deliveries`.) Mirrors `X-Finlynq-Delivery`.
- **`occurred_at`** — ISO 8601, UTC, millisecond precision. **Source: the tx commit timestamp**, NOT the wall-clock delivery time. A consumer ordering events by `occurred_at` sees the order the underlying writes committed in, regardless of retry latency.
- **`user_id`** — the owning user's UUID. Always populated; the webhook row is itself per-user and a cross-tenant dispatch would be a defect.
- **`entity_id`** — the primary key of the referenced entity (an INTEGER for `transactions`, a UUID for `staged_imports`). Opaque to the consumer. The consumer round-trips through MCP HTTP to dereference (e.g. `search_transactions({ ids: [entity_id] })`, `get_staged_import({ id: entity_id })`) and pulls full detail under the consumer's own auth scope.
- **`before`** — optional. Present for `transaction.updated` (pre-state subset) and `transaction.deleted` (pre-delete subset). Omitted otherwise.
- **`after`** — optional. Present for `transaction.created`, `transaction.updated`, `transfer.created` (with both leg ids + `link_id`), `import.approved` (counts + ids). Omitted on `transaction.deleted`.

### Subset shape — `before` / `after`

The subset is the **MCP-safe**, **PII-free** projection of the underlying row:

- ✅ `id`, `account_id`, `category_id`, `portfolio_holding_id`, `amount`, `currency`, `entered_amount`, `entered_currency`, `tx_date`, `type`, `link_id` (for transfers), `trade_link_id` (for paired trade legs), `source`, `created_at`, `updated_at`.
- ❌ **NEVER:** decrypted `payee`, decrypted `note`, decrypted `tags`, account `alias`, category `name`, holding `name`, holding `symbol`, goal `name`, loan `name`, subscription `name`. None of these. Not the plaintext form, not the `name_ct` ciphertext, not the `name_lookup` HMAC.

**Why no PII in the payload, ever.** Webhook URLs are user-controlled (the receiver is theirs), but the request body may transit n8n logs, Zapier task histories, third-party SaaS dashboards, monitoring tools, Sentry breadcrumbs, and self-hosted Postgres write-ahead logs the user does not control. The webhook surface is **opaque IDs + amounts + dates + FKs**; consumers needing full detail call back through MCP HTTP, which is encryption-aware and scope-checked. This rule is load-bearing — see [encryption.md](encryption.md) for Stream D Phase 4 context.

## Headers

Every dispatch carries:

```
Content-Type:        application/vnd.finlynq.webhook.v1+json
X-Finlynq-Event:     transaction.created
X-Finlynq-Delivery:  f3a1b2c4-...
X-Finlynq-Signature: sha256=<hex>
User-Agent:          Finlynq-Webhooks/1.0
```

- **`X-Finlynq-Signature`** — `sha256=<hex>` where `<hex>` is the lowercase hex HMAC-SHA256 of the **raw payload bytes** (not the parsed JSON; bytes as transmitted) under the per-row secret stored in `webhooks.secret`. Consumers verify by recomputing over the request body and constant-time comparing. Secret is per-webhook-row, generated server-side at create time, NEVER reused across rows.
- **`X-Finlynq-Event`** — duplicate of the `event` field in the body. Lets a consumer route on headers alone (e.g. nginx `if`, a CloudFlare Worker dispatch table) without parsing JSON.
- **`X-Finlynq-Delivery`** — duplicate of `delivery_id`. Same rationale.
- **`Content-Type`** — the v1 marker. A consumer reading `application/vnd.finlynq.webhook.v2+json` should NOT attempt to parse it as v1.

The `User-Agent` is plain ASCII; the trailing `/1.0` tracks Content-Type version for log triage. Bumping it is part of a Content-Type rev.

## Delivery timing

Webhook dispatch fires:

1. **AFTER** the DB transaction commits. Never inside it. A dispatch failure must not roll back the underlying write.
2. **AFTER** `invalidateUser(userId)` runs on the per-user MCP tx cache (CLAUDE.md "Every MCP tx-mutating write must call `invalidateUser(userId)` on the per-user tx cache after the commit"). A consumer that immediately calls back through MCP HTTP for full detail must see the committed row, not a cached stale view.

Dispatch is fire-and-forget from the request thread's perspective — the actual HTTP POST runs out-of-band (background task / queue per FINLYNQ-60..64). The MCP tool response is NEVER held waiting for the webhook to return.

## Retry policy

- **3 attempts.** Initial attempt + 2 retries.
- **Backoff:** 1m, 5m, 25m (×5 exponential).
- **Retry trigger:** non-2xx response status OR transport failure (DNS, TCP, TLS, read timeout > 10s).
- **Success criterion:** any 2xx response within the per-attempt timeout.
- **After final failure:** `webhook_deliveries.status_code = -1` (or a named `failed_after_retries` sentinel; impl decides), `webhooks.last_failed_at = NOW()`. UI surfaces a warning dot on the webhooks settings page so the user can investigate.
- **Consecutive failures:** the impl may add an auto-disable threshold (e.g. 10 consecutive failures → `webhooks.disabled_at = NOW()`) — that's a quality-of-life feature for the runtime, not a contract.

The retry budget is bounded so a permanently-broken receiver cannot stall the dispatcher queue indefinitely.

## Adding a new event in v1

Append-only within v1 requires all of:

1. Name follows `<entity>.<verb>` convention, lowercase ASCII, no version suffix.
2. Payload conforms to the v1 envelope (no new top-level required fields; new subset fields in `before` / `after` are optional and PII-free).
3. Dispatch timing matches the "AFTER commit + AFTER `invalidateUser`" rule.
4. Source MCP tool(s) listed in the event table above, with `before` / `after` semantics documented.
5. CHANGELOG entry referencing the implementation ticket.

Examples that are valid v1 additions: `subscription.cancelled`, `subscription.created`, `goal.achieved`, `loan.payment_recorded`, `account.archived`, `import.rejected`.

Examples that REQUIRE a v2 bump (breaking shape): renaming `entity_id` to `id`, dropping `delivery_id`, embedding decrypted PII (also forbidden outright — see "no PII" rule), nesting the envelope (`{ envelope: { event, ... }, payload: { ... } }`), changing `occurred_at` from ISO 8601 string to epoch milliseconds.

## Breaking shape changes — v2 cutover

When the envelope must break:

1. Implement v2 dispatch alongside v1; **dispatch BOTH** to every webhook row.
2. The `webhooks` row carries a `versions` column (TEXT[] or `('v1','v2','both')` enum); default new rows to `v2` only.
3. Document the diff in this file under a new "v2" section.
4. Run dual-dispatch for at least one full release cycle (~2 weeks) so consumers can migrate.
5. Remove v1 dispatch + the `versions` row's `v1` value in a follow-up.

Consumers that ignore Content-Type and parse bytes blindly will break on the v1→v2 rollover; this is by design and is the entire reason the version lives on the Content-Type. The header `X-Finlynq-Event` is unchanged across versions — the vocabulary outlives the envelope.

## Why intentionally simpler than the MCP HTTP envelope

MCP HTTP tools return the canonical `{ success: true, data: <T> }` envelope ([CLAUDE.md issue #237](../../../CLAUDE.md), 2026-05-09). Webhooks do **not** wrap their payload in a `{ success, data }` shell — the body IS the event, parsed directly by the receiver. Two reasons:

1. **One body = one event.** A webhook delivery is unambiguous — the request method + the URL + the body shape collectively mean "one of these five events happened." There's no error case to envelope; transport-level errors are surfaced via HTTP status from the receiver, and Finlynq's retry policy handles those.
2. **Consumers parse it once.** Every n8n / Zapier / CloudFlare Worker template assumes the body IS the event. Wrapping in `{ success, data: { event, ... } }` would force every consumer to add a `body.data` indirection for no signal.

The MCP envelope exists to discriminate "tool succeeded with this payload" from "tool failed with this error" inside a single response shape. Webhooks have no such discrimination — every dispatch represents a successful event; failure is signaled by the receiver via non-2xx status, not by an envelope flag.

## Cross-references

- [mcp.md](mcp.md) — MCP HTTP/stdio internals, the source-of-truth for tool names and the canonical `{ success, data }` envelope this doc deliberately diverges from.
- [encryption.md](encryption.md) — Stream D Phase 4 invariant ("plaintext columns are physically dropped on prod + dev"). The "no PII in webhook payloads" rule above is the natural extension to the webhook surface.
- [CLAUDE.md](../../../CLAUDE.md) — "Load-bearing gotchas" lists `invalidateUser(userId)` after every MCP tx-mutating commit. Webhook dispatch fires AFTER that invalidation, never before.
- FINLYNQ-43 (parent / decomposed) and FINLYNQ-60..64 (implementation) — this doc is the spec they reference. FINLYNQ-60 explicitly cross-references this file as the canonical event-vocabulary source.
