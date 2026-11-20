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
import { growthGoalRefusal, normalizeProgressMode } from "../../src/lib/goals/progress-mode";
import { todayISO } from "../../src/lib/utils/date";
import { pickRecordCurrency } from "../../src/lib/fx/record-currency";
import { resolveReportingCurrency } from "../reporting-currency";
import { registerManageTool } from "./_consolidate";

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
    currency?: string;
    progress_mode?: "balance" | "growth";
    start_date?: string;
  }): Promise<ToolResult> {
    const { name, type, target_amount, deadline, account, account_id, account_ids, currency } = args;
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
    // GH #423: a growth goal needs a start date and a linked account.
    const progressMode = args.progress_mode ?? "balance";
    const startDate = progressMode === "growth" ? args.start_date ?? null : null;
    const modeRefusal = growthGoalRefusal({ progressMode, startDate, accountIds: resolvedIds, today: todayISO() });
    if (modeRefusal) return err(modeRefusal);
    // Currency resolution (feedback #7): explicit > first linked account >
    // display currency. This INSERT used to omit the column entirely, so every
    // goal created through an assistant took the table default — CAD — even
    // for a USD user, and progress was then measured (and shown) in CAD.
    let accountCurrency: string | null = null;
    if (resolvedIds.length > 0) {
      const acct = await q(db, sql`
        SELECT currency FROM accounts WHERE user_id = ${userId} AND id = ${resolvedIds[0]}
      `);
      accountCurrency = (acct[0]?.currency as string | null | undefined) ?? null;
    }
    const goalCurrency = pickRecordCurrency({
      explicit: currency,
      accountCurrency,
      displayCurrency: await resolveReportingCurrency(db, userId, null),
    });
    const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
    // Stream D Phase 4 — plaintext name column dropped. Issue #130 — dual-write
    // the legacy `goals.account_id` (first id only) AND the goal_accounts join.
    const inserted = await q(db, sql`
      INSERT INTO goals (user_id, type, target_amount, currency, deadline, account_id, status, name_ct, name_lookup, progress_mode, start_date)
      VALUES (${userId}, ${type}, ${target_amount}, ${goalCurrency}, ${deadline ?? null}, ${resolvedIds[0] ?? null}, 'active', ${n.ct}, ${n.lookup}, ${progressMode}, ${startDate})
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
        currency: goalCurrency,
        progressMode,
        startDate,
        message: `Goal created: "${name}" — ${progressMode === "growth" ? `grow by ${target_amount} ${goalCurrency} from ${startDate}` : `target ${target_amount} ${goalCurrency}`}${deadline ? ` by ${deadline}` : ""}${resolvedIds.length > 0 ? ` linked to ${resolvedIds.length} account(s)` : ""}`,
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
    currency?: string;
    progress_mode?: "balance" | "growth";
    start_date?: string;
  }): Promise<ToolResult> {
    const { goal, goal_id, target_amount, deadline, status, name, account_ids, currency } = args;
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
    // GH #423: judge the goal as it will be after this update.
    if (args.progress_mode !== undefined || args.start_date !== undefined || account_ids !== undefined) {
      const cur = await q(db, sql`SELECT progress_mode, start_date FROM goals WHERE id = ${g.id} AND user_id = ${userId}`);
      const curLinks = account_ids ?? (
        await q(db, sql`SELECT account_id FROM goal_accounts WHERE goal_id = ${g.id} AND user_id = ${userId}`)
      ).map((r) => Number(r.account_id));
      const nextMode = args.progress_mode ?? normalizeProgressMode(cur[0]?.progress_mode);
      const nextStart = nextMode === "growth"
        ? (args.start_date ?? (cur[0]?.start_date as string | null | undefined) ?? null)
        : null;
      const modeRefusal = growthGoalRefusal({ progressMode: nextMode, startDate: nextStart, accountIds: curLinks, today: todayISO() });
      if (modeRefusal) return err(modeRefusal);
      updates.push(sql`progress_mode = ${nextMode}`, sql`start_date = ${nextStart}`);
    }
    if (name !== undefined) {
      if (!dek) return err("Cannot rename goal without an unlocked DEK (Stream D Phase 4).");
      const n = encryptName(dek, name);
      updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
    }
    if (target_amount !== undefined) updates.push(sql`target_amount = ${target_amount}`);
    if (deadline !== undefined) updates.push(sql`deadline = ${deadline}`);
    if (status !== undefined) updates.push(sql`status = ${status}`);
    // Re-denominates; does NOT convert target_amount (same contract as
    // manage_loans). Lets an assistant correct a goal the old CAD default
    // stamped wrongly.
    if (currency !== undefined) updates.push(sql`currency = ${currency.toUpperCase()}`);
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
      SELECT g.id, g.name_ct, g.type, g.target_amount, g.currency, g.deadline, g.status, g.priority,
             g.progress_mode, g.start_date
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
        type: (r.type as string | null) ?? null,
        currency: (r.currency as string | null) ?? null,
        targetAmount: Number(r.target_amount ?? 0),
        deadline: (r.deadline as string | null) ?? null,
        accountIds: linksByGoal.get(Number(r.id))?.ids ?? [],
        progressMode: (r.progress_mode as string | null) ?? null,
        startDate: (r.start_date as string | null) ?? null,
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
        // GH #423: for a growth goal currentAmount is the growth since
        // start_date; startAmount / balanceNow are the linked balance then and now.
        progressMode: progress?.progressMode ?? "balance",
        startAmount: progress?.startAmount ?? null,
        balanceNow: progress?.balanceNow ?? progress?.currentAmount ?? 0,
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
    currency: z.string().regex(/^[A-Za-z]{3,4}$/).optional().describe("ISO code the goal is measured in, e.g. 'EUR'. Defaults to the first linked account's currency, else the user's display currency — never a hardcoded default."),
    progress_mode: z.enum(["balance", "growth"]).optional().describe("'balance' (default): progress is the linked accounts' balance now. 'growth': progress is how much their balance grew since start_date, and target_amount is the amount to grow by. Use growth when the account already holds other money or is shared by several goals."),
    start_date: ymdDate.optional().describe("Growth goals: the first day counted (YYYY-MM-DD, not in the future). Progress = balance now minus balance at the end of the day before."),
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
    currency: z.string().regex(/^[A-Za-z]{3,4}$/).optional().describe("ISO code the goal is measured in. Changes the currency target_amount is interpreted in — it does NOT convert it."),
    progress_mode: z.enum(["balance", "growth"]).optional().describe("'balance' (default): progress is the linked accounts' balance now. 'growth': progress is how much their balance grew since start_date, and target_amount is the amount to grow by. Use growth when the account already holds other money or is shared by several goals."),
    start_date: ymdDate.optional().describe("Growth goals: the first day counted (YYYY-MM-DD, not in the future). Progress = balance now minus balance at the end of the day before."),
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
    "Manage financial goals: `op` selects add / update / delete / list. add: create a goal (name/type/target_amount, optional deadline, account_ids + currency, progress_mode balance|growth + start_date). update: change a goal's target, deadline, status, name, currency, linked accounts or progress mode (fuzzy `goal`). delete: remove a goal by name. list: all goals with progress (accountIds, currentAmount, progress, remaining, monthlyNeeded).",
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


}
