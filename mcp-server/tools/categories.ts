/**
 * MCP HTTP tool group: categories (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  suggestionList,
  fuzzyFind,
  decryptNameish,
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
import {
  signConfirmationToken,
  verifyConfirmationToken,
} from "../../src/lib/mcp/confirmation-token";

export function registerCategoriesTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote } = ctx;


  // ── preview_delete_category ────────────────────────────────────────────────
  // Issue #237 — confirmation-token preview/execute pattern. Mirrors
  // `preview_bulk_categorize` / `execute_bulk_categorize`. Read-prefix
  // (`preview_`) so it lands in `mcp:read` scope; the actual destructive
  // step is `delete_category` and falls into the `mcp:write` default.
  server.tool(
    "preview_delete_category",
    "Preview deletion of a category. Returns the resolved category id/name plus FK row counts (transactions / rules / subscriptions still referencing it) and a confirmationToken for `delete_category`. The execute step refuses if any FK count is non-zero — reassign or delete dependents first via `preview_bulk_categorize` / `execute_bulk_categorize` (transactions), `update_rule` / `delete_rule` (auto-categorize rules), and `update_subscription` (subscriptions).",
    {
      id: z.number().int().positive().optional().describe("Category FK (categories.id). Exact match — preferred. Pass exactly one of id or name."),
      name: z.string().optional().describe("Category name (fuzzy matched against decrypted name). Requires an unlocked DEK because category names live in encrypted columns post Stream D Phase 4. Pass `id` instead when no DEK is available."),
    },
    async ({ id, name }) => {
      if (id == null && (name == null || name === "")) {
        return err("Pass exactly one of `id` (numeric) or `name` (fuzzy).");
      }
      // Resolve the category id. Same Stream-D-Phase-4 pattern as `delete_budget`.
      let cat: Row | null = null;
      if (id != null) {
        const rows = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId} AND id = ${id}`);
        if (!rows.length) return err(`Category #${id} not found.`);
        cat = decryptNameish(rows, dek)[0];
      } else {
        if (!dek) return err("Cannot resolve category by name without an unlocked DEK (Stream D Phase 4). Pass `id` instead.");
        const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const found = fuzzyFind(name!, allCats);
        if (!found) {
          return err(`Category "${name}" not found. Did you mean: ${suggestionList(name!, allCats)}?`);
        }
        cat = found;
      }
      const catId = Number(cat.id);
      const catName = String(cat.name ?? `#${catId}`);

      // Count FK references. All three tables scope by user_id so cross-tenant
      // counts can never leak. PG returns BIGINT-as-string; cast to Number.
      const txCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ${userId} AND category_id = ${catId}`) as { cnt: string | number }[];
      // FINLYNQ-84: actions are JSONB. Count rules whose actions array
      // includes a set_category action with this category id (or whose
      // create_transfer's destAccountId / set_account's accountId resolves
      // — only set_category matters here for category-delete FK check).
      const ruleCountRow = await q(db, sql`
        SELECT COUNT(*) AS cnt FROM transaction_rules
        WHERE user_id = ${userId}
          AND actions @> ${JSON.stringify([{ kind: "set_category", categoryId: catId }])}::jsonb
      `) as { cnt: string | number }[];
      const subCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM subscriptions WHERE user_id = ${userId} AND category_id = ${catId}`) as { cnt: string | number }[];
      const txCount = Number(txCountRow[0]?.cnt ?? 0);
      const ruleCount = Number(ruleCountRow[0]?.cnt ?? 0);
      const subscriptionCount = Number(subCountRow[0]?.cnt ?? 0);
      const inUse = txCount + ruleCount + subscriptionCount > 0;

      // Sign the confirmation token even when FKs are non-zero — execute will
      // re-check and refuse atomically. This way the preview shape is stable
      // and Claude can decide whether to reassign first or pick a new target.
      const confirmationToken = signConfirmationToken(userId, "delete_category", { id: catId });

      return text({
        success: true,
        data: {
          id: catId,
          name: catName,
          txCount,
          ruleCount,
          subscriptionCount,
          inUse,
          confirmationToken,
          ...(inUse
            ? { hint: "Reassign dependents before delete: use `preview_bulk_categorize` + `execute_bulk_categorize` to move transactions, `update_rule` / `delete_rule` for rules, `update_subscription` for subscriptions." }
            : {}),
        },
      });
    }
  );


  // ── delete_category ────────────────────────────────────────────────────────
  // Issue #237 — destructive (`delete_*`); falls into `mcp:write` default in
  // `src/lib/oauth-scopes.ts`. Auto-annotations infer `destructiveHint: true`
  // from the `delete_` prefix in `mcp-server/auto-annotations.ts`.
  server.tool(
    "delete_category",
    "Delete a category. Refuses if any transactions / auto-categorize rules / subscriptions still reference it (use `preview_bulk_categorize` / `execute_bulk_categorize` to reassign first). MUST be preceded by `preview_delete_category` with a matching id — pass that call's `confirmationToken` here verbatim. The token is single-use and expires after 5 minutes.",
    {
      id: z.number().int().positive().describe("Category FK (categories.id) — must match the id from the preview that issued the token."),
      confirmation_token: z.string().describe("Token returned by `preview_delete_category` for this exact id. Single-use; 5-minute TTL."),
    },
    async ({ id, confirmation_token }) => {
      const check = verifyConfirmationToken(confirmation_token, userId, "delete_category", { id });
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run preview_delete_category.`);

      const existing = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId} AND id = ${id}`);
      if (!existing.length) return err(`Category #${id} not found.`);
      const catRow = decryptNameish(existing, dek)[0];
      const catName = String(catRow.name ?? `#${id}`);

      // Re-check FK references atomically — token is bound to id only; a row
      // could have been categorized between preview and execute.
      const txCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM transactions WHERE user_id = ${userId} AND category_id = ${id}`) as { cnt: string | number }[];
      // FINLYNQ-84: count via JSONB @> containment.
      const ruleCountRow = await q(db, sql`
        SELECT COUNT(*) AS cnt FROM transaction_rules
        WHERE user_id = ${userId}
          AND actions @> ${JSON.stringify([{ kind: "set_category", categoryId: id }])}::jsonb
      `) as { cnt: string | number }[];
      const subCountRow = await q(db, sql`SELECT COUNT(*) AS cnt FROM subscriptions WHERE user_id = ${userId} AND category_id = ${id}`) as { cnt: string | number }[];
      const txCount = Number(txCountRow[0]?.cnt ?? 0);
      const ruleCount = Number(ruleCountRow[0]?.cnt ?? 0);
      const subscriptionCount = Number(subCountRow[0]?.cnt ?? 0);
      if (txCount + ruleCount + subscriptionCount > 0) {
        return err(
          `Category "${catName}" still referenced by ${txCount} transaction(s), ${ruleCount} rule(s), ${subscriptionCount} subscription(s). Reassign dependents first (use bulk_categorize for transactions, update_rule/delete_rule for rules, update_subscription for subscriptions).`
        );
      }

      await db.execute(sql`DELETE FROM categories WHERE id = ${id} AND user_id = ${userId}`);
      // Load-bearing per CLAUDE.md: every MCP tx-mutating write invalidates
      // the per-user tx cache. Mirrors `delete_budget` precedent.
      invalidateUserTxCache(userId);
      return text({ success: true, data: { id, message: `Category "${catName}" deleted` } });
    }
  );


  // ── create_category ────────────────────────────────────────────────────────
  server.tool(
    "create_category",
    "Create a new transaction category",
    {
      name: z.string().describe("Category name (must be unique)"),
      // Issue #211 (Bug d): enum was `["E", "I", "T"]` but every other
      // surface (transfer.ts, staged_transactions.tx_type CHECK, MCP
      // bulk_record_transactions, schema-pg) uses `'R'` for transfer.
      // `'T'` rows persisted as orphans no other code path could render.
      // Migration 20260509c flips any extant `type='T'` rows to `'R'`.
      type: z.enum(["E", "I", "R"]).describe("Type: 'E'=expense, 'I'=income, 'R'=transfer"),
      group: z.string().optional().describe("Group label (e.g. 'Housing', 'Food')"),
      note: z.string().optional(),
    },
    async ({ name, type, group, note }) => {
      // Stream D Phase 4 — plaintext name dropped; lookup-only collision check.
      const lookup = dek ? nameLookup(dek, name) : null;
      if (!lookup) return err("Cannot create category without an unlocked DEK (Stream D Phase 4).");
      const existing = await q(db, sql`
        SELECT id FROM categories WHERE user_id = ${userId} AND name_lookup = ${lookup}
      `);
      if (existing.length) return err(`Category "${name}" already exists`);

      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      const result = await q(db, sql`
        INSERT INTO categories (user_id, type, "group", note, name_ct, name_lookup)
        VALUES (${userId}, ${type}, ${group ?? ""}, ${encNote(note)}, ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      return text({ success: true, data: { categoryId: result[0]?.id, message: `Category "${name}" created (${type === "E" ? "expense" : type === "I" ? "income" : "transfer"})` } });
    }
  );
}
