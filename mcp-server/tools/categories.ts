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
  resolveEntity,
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
  signPreviewToken,
  verifyPreviewToken,
} from "./_confirm";
import { registerManageTool, registerAlias } from "./_consolidate";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerCategoriesTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote } = ctx;


  // ── op: delete (preview) — lifted VERBATIM from preview_delete_category ─────
  async function opDeletePreview(args: { id?: number; name?: string }): Promise<ToolResult> {
    const { id, name } = args;
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
      // FINLYNQ-267: resolve via the shared envelope — a mistyped/unmatched name
      // is REFUSED and a 2+ match returns an ambiguous list (was `fuzzyFind`
      // silent-first). `id` above is the FK fast-path.
      const env = resolveEntity({ entity: "category", name, options: allCats });
      if (env.status === "ambiguous") {
        const list = env.candidates.map((c) => `"${c.name}" (id=${c.id})`).join(", ");
        return err(`Category is ambiguous — ${env.candidates.length} matches: ${list}. Pass id to disambiguate.`);
      }
      if (env.status === "not_found") {
        return err(`Category "${name}" not found. Did you mean: ${suggestionList(name!, allCats)}?`);
      }
      cat = allCats.find((c) => Number(c.id) === env.id) ?? null;
    }
    if (!cat) return err(`Category "${name}" not found.`);
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
    const confirmationToken = signPreviewToken(userId, "delete_category", { id: catId });

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

  // ── op: delete (commit) — lifted VERBATIM from delete_category ──────────────
  async function opDeleteCommit(args: { id: number; confirmation_token: string }): Promise<ToolResult> {
    const { id, confirmation_token } = args;
    const check = verifyPreviewToken(confirmation_token, userId, "delete_category", { id });
    if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run manage_categories op=delete (no token) to preview.`);

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

  // ── op: create — lifted VERBATIM from create_category ──────────────────────
  async function opCreate(args: {
    name: string;
    type: "E" | "I" | "R";
    group?: string;
    note?: string;
  }): Promise<ToolResult> {
    const { name, type, group, note } = args;
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

  // ── consolidated tool ───────────────────────────────────────────────────────
  // `op: create | delete`. The delete op is a preview→confirmation-token
  // two-step: WITHOUT `confirmation_token` it returns FK counts + a token
  // (read-only preview); WITH the token it commits (refuses if FKs non-zero).
  registerManageTool(
    server,
    "manage_categories",
    "Manage transaction categories: `op` selects create / delete. create: a new category (name + type E/I/R). delete: TWO-STEP — call with `id`/`name` and NO `confirmation_token` to preview FK counts (transactions/rules/subscriptions) + get a token, then call again with `id` + that `confirmation_token` to commit. Delete refuses while any dependent still references the category.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("create"),
        name: z.string().describe("Category name (must be unique)"),
        type: z.enum(["E", "I", "R"]).describe("Type: 'E'=expense, 'I'=income, 'R'=transfer"),
        group: z.string().optional().describe("Group label (e.g. 'Housing', 'Food')"),
        note: z.string().optional(),
      }),
      z.object({
        op: z.literal("delete"),
        id: z.number().int().positive().optional().describe("Category FK (categories.id). Exact match — preferred. Required on the COMMIT call (with `confirmation_token`)."),
        name: z.string().optional().describe("Category name (fuzzy matched). Preview-only; requires an unlocked DEK. Pass `id` instead when no DEK is available."),
        confirmation_token: z.string().optional().describe("Token from the preview call for this exact id. Omit to preview; pass verbatim to commit. Single-use; 5-minute TTL."),
      }),
    ]),
    async (input) => {
      if (input.op === "create") return opCreate(input);
      // delete: token present → commit; absent → preview.
      if (input.confirmation_token) {
        if (input.id == null) return err("Pass `id` (numeric) with `confirmation_token` to commit the delete.");
        return opDeleteCommit({ id: input.id, confirmation_token: input.confirmation_token });
      }
      return opDeletePreview({ id: input.id, name: input.name });
    },
  );

  // ── hidden back-compat aliases (removed in v4.1) ─────────────────────────────
  registerAlias(
    server,
    "preview_delete_category",
    "Preview deletion of a category. Returns the resolved category id/name plus FK row counts (transactions / rules / subscriptions still referencing it) and a confirmationToken for `delete_category`. The execute step refuses if any FK count is non-zero — reassign or delete dependents first via `preview_bulk_categorize` / `execute_bulk_categorize` (transactions), `update_rule` / `delete_rule` (auto-categorize rules), and `update_subscription` (subscriptions).",
    {
      id: z.number().int().positive().optional().describe("Category FK (categories.id). Exact match — preferred. Pass exactly one of id or name."),
      name: z.string().optional().describe("Category name (fuzzy matched against decrypted name). Requires an unlocked DEK because category names live in encrypted columns post Stream D Phase 4. Pass `id` instead when no DEK is available."),
    },
    async (args) => opDeletePreview(args),
  );
  registerAlias(
    server,
    "delete_category",
    "Delete a category. Refuses if any transactions / auto-categorize rules / subscriptions still reference it (use `preview_bulk_categorize` / `execute_bulk_categorize` to reassign first). MUST be preceded by `preview_delete_category` with a matching id — pass that call's `confirmationToken` here verbatim. The token is single-use and expires after 5 minutes.",
    {
      id: z.number().int().positive().describe("Category FK (categories.id) — must match the id from the preview that issued the token."),
      confirmation_token: z.string().describe("Token returned by `preview_delete_category` for this exact id. Single-use; 5-minute TTL."),
    },
    async (args) => opDeleteCommit(args),
  );
  registerAlias(
    server,
    "create_category",
    "Create a new transaction category",
    {
      name: z.string().describe("Category name (must be unique)"),
      type: z.enum(["E", "I", "R"]).describe("Type: 'E'=expense, 'I'=income, 'R'=transfer"),
      group: z.string().optional().describe("Group label (e.g. 'Housing', 'Food')"),
      note: z.string().optional(),
    },
    async (args) => opCreate(args),
  );
}
