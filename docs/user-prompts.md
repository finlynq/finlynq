# User decision prompts

A reusable "we need an answer from you" surface (FINLYNQ-301). When an app change
needs an answer from the user before it can take effect, you ship a **prompt** in
the same commit as the change. The gate asks the question app-wide, tracks who
answered what, and lets the user defer.

Plan / rationale: [plan/user-decision-prompts.md](../plan/user-decision-prompts.md).

## How it works

- **`user_prompt_acks`** — one row per `(user_id, prompt_id, version)` recording
  `status` (`answered` | `deferred` | `dismissed`), a `defer_count`, and a
  `deferred_until` cooldown. `version` is in the PK, so bumping a prompt's
  version re-asks everyone while preserving the prior answer as its own audit
  row. `answer` stores the accepted value as text for audit **only** — never the
  source of truth (the writer persists to the real destination).
- **Server registry** ([src/lib/prompts/registry.ts](../src/lib/prompts/registry.ts))
  — the `PROMPTS` array of `PromptDef`s. Each def is a server-side predicate
  (`appliesTo`), an answer schema, and a typed writer (`persist`). **Server only**
  — it reaches `db`; never import it (or anything under `src/lib/prompts/` except
  pure types) into a client component.
- **Resolution** ([src/lib/prompts/resolve.ts](../src/lib/prompts/resolve.ts)) —
  `getPendingPrompts(db, userId)` runs every predicate and filters by the ack row
  (pure `isAckPending`): pending when `appliesTo` is true AND the ack is absent,
  or `deferred` with a cooled-down `deferred_until` and `defer_count` under
  `maxDefers`. `answered`/`dismissed` are terminal.
- **API** — `GET /api/prompts/pending`, `POST /api/prompts/[id]/answer`
  (validates with the def's schema, then runs `persist()` + the ack upsert in one
  transaction), `POST /api/prompts/[id]/defer`. All on `apiHandler`.
- **UI** — [`<PromptGate />`](../src/components/prompt-gate.tsx) mounts app-wide in
  `(app)/layout.tsx` inside `UnlockGate`, fetches pending prompts, and renders
  them one at a time. Forms come from the **client** id→form map
  ([src/components/prompts/prompt-forms.tsx](../src/components/prompts/prompt-forms.tsx)),
  deliberately separate from the server registry.
- **Operator view** — `/admin` shows a per-prompt answered/deferred/dismissed
  table.

## Adding a prompt (a 3-file change)

1. **Write the def** — a new `src/lib/prompts/<my-prompt>.ts` exporting a
   `PromptDef`, and register it in the `PROMPTS` array in `registry.ts`.
   - `id` is the stable `prompt_id`; start `version` at `1`.
   - `appliesTo({ db, userId })` returns true when the user still owes an answer
     (e.g. "no such settings row yet"). Keep it a cheap query.
   - `answerSchema` validates the submitted answer (a Zod schema).
   - `persist({ db, userId }, answer)` writes to the real destination and must be
     idempotent. `db` may be a transaction client, so reuse an extracted helper
     rather than calling the global `db` directly.
   - `deferrable`, `maxDefers` (`null` = ask forever), `deferCooldownHours`
     (≈ 20 for "next login").
2. **Write the form** — a client component and an entry in `PROMPT_FORMS`
   (`prompt-forms.tsx`) keyed by the prompt `id`. It collects the answer and
   hands it back via `onSubmit(answer)`. Use shared inputs (e.g.
   `useActiveCurrencies` for a currency, never a hardcoded list). A pending
   prompt with no form entry is silently skipped.
3. **Wipe is already covered** — `user_prompt_acks` is deleted in
   `deleteAllUserDataTx`, so a new prompt needs no wipe change.

No migration is needed for a new prompt — only the one CREATE-TABLE migration
([scripts/migrations/20260725_user_prompt_acks.sql](../scripts/migrations/20260725_user_prompt_acks.sql))
that created the table.

### Re-asking everyone

Bump the def's `version`. Every user's `appliesTo` is re-evaluated against a
fresh `(prompt_id, version)`, so anyone it still applies to is asked again; the
prior version's ack row is kept for audit.

## The `Don't` rules

1. Never import `registry.ts` / `src/lib/prompts/*` (except pure types) into a
   client component — it drags `pg`/`dns` into the browser bundle. The client
   half is `prompt-forms.tsx`.
2. No `localStorage` for prompt state — it lives in `user_prompt_acks`, so it is
   per-user and cross-device.
3. New routes use `apiHandler`.
4. The gate lives inside `UnlockGate` and never blocks DEK-unlock or login; a
   failing `GET /api/prompts/pending` renders nothing, never an error state.
5. Dialogs prefix their width (`sm:max-w-lg`), never bare `max-w-*`.
6. No hardcoded currency arrays — `useActiveCurrencies` only.
