/**
 * MCP HTTP tool group: goals (FINLYNQ-109 extraction; FINLYNQ-263 consolidation).
 *
 * FINLYNQ-263 phase 1 — the four per-verb goal tools (`add_goal`, `update_goal`,
 * `delete_goal`, and `get_goals` from reads.ts) are folded into ONE
 * `manage_goals` discriminated-union tool (`op: add | update | delete | list`).
 * The per-op handler bodies are lifted VERBATIM; only the enclosing function
 * wrapper + arg destructure changed. Each old name stays registered as a HIDDEN
 * back-compat alias (owner decision #1) that forwards to the same handler.
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
  decryptNameish,
  resolveEntity,
  resolveOrReport,
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  decryptField,
} from "../../src/lib/crypto/envelope";
import {
  encryptName,
} from "../../src/lib/crypto/encrypted-columns";
import {
  ymdDate,
} from "../lib/date-validators";
import { computeGoalProgress } from "../../src/lib/goals-progress";
import { todayISO } from "../../src/lib/utils/date";
import { registerManageTool, registerAlias } from "./_consolidate";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerGoalsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;

  // ── op: add ───────────────────────────────────────────────────────────────
  // Lifted verbatim from the former `add_goal` tool.
  async function opAdd(args: {
    name: string;
    type: "savings" | "debt_payoff" | "investment" | "emergency_fund";
    target_amount: number;
    deadline?: string;
    account?: string;
    account_id?: number;
    account_ids?: number[];
  }): Promise<ToolResult> {
    const { name, type, target_amount, deadline, account, account_id, account_ids } = args;
    // Resolve the canonical id list. account_ids wins; then the legacy single
    // `account`/`account_id`. FINLYNQ-267: a mistyped `account` name now REFUSES
    // the create (via resolveEntity → resolveOrReport) instead of silently
    // producing an UNLINKED goal (decision 5b — a user who typed a name intended
    // a link). account_id is the FK fast-path (wins over the fuzzy name).
    let resolvedIds: number[] = [];
    if (account_ids !== undefined) {
      resolvedIds = account_ids;
    } else if (account_id != null || account) {
      const rawAccounts = await q(db, sql`
        SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
      `);
      const allAccounts = decryptNameish(rawAccounts, dek);
      const out = resolveOrReport(
        "account",
        resolveEntity({ entity: "account", id: account_id, name: account, options: allAccounts }),
      );
      if ("report" in out) return out.report;
      resolvedIds = [out.id];
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

  // ── op: update ─────────────────────────────────────────────────────────────
  // Lifted verbatim from the former `update_goal` tool.
  async function opUpdate(args: {
    goal?: string;
    goal_id?: number;
    target_amount?: number;
    deadline?: string;
    status?: "active" | "completed" | "paused";
    name?: string;
    account_ids?: number[];
  }): Promise<ToolResult> {
    const { goal, goal_id, target_amount, deadline, status, name, account_ids } = args;
    // FINLYNQ-267: `goal_id` FK fast-path wins; a name resolves via the shared
    // envelope (mistyped → refuse, 2+ → ambiguous — was `fuzzyFind` silent-first).
    const rawGoals = await q(db, sql`SELECT id, name_ct FROM goals WHERE user_id = ${userId}`);
    const allGoals = decryptNameish(rawGoals, dek);
    const gout = resolveOrReport("goal", resolveEntity({ entity: "goal", id: goal_id, name: goal, options: allGoals }));
    if ("report" in gout) return gout.report;
    const g = allGoals.find((x) => Number(x.id) === gout.id) ?? { id: gout.id, name: null };

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

  // ── op: delete ─────────────────────────────────────────────────────────────
  // Lifted verbatim from the former `delete_goal` tool.
  async function opDelete(args: { goal?: string; goal_id?: number }): Promise<ToolResult> {
    const { goal, goal_id } = args;
    // FINLYNQ-267: `goal_id` FK fast-path wins; name via the shared envelope.
    const rawGoals = await q(db, sql`SELECT id, name_ct FROM goals WHERE user_id = ${userId}`);
    const allGoals = decryptNameish(rawGoals, dek);
    const gout = resolveOrReport("goal", resolveEntity({ entity: "goal", id: goal_id, name: goal, options: allGoals }));
    if ("report" in gout) return gout.report;
    const g = allGoals.find((x) => Number(x.id) === gout.id) ?? { id: gout.id, name: null };

    await db.execute(sql`DELETE FROM goals WHERE id = ${g.id} AND user_id = ${userId}`);
    return text({ success: true, data: { message: `Goal "${g.name ?? `#${g.id}`}" deleted` } });
  }

  // ── op: list ───────────────────────────────────────────────────────────────
  // Lifted verbatim from the former `get_goals` tool (was in reads.ts).
  async function opList(): Promise<ToolResult> {
    const goalsRaw = await q(db, sql`
      SELECT g.id, g.name_ct, g.type, g.target_amount, g.currency, g.deadline, g.status, g.priority
      FROM goals g
      WHERE g.user_id = ${userId}
      ORDER BY g.priority
    `);
    if (!goalsRaw.length) return dataResponse([]);
    const goalIds = goalsRaw.map((g) => Number(g.id));
    const goalIdsExpr = sql.join(goalIds.map((id) => sql`${id}`), sql`, `);
    const linksRaw = await q(db, sql`
      SELECT ga.goal_id, ga.account_id, a.name_ct AS account_name_ct
      FROM goal_accounts ga
      LEFT JOIN accounts a ON ga.account_id = a.id
      WHERE ga.user_id = ${userId} AND ga.goal_id = ANY(ARRAY[${goalIdsExpr}]::int[])
    `);
    const linksByGoal = new Map<number, { ids: number[]; names: string[] }>();
    for (const l of linksRaw) {
      const goalId = Number(l.goal_id);
      const accountId = Number(l.account_id);
      const acctName = l.account_name_ct && dek ? decryptField(dek, l.account_name_ct) : null;
      const entry = linksByGoal.get(goalId) ?? { ids: [], names: [] };
      entry.ids.push(accountId);
      entry.names.push(acctName ?? "");
      linksByGoal.set(goalId, entry);
    }
    // FINLYNQ-268: per-goal valuation basis. A goal contributes MARKET value
    // for its investment-linked accounts (needs a DEK) and LEDGER (net
    // contributions) for cash accounts — so the honest per-goal `basis` is
    // 'market' iff the goal links ≥1 investment account AND a DEK is present,
    // else 'ledger'. This LABELS `computeGoalProgress`'s existing mix without
    // changing its math (values byte-identical).
    const allLinkedAccountIds = Array.from(
      new Set([...linksByGoal.values()].flatMap((l) => l.ids)),
    );
    const investmentAccountIds = new Set<number>();
    if (allLinkedAccountIds.length > 0) {
      const invExpr = sql.join(allLinkedAccountIds.map((id) => sql`${id}`), sql`, `);
      const invRows = await q(db, sql`
        SELECT id FROM accounts
        WHERE user_id = ${userId} AND is_investment = TRUE
          AND id = ANY(ARRAY[${invExpr}]::int[])
      `);
      for (const r of invRows) investmentAccountIds.add(Number(r.id));
    }

    // Issue #233 — surface progress numbers via the shared helper so MCP
    // HTTP and REST `/api/goals` can't drift. Pure aggregation; no name
    // decryption involved.
    const progressByGoal = await computeGoalProgress(
      userId,
      dek,
      goalsRaw.map((r) => ({
        id: Number(r.id),
        currency: (r.currency as string | null) ?? null,
        targetAmount: Number(r.target_amount ?? 0),
        deadline: (r.deadline as string | null) ?? null,
        accountIds: linksByGoal.get(Number(r.id))?.ids ?? [],
      })),
    );
    const rows = goalsRaw.map((r) => {
      const { name_ct, ...rest } = r;
      const links = linksByGoal.get(Number(r.id)) ?? { ids: [], names: [] };
      const progress = progressByGoal.get(Number(r.id));
      // FINLYNQ-268: 'market' when the goal links an investment account AND a
      // DEK is present (else that account's holdings can't be priced), else
      // 'ledger' (net contributions).
      const hasInvestment = links.ids.some((id) => investmentAccountIds.has(id));
      const basis: "market" | "ledger" = hasInvestment && dek != null ? "market" : "ledger";
      return {
        ...rest,
        name: name_ct && dek ? decryptField(dek, name_ct) : null,
        accountIds: links.ids,
        accounts: links.names,
        basis,
        ...(basis === "market" ? { asOf: todayISO() } : {}),
        currentAmount: progress?.currentAmount ?? 0,
        progress: progress?.progress ?? 0,
        percentComplete: progress?.progress ?? 0,
        remaining: progress?.remaining ?? Number(r.target_amount ?? 0),
        monthlyNeeded: progress?.monthlyNeeded ?? 0,
      };
    });
    return dataResponse(rows);
  }

  // ── consolidated tool ───────────────────────────────────────────────────────
  const addVariant = z.object({
    op: z.literal("add"),
    name: z.string().describe("Goal name"),
    type: z.enum(["savings", "debt_payoff", "investment", "emergency_fund"]).describe("Goal type"),
    target_amount: z.number().positive().describe("Target amount (must be > 0)"),
    deadline: ymdDate.optional().describe("Deadline (YYYY-MM-DD)"),
    account: z.string().optional().describe("Legacy single-account linker — name or alias (fuzzy matched). A mistyped/unmatched name is REFUSED (never silently unlinked). Prefer `account_id` or `account_ids`."),
    account_id: z.number().int().positive().optional().describe("Single-account linker FK fast-path — wins over the fuzzy `account` name. Prefer `account_ids` for multi-account goals."),
    account_ids: z.array(z.number().int()).optional().describe("Multi-account linker (issue #130). Goal progress sums transactions across every account id supplied. Each id must belong to the user. Empty array = unlinked (manual tracking)."),
  });
  const updateVariant = z.object({
    op: z.literal("update"),
    goal: z.string().optional().describe("Goal name (fuzzy matched — mistyped/unmatched is REFUSED; 2+ → ambiguous). Pass this OR `goal_id`."),
    goal_id: z.number().int().positive().optional().describe("Goal FK fast-path — wins over the fuzzy `goal` name."),
    target_amount: z.number().positive().optional().describe("Target amount (must be > 0)"),
    deadline: ymdDate.optional().describe("YYYY-MM-DD"),
    status: z.enum(["active", "completed", "paused"]).optional(),
    name: z.string().optional().describe("Rename the goal"),
    account_ids: z.array(z.number().int()).optional().describe("Replace the goal's linked accounts (issue #130). When supplied, the existing goal_accounts rows are deleted and replaced with the new set in a single transaction. Pass `[]` to unlink all. Omit to leave links unchanged."),
  });
  const deleteVariant = z.object({
    op: z.literal("delete"),
    goal: z.string().optional().describe("Goal name (fuzzy matched — mistyped/unmatched is REFUSED; 2+ → ambiguous). Pass this OR `goal_id`."),
    goal_id: z.number().int().positive().optional().describe("Goal FK fast-path — wins over the fuzzy `goal` name."),
  });
  const listVariant = z.object({
    op: z.literal("list").describe("List all goals with progress."),
  });

  registerManageTool(
    server,
    "manage_goals",
    "Manage financial goals: `op` selects add / update / delete / list. add: create a goal (name/type/target_amount, optional deadline + account_ids). update: change a goal's target, deadline, status, name, or linked accounts (fuzzy `goal`). delete: remove a goal by name. list: all goals with progress (accountIds, currentAmount, progress, remaining, monthlyNeeded).",
    z.discriminatedUnion("op", [addVariant, updateVariant, deleteVariant, listVariant]),
    async (input) => {
      switch (input.op) {
        case "add":
          return opAdd(input);
        case "update":
          return opUpdate(input);
        case "delete":
          return opDelete(input);
        case "list":
          return opList();
      }
    },
  );

  // ── hidden back-compat aliases (removed in v4.1) ─────────────────────────────
  registerAlias(
    server,
    "add_goal",
    "Create a new financial goal. `account_ids` (issue #130) accepts 0..N account ids — the goal's progress sums across all linked accounts. Legacy single `account` (fuzzy-matched name) is still accepted as a single-element list. Pass `account_ids: []` for a manual-tracking goal.",
    {
      name: z.string().describe("Goal name"),
      type: z.enum(["savings", "debt_payoff", "investment", "emergency_fund"]).describe("Goal type"),
      target_amount: z.number().positive().describe("Target amount (must be > 0)"),
      deadline: ymdDate.optional().describe("Deadline (YYYY-MM-DD)"),
      account: z.string().optional().describe("Legacy single-account linker — name or alias (fuzzy matched). A mistyped/unmatched name is REFUSED (never silently unlinked). Prefer `account_id` or `account_ids`."),
      account_id: z.number().int().positive().optional().describe("Single-account linker FK fast-path — wins over the fuzzy `account` name. Prefer `account_ids` for multi-account goals."),
      account_ids: z.array(z.number().int()).optional().describe("Multi-account linker (issue #130). Goal progress sums transactions across every account id supplied. Each id must belong to the user. Empty array = unlinked (manual tracking)."),
    },
    async (args) => opAdd(args),
  );
  registerAlias(
    server,
    "update_goal",
    "Update a financial goal's target, deadline, status, or linked accounts. `account_ids` (issue #130) replaces the existing account-link set atomically — pass `[]` to unlink all, or omit to leave links unchanged.",
    {
      goal: z.string().optional().describe("Goal name (fuzzy matched — mistyped/unmatched is REFUSED; 2+ → ambiguous). Pass this OR `goal_id`."),
      goal_id: z.number().int().positive().optional().describe("Goal FK fast-path — wins over the fuzzy `goal` name."),
      target_amount: z.number().positive().optional().describe("Target amount (must be > 0)"),
      deadline: ymdDate.optional().describe("YYYY-MM-DD"),
      status: z.enum(["active", "completed", "paused"]).optional(),
      name: z.string().optional().describe("Rename the goal"),
      account_ids: z.array(z.number().int()).optional().describe("Replace the goal's linked accounts (issue #130). When supplied, the existing goal_accounts rows are deleted and replaced with the new set in a single transaction. Pass `[]` to unlink all. Omit to leave links unchanged."),
    },
    async (args) => opUpdate(args),
  );
  registerAlias(
    server,
    "delete_goal",
    "Delete a financial goal by name or id",
    {
      goal: z.string().optional().describe("Goal name (fuzzy matched — mistyped/unmatched is REFUSED; 2+ → ambiguous). Pass this OR `goal_id`."),
      goal_id: z.number().int().positive().optional().describe("Goal FK fast-path — wins over the fuzzy `goal` name."),
    },
    async (args) => opDelete(args),
  );
  registerAlias(
    server,
    "get_goals",
    "Get all financial goals with progress. Each goal carries `accountIds: number[]` (every linked account) and `accounts: string[]` (decrypted display names) — issue #130 multi-account linking. Numeric progress fields (issue #233): `currentAmount` (in goal currency), `progress` and `percentComplete` (0..100, 1dp), `remaining`, `monthlyNeeded` (when a deadline is set).",
    {},
    async () => opList(),
  );

}
