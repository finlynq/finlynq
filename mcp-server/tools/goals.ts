/**
 * MCP HTTP tool group: goals (FINLYNQ-109 extraction).
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
  fuzzyFind,
  decryptNameish,
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
} from "../../src/lib/crypto/encrypted-columns";
import {
  ymdDate,
} from "../lib/date-validators";

export function registerGoalsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;


  // ── add_goal ───────────────────────────────────────────────────────────────
  server.tool(
    "add_goal",
    "Create a new financial goal. `account_ids` (issue #130) accepts 0..N account ids — the goal's progress sums across all linked accounts. Legacy single `account` (fuzzy-matched name) is still accepted as a single-element list. Pass `account_ids: []` for a manual-tracking goal.",
    {
      name: z.string().describe("Goal name"),
      type: z.enum(["savings", "debt_payoff", "investment", "emergency_fund"]).describe("Goal type"),
      target_amount: z.number().positive().describe("Target amount (must be > 0)"),
      deadline: ymdDate.optional().describe("Deadline (YYYY-MM-DD)"),
      account: z.string().optional().describe("Legacy single-account linker — name or alias (fuzzy matched). Prefer `account_ids` for multi-account goals."),
      account_ids: z.array(z.number().int()).optional().describe("Multi-account linker (issue #130). Goal progress sums transactions across every account id supplied. Each id must belong to the user. Empty array = unlinked (manual tracking)."),
    },
    async ({ name, type, target_amount, deadline, account, account_ids }) => {
      // Resolve the canonical id list. account_ids wins; fall back to fuzzy-match
      // on the legacy single `account` argument.
      let resolvedIds: number[] = [];
      if (account_ids !== undefined) {
        resolvedIds = account_ids;
      } else if (account) {
        const rawAccounts = await q(db, sql`
          SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const acct = fuzzyFind(account, allAccounts);
        if (acct) resolvedIds = [Number(acct.id)];
      }
      // Verify ownership for every supplied id.
      // Drizzle expands a JS array as separate scalars, so wrap in
      // `ARRAY[...]::int[]` (not `(${arr})::int[]` — that's a row-cast).
      if (resolvedIds.length > 0) {
        const idsExpr = sql.join(resolvedIds.map((id) => sql`${id}`), sql`, `);
        const owned = await q(db, sql`
          SELECT id FROM accounts WHERE user_id = ${userId} AND id = ANY(ARRAY[${idsExpr}]::int[])
        `);
        if (owned.length !== new Set(resolvedIds).size) {
          return err(`One or more account_ids are not owned by you.`);
        }
      }
      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      // Stream D Phase 4 — plaintext name column dropped. Issue #130 — dual-write
      // the legacy `goals.account_id` (first id only) AND the goal_accounts join.
      const inserted = await q(db, sql`
        INSERT INTO goals (user_id, type, target_amount, deadline, account_id, status, name_ct, name_lookup)
        VALUES (${userId}, ${type}, ${target_amount}, ${deadline ?? null}, ${resolvedIds[0] ?? null}, 'active', ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      const goalId = Number(inserted[0]?.id);
      if (goalId && resolvedIds.length > 0) {
        for (const accountId of resolvedIds) {
          await db.execute(sql`
            INSERT INTO goal_accounts (user_id, goal_id, account_id)
            VALUES (${userId}, ${goalId}, ${accountId})
            ON CONFLICT (goal_id, account_id, user_id) DO NOTHING
          `);
        }
      }
      return text({
        success: true,
        data: {
          goalId,
          accountIds: resolvedIds,
          message: `Goal created: "${name}" — target $${target_amount}${deadline ? ` by ${deadline}` : ""}${resolvedIds.length > 0 ? ` linked to ${resolvedIds.length} account(s)` : ""}`,
        },
      });
    }
  );


  // ── update_goal ────────────────────────────────────────────────────────────
  server.tool(
    "update_goal",
    "Update a financial goal's target, deadline, status, or linked accounts. `account_ids` (issue #130) replaces the existing account-link set atomically — pass `[]` to unlink all, or omit to leave links unchanged.",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
      target_amount: z.number().positive().optional().describe("Target amount (must be > 0)"),
      deadline: ymdDate.optional().describe("YYYY-MM-DD"),
      status: z.enum(["active", "completed", "paused"]).optional(),
      name: z.string().optional().describe("Rename the goal"),
      account_ids: z.array(z.number().int()).optional().describe("Replace the goal's linked accounts (issue #130). When supplied, the existing goal_accounts rows are deleted and replaced with the new set in a single transaction. Pass `[]` to unlink all. Omit to leave links unchanged."),
    },
    async ({ goal, target_amount, deadline, status, name, account_ids }) => {
      const rawGoals = await q(db, sql`SELECT id, name_ct FROM goals WHERE user_id = ${userId}`);
      const allGoals = decryptNameish(rawGoals, dek);
      const g = fuzzyFind(goal, allGoals);
      if (!g) return err(`Goal "${goal}" not found`);

      // Verify account ownership upfront so we don't half-apply.
      // Drizzle expands a JS array as separate scalars, so wrap in
      // `ARRAY[...]::int[]` (not `(${arr})::int[]` — that's a row-cast).
      if (account_ids && account_ids.length > 0) {
        const idsExpr = sql.join(account_ids.map((id) => sql`${id}`), sql`, `);
        const owned = await q(db, sql`
          SELECT id FROM accounts WHERE user_id = ${userId} AND id = ANY(ARRAY[${idsExpr}]::int[])
        `);
        if (owned.length !== new Set(account_ids).size) {
          return err(`One or more account_ids are not owned by you.`);
        }
      }

      // Stream D Phase 4 — plaintext name dropped.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        if (!dek) return err("Cannot rename goal without an unlocked DEK (Stream D Phase 4).");
        const n = encryptName(dek, name);
        updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
      }
      if (target_amount !== undefined) updates.push(sql`target_amount = ${target_amount}`);
      if (deadline !== undefined) updates.push(sql`deadline = ${deadline}`);
      if (status !== undefined) updates.push(sql`status = ${status}`);
      // Mirror the legacy single-account column (issue #130) — first id only.
      if (account_ids !== undefined) {
        updates.push(sql`account_id = ${account_ids[0] ?? null}`);
      }
      if (!updates.length) return err("No fields to update");

      const result = await db.execute(
        sql`UPDATE goals SET ${sql.join(updates, sql`, `)} WHERE id = ${g.id} AND user_id = ${userId}`
      );
      const affected =
        (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
          ? (result as { rowCount: number }).rowCount
          : null;
      if (affected === 0) return err(`Goal "${g.name}" not found or not owned by this user`);

      // Replace the join (DELETE existing + INSERT new). When the caller didn't
      // supply `account_ids`, leave the join untouched.
      if (account_ids !== undefined) {
        await db.execute(sql`
          DELETE FROM goal_accounts WHERE goal_id = ${g.id} AND user_id = ${userId}
        `);
        for (const accountId of account_ids) {
          await db.execute(sql`
            INSERT INTO goal_accounts (user_id, goal_id, account_id)
            VALUES (${userId}, ${g.id}, ${accountId})
            ON CONFLICT (goal_id, account_id, user_id) DO NOTHING
          `);
        }
      }

      return text({
        success: true,
        data: {
          accountIds: account_ids ?? null,
          message: `Goal "${g.name}" updated`,
        },
      });
    }
  );


  // ── delete_goal ────────────────────────────────────────────────────────────
  server.tool(
    "delete_goal",
    "Delete a financial goal by name",
    {
      goal: z.string().describe("Goal name (fuzzy matched)"),
    },
    async ({ goal }) => {
      const rawGoals = await q(db, sql`SELECT id, name_ct FROM goals WHERE user_id = ${userId}`);
      const allGoals = decryptNameish(rawGoals, dek);
      const g = fuzzyFind(goal, allGoals);
      if (!g) return err(`Goal "${goal}" not found`);

      await db.execute(sql`DELETE FROM goals WHERE id = ${g.id} AND user_id = ${userId}`);
      return text({ success: true, data: { message: `Goal "${g.name}" deleted` } });
    }
  );
}
