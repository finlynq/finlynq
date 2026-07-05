/**
 * MCP HTTP tool group: accounts (FINLYNQ-109 extraction; FINLYNQ-263 consolidation).
 *
 * FINLYNQ-263 phase 1 — `add_account`, `update_account`, `delete_account`, and
 * `set_account_mode` are folded into ONE `manage_accounts` discriminated-union
 * tool (`op: add | update | delete | set_mode`). Handler bodies are lifted
 * VERBATIM; the delete op keeps the FINLYNQ-264 `withConfirmation` preview→token
 * two-step by reusing the SAME built handler. Each old name stays a HIDDEN
 * back-compat alias (owner decision #1).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. Do not reformat or
 * re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  dataResponse,
  suggestionList,
  resolveAccountStrict,
  resolveEntity,
  decryptNameish,
  supportedCurrencyEnum,
  type Row,
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  encryptName,
  nameLookup,
} from "../../src/lib/crypto/encrypted-columns";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";
import { withConfirmation, PreviewAbortError } from "./_confirm";
import { registerManageTool, registerAlias } from "./_consolidate";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerAccountsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote } = ctx;

  // ── op: add — lifted VERBATIM from add_account ─────────────────────────────
  async function opAdd(args: {
    name: string;
    type: "A" | "L";
    group?: string;
    currency?: string;
    note?: string;
    alias?: string;
  }): Promise<ToolResult> {
    const { name, type, group, currency, note, alias } = args;
    // Stream D Phase 4 — plaintext name dropped; lookup-only collision check.
    const lookup = dek ? nameLookup(dek, name) : null;
    if (!lookup) return err("Cannot create account without an unlocked DEK (Stream D Phase 4).");
    const existing = await q(db, sql`
      SELECT id FROM accounts WHERE user_id = ${userId} AND name_lookup = ${lookup}
    `);
    if (existing.length) return err(`Account "${name}" already exists (id: ${existing[0].id})`);

    const aliasValue = alias && alias.trim() ? alias.trim() : null;
    const nameEnc = dek ? encryptName(dek, name) : { ct: null, lookup: null };
    const aliasEnc = dek ? encryptName(dek, aliasValue) : { ct: null, lookup: null };
    // Issue #233 — liability accounts default to `"Liability"` when group
    // is omitted/blank, matching the REST seam in `resolveDefaultGroup`.
    // Asset accounts keep the historical empty-string behavior.
    const resolvedGroup = (() => {
      const trimmed = (group ?? "").trim();
      if (trimmed) return trimmed;
      return type === "L" ? "Liability" : "";
    })();
    // Stream D Phase 4 — plaintext name/alias columns dropped.
    const result = await q(db, sql`
      INSERT INTO accounts (
        user_id, type, "group", currency, note,
        name_ct, name_lookup, alias_ct, alias_lookup
      )
      VALUES (
        ${userId}, ${type}, ${resolvedGroup}, ${currency ?? "CAD"}, ${encNote(note)},
        ${nameEnc.ct}, ${nameEnc.lookup}, ${aliasEnc.ct}, ${aliasEnc.lookup}
      )
      RETURNING id
    `);

    return text({ success: true, data: { accountId: result[0]?.id, message: `Account "${name}" created (${type === "A" ? "asset" : "liability"}, ${currency ?? "CAD"})${aliasValue ? `, alias "${aliasValue}"` : ""}` } });
  }

  // ── op: update — lifted VERBATIM from update_account ───────────────────────
  async function opUpdate(args: {
    accountId?: number;
    account?: string;
    name?: string;
    group?: string;
    currency?: string;
    note?: string;
    alias?: string;
  }): Promise<ToolResult> {
    const { accountId, account, name, group, currency, note, alias } = args;
    if (accountId == null && (account == null || account === "")) {
      return err("Pass `accountId` (numeric) or `account` (name/alias) to identify the account.");
    }

    // Resolve via id first when supplied — the safe path that never depends
    // on the DEK. SELECT both encrypted columns so we can echo a name on
    // success when a DEK happens to be available.
    let acct: Row | null = null;
    if (accountId != null) {
      const rows = await q(db, sql`
        SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId} AND id = ${accountId}
      `);
      if (!rows.length) return err(`Account #${accountId} not found.`);
      acct = decryptNameish(rows, dek)[0];
    }

    // Resolve via name (fuzzy). Refuses without a DEK — same shape as
    // delete_account (issue #230) and the stdio counterpart's refusal at
    // register-core-tools.ts.
    let resolvedByName: Row | null = null;
    if (account != null && account !== "") {
      if (!dek) {
        return err("Cannot resolve account by name without an unlocked DEK (Stream D Phase 4). Pass `accountId` instead.");
      }
      const rawAccounts = await q(db, sql`
        SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      const allAccounts = decryptNameish(rawAccounts, dek);
      const resolved = resolveAccountStrict(account, allAccounts);
      if (!resolved.ok) {
        const suggestions = suggestionList(account, allAccounts);
        if (resolved.reason === "ambiguous") {
          return err(`Ambiguous: "${account}" matches ${resolved.candidates.length} accounts. Did you mean: ${suggestions}? (Pass accountId to disambiguate.)`);
        }
        if (resolved.reason === "low_confidence") {
          return err(`Account "${account}" did not match strongly — closest is "${resolved.suggestion.name}" but no shared whitespace token. Did you mean: ${suggestions}? (Pass accountId to disambiguate.)`);
        }
        return err(`Account "${account}" not found. Did you mean: ${suggestions}?`);
      }
      resolvedByName = resolved.account;
    }

    // BOTH supplied — fail loud on mismatch, never silently prefer one.
    if (acct && resolvedByName) {
      if (Number(acct.id) !== Number(resolvedByName.id)) {
        return err(`Account mismatch: "${account}" resolves to #${Number(resolvedByName.id)}, but accountId=${Number(acct.id)} was supplied.`);
      }
    } else if (!acct && resolvedByName) {
      acct = resolvedByName;
    }
    if (!acct) {
      return err("Pass `accountId` (numeric) or `account` (name/alias) to identify the account.");
    }

    // Stream D Phase 4 — plaintext name/alias dropped; only encrypted columns.
    const updates: ReturnType<typeof sql>[] = [];
    if (name !== undefined) {
      if (!dek) return err("Cannot rename account without an unlocked DEK (Stream D Phase 4).");
      const n = encryptName(dek, name);
      updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
    }
    if (group !== undefined) updates.push(sql`"group" = ${group}`);
    if (currency !== undefined) updates.push(sql`currency = ${currency}`);
    if (note !== undefined) updates.push(sql`note = ${encNote(note)}`);
    if (alias !== undefined) {
      const trimmed = alias.trim();
      const aliasValue = trimmed ? trimmed : null;
      if (!dek) return err("Cannot update alias without an unlocked DEK (Stream D Phase 4).");
      const a = encryptName(dek, aliasValue);
      updates.push(sql`alias_ct = ${a.ct}`, sql`alias_lookup = ${a.lookup}`);
    }
    if (!updates.length) return err("No fields to update");

    const result = await db.execute(
      sql`UPDATE accounts SET ${sql.join(updates, sql`, `)} WHERE id = ${acct.id} AND user_id = ${userId}`
    );
    // pg returns { rowCount }; some drivers expose it differently. If the update
    // touched 0 rows the ownership check in WHERE failed (e.g. race with delete).
    const affected =
      (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
        ? (result as { rowCount: number }).rowCount
        : null;
    const acctNameLabel = (acct.name as string | undefined) ?? "<encrypted>";
    const acctIdLabel = Number(acct.id);
    if (affected === 0) return err(`Account #${acctIdLabel} ("${acctNameLabel}") not found or not owned by this user`);
    return text({ success: true, data: { accountId: acctIdLabel, message: `Account #${acctIdLabel} ("${acctNameLabel}") updated` } });
  }

  // ── op: delete — lifted VERBATIM from delete_account (withConfirmation) ─────
  // Issue #230 / FINLYNQ-264 tier-1: the non-empty / force delete CASCADEs the
  // account's transactions + holding_accounts + goal_accounts, so it requires
  // the preview→token two-step; a CLEAN empty account deletes directly. The
  // full resolution + confirmation wiring is preserved verbatim.
  type DeleteAccountArgs = {
    accountId?: number;
    account?: string;
    force?: boolean;
    confirmation_token?: string;
    // memo slots (populated by resolve(), reused across required/preview/commit)
    __acct?: Row;
    __count?: number;
  };

  /**
   * Resolve the target account + its transaction count ONCE per tool call,
   * memoized on the args object so `required`/`tokenPayload`/`preview`/`commit`
   * share the same result. Aborts (PreviewAbortError) on any resolution failure
   * so the middleware surfaces a clean tool error and mints no token.
   */
  async function resolveDeleteAccount(a: DeleteAccountArgs): Promise<{ acct: Row; count: number }> {
    if (a.__acct) return { acct: a.__acct, count: a.__count ?? 0 };
    const { accountId, account } = a;
    if (accountId == null && (account == null || account === "")) {
      throw new PreviewAbortError("Pass `accountId` (numeric) or `account` (name/alias) to identify the account.");
    }
    // Resolve via id first when supplied — the safe path that never depends on
    // the DEK. SELECT both encrypted columns so we can echo a name.
    let acct: Row | null = null;
    if (accountId != null) {
      const rows = await q(db, sql`
        SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId} AND id = ${accountId}
      `);
      if (!rows.length) throw new PreviewAbortError(`Account #${accountId} not found.`);
      acct = decryptNameish(rows, dek)[0];
    }
    // Resolve via name. Refuses without a DEK. FINLYNQ-267: via the shared
    // envelope — a mistyped/unmatched name is REFUSED and a 2+ match ABORTS
    // with an ambiguous list (was `fuzzyFind` silent-first — the #230 class).
    let resolvedByName: Row | null = null;
    if (account != null && account !== "") {
      if (!dek) {
        throw new PreviewAbortError("Cannot resolve account by name without an unlocked DEK (Stream D Phase 4). Pass `accountId` instead.");
      }
      const rawAccounts = await q(db, sql`
        SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      const allAccounts = decryptNameish(rawAccounts, dek);
      const env = resolveEntity({ entity: "account", name: account, options: allAccounts });
      if (env.status === "ambiguous") {
        const list = env.candidates.map((c) => `"${c.name}" (id=${c.id})`).join(", ");
        throw new PreviewAbortError(`Account is ambiguous — ${env.candidates.length} matches: ${list}. Pass accountId to disambiguate.`);
      }
      if (env.status === "not_found") {
        throw new PreviewAbortError(`Account "${account}" not found. Did you mean: ${suggestionList(account, allAccounts)}?`);
      }
      resolvedByName = allAccounts.find((a) => Number(a.id) === env.id) ?? null;
    }
    // Both supplied — fail loud on mismatch.
    if (acct && resolvedByName) {
      if (Number(acct.id) !== Number(resolvedByName.id)) {
        throw new PreviewAbortError(`Account mismatch: "${account}" resolves to #${Number(resolvedByName.id)}, but accountId=${Number(acct.id)} was supplied.`);
      }
    } else if (!acct && resolvedByName) {
      acct = resolvedByName;
    }
    if (!acct) {
      throw new PreviewAbortError("Pass `accountId` (numeric) or `account` (name/alias) to identify the account.");
    }
    const acctId = Number(acct.id);
    const txnCount = await q(db, sql`SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ${userId} AND account_id = ${acctId}`);
    const count = Number(txnCount[0]?.cnt ?? 0);
    a.__acct = acct;
    a.__count = count;
    return { acct, count };
  }

  // Build the delete handler ONCE (withConfirmation preview↔commit). Reused by
  // both the manage_accounts op=delete dispatcher and the delete_account alias.
  const deleteAccountHandler = withConfirmation<DeleteAccountArgs>(userId, {
    operation: "delete_account",
    tokenPayload: (a) => ({ accountId: a.__acct ? Number(a.__acct.id) : null, force: a.force === true }),
    // Gate ON when force OR the account has transactions; skip (direct delete)
    // for a clean empty account. resolve() runs here first, so the memo is
    // primed for tokenPayload/preview/commit.
    required: async (a) => {
      const { count } = await resolveDeleteAccount(a);
      return a.force === true || count > 0;
    },
    preview: async (a) => {
      const { acct, count } = await resolveDeleteAccount(a);
      const acctId = Number(acct.id);
      const holdingCount = Number(
        (await q(db, sql`SELECT COUNT(*) AS cnt FROM holding_accounts WHERE user_id = ${userId} AND account_id = ${acctId}`))[0]?.cnt ?? 0,
      );
      const goalCount = Number(
        (await q(db, sql`SELECT COUNT(*) AS cnt FROM goal_accounts WHERE user_id = ${userId} AND account_id = ${acctId}`))[0]?.cnt ?? 0,
      );
      return {
        accountId: acctId,
        name: (acct.name as string | undefined) ?? "<encrypted>",
        transactionCount: count,
        holdingLinkCount: holdingCount,
        goalLinkCount: goalCount,
        cascades: "transactions, holding_accounts, goal_accounts",
      };
    },
    commit: async (a) => {
      const { acct, count } = await resolveDeleteAccount(a);
      const acctId = Number(acct.id);
      const acctName = (acct.name as string | undefined) ?? "<encrypted>";
      // FK CASCADE: this DELETE drops `transactions`, `holding_accounts`, and
      // `goal_accounts` rows for this account in the same DB transaction.
      await db.execute(sql`DELETE FROM accounts WHERE id = ${acctId} AND user_id = ${userId}`);
      // CLAUDE.md invariant: every MCP tx-mutating write must invalidate the
      // per-user tx cache. Mirrors `delete_budget` precedent.
      invalidateUserTxCache(userId);
      return text({
        success: true,
        data: {
          accountId: acctId,
          message: `Account #${acctId} ("${acctName}") deleted${count > 0 ? ` (${count} transactions also removed)` : ""}`,
        },
      });
    },
  });

  // ── op: set_mode — lifted VERBATIM from set_account_mode ────────────────────
  // Owner-scoped UPDATE of the per-account pipeline policy. NOT a transactions
  // write → no invalidateUser. 0 rows (cross-tenant / missing) → "Not found".
  async function opSetMode(args: { accountId: number; mode: "auto" | "approve" | "manual" }): Promise<ToolResult> {
    const { accountId, mode } = args;
    const rows = await q(
      db,
      sql`
        UPDATE accounts SET mode = ${mode}
        WHERE id = ${accountId} AND user_id = ${userId}
        RETURNING id, mode
      `,
    );
    if (!rows.length) return err("Not found");
    return dataResponse({ id: Number(rows[0].id), mode: String(rows[0].mode) });
  }

  // ── consolidated tool ───────────────────────────────────────────────────────
  registerManageTool(
    server,
    "manage_accounts",
    "Manage financial accounts: `op` selects add / update / delete / set_mode. add: create an account (name/type A|L, optional currency/group/alias). update: change name/group/currency/note/alias (exact `accountId` or fuzzy `account`). delete: TWO-STEP for a non-empty/force delete (preview cascade counts + token, then commit); a clean empty account deletes directly. set_mode: set the import pipeline mode (auto|approve|manual).",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("add"),
        name: z.string().describe("Account name (must be unique)"),
        type: z.enum(["A", "L"]).describe("Account type: 'A' for asset, 'L' for liability"),
        group: z.string().optional().describe("Account group (e.g. 'Banks', 'Credit Cards', 'Investment')"),
        currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code (default CAD). Issue #206: any currency in SUPPORTED_CURRENCIES is accepted; FX engine triangulates through USD."),
        note: z.string().optional().describe("Optional note"),
        alias: z.string().max(64).optional().describe("Optional short alias used to match the account when receipts or imports reference it by a non-canonical name (e.g. last 4 digits of a card, or a receipt label)."),
      }),
      z.object({
        op: z.literal("update"),
        accountId: z.number().int().positive().optional().describe("Account FK (accounts.id). Exact match — preferred. The only path that works without an unlocked DEK."),
        account: z.string().optional().describe("Current account name or alias (fuzzy matched against name; exact match on alias). Requires an unlocked DEK. Pass `accountId` instead when no DEK is available."),
        name: z.string().optional().describe("New name"),
        group: z.string().optional().describe("New group"),
        currency: supportedCurrencyEnum.optional().describe("New ISO 4217 currency code (issue #206: full SUPPORTED_CURRENCIES list)."),
        note: z.string().optional().describe("New note"),
        alias: z.string().max(64).optional().describe("New alias — short shorthand used to match receipts/imports. Pass an empty string to clear."),
      }),
      z.object({
        op: z.literal("delete"),
        accountId: z.number().int().positive().optional().describe("Account FK (accounts.id). Exact match — preferred and the only way to delete when the DEK is not unlocked."),
        account: z.string().optional().describe("Account name or alias (fuzzy). Requires an unlocked DEK. Pass `accountId` instead when no DEK is available."),
        force: z.boolean().optional().describe("Delete even if transactions exist. FK CASCADE removes the account's transactions/holding_accounts/goal_accounts — irreversible. A non-empty delete ALWAYS requires the confirmation token."),
        confirmation_token: z.string().optional().describe("Omit to preview; pass the preview's token to commit a non-empty/force delete. Single-use, 5-min TTL. Not needed to delete a clean empty account."),
      }),
      z.object({
        op: z.literal("set_mode"),
        accountId: z.number().int().positive().describe("accounts.id."),
        mode: z.enum(["auto", "approve", "manual"]).describe("New import pipeline mode for this account."),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "add":
          return opAdd(input);
        case "update":
          return opUpdate(input);
        case "delete":
          return deleteAccountHandler(input);
        case "set_mode":
          return opSetMode(input);
      }
    },
  );

  // ── hidden back-compat aliases (removed in v4.1) ─────────────────────────────
  registerAlias(
    server,
    "add_account",
    "Create a new financial account (bank, investment, credit card, etc.)",
    {
      name: z.string().describe("Account name (must be unique)"),
      type: z.enum(["A", "L"]).describe("Account type: 'A' for asset, 'L' for liability"),
      group: z.string().optional().describe("Account group (e.g. 'Banks', 'Credit Cards', 'Investment')"),
      currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code (default CAD). Issue #206: any currency in SUPPORTED_CURRENCIES is accepted; FX engine triangulates through USD."),
      note: z.string().optional().describe("Optional note"),
      alias: z.string().max(64).optional().describe("Optional short alias used to match the account when receipts or imports reference it by a non-canonical name (e.g. last 4 digits of a card, or a receipt label)."),
    },
    async (args) => opAdd(args),
  );
  registerAlias(
    server,
    "update_account",
    "Update name, group, currency, note, or alias of an account. Pass exactly ONE of `accountId` (preferred, exact) or `account` (name/alias, fuzzy). Supplying both is allowed only when they resolve to the same account — a mismatch fails loud and does NOT update.",
    {
      accountId: z.number().int().positive().optional().describe("Account FK (accounts.id). Exact match — preferred. The only path that works without an unlocked DEK."),
      account: z.string().optional().describe("Current account name or alias (fuzzy matched against name; exact match on alias). Requires an unlocked DEK because account names live in encrypted columns post Stream D Phase 4. Pass `accountId` instead when no DEK is available."),
      name: z.string().optional().describe("New name"),
      group: z.string().optional().describe("New group"),
      currency: supportedCurrencyEnum.optional().describe("New ISO 4217 currency code (issue #206: full SUPPORTED_CURRENCIES list)."),
      note: z.string().optional().describe("New note"),
      alias: z.string().max(64).optional().describe("New alias — short shorthand used to match receipts/imports (e.g. last 4 digits of a card). Pass an empty string to clear."),
    },
    async (args) => opUpdate(args),
  );
  registerAlias(
    server,
    "delete_account",
    "Delete an account. Pass exactly ONE of `accountId` (preferred, exact) or `account` (name/alias, fuzzy). A non-empty account (has transactions) or `force=true` is DESTRUCTIVE — it CASCADEs the account's transactions, holding_accounts, and goal_accounts — so it requires a two-step: the first call returns a preview (name + tx/holding/goal counts) + a confirmationToken (single-use, 5-min TTL) and deletes NOTHING; call again with the token to commit. A CLEAN, empty account deletes directly. Supplying both id + name is allowed only when they resolve to the same account.",
    {
      accountId: z.number().int().positive().optional().describe("Account FK (accounts.id). Exact match — preferred and the only way to delete an account when the user's DEK is not unlocked."),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias). Requires an unlocked DEK because account names live in encrypted columns post Stream D Phase 4. Pass `accountId` instead when no DEK is available."),
      force: z.boolean().optional().describe("Delete even if transactions exist. FK CASCADE removes the account's transactions, holding_accounts, and goal_accounts rows — irreversible. A non-empty delete ALWAYS requires the confirmation token regardless of this flag."),
      confirmation_token: z.string().optional().describe("Omit to preview; pass the preview's token to commit a non-empty/force delete. Single-use, 5-min TTL. Not needed to delete a clean empty account."),
    },
    async (args) => deleteAccountHandler(args),
  );
  registerAlias(
    server,
    "set_account_mode",
    "Set an account's import pipeline mode. 'auto' fires rules at upload, 'approve' reviews each row, 'manual' fires rules at materialize. Returns {id, mode}. Cross-tenant / missing id → Not found.",
    {
      accountId: z.number().int().positive().describe("accounts.id."),
      mode: z.enum(["auto", "approve", "manual"]).describe("New pipeline mode for this account."),
    },
    async (args) => opSetMode(args),
  );
}
