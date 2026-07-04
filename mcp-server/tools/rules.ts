/**
 * MCP HTTP tool group: rules (FINLYNQ-109 extraction).
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
  decryptField,
  encryptField,
} from "../../src/lib/crypto/envelope";
import {
  encryptRuleFields,
  decryptRuleFields,
} from "../../src/lib/rules/crypto";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";

export function registerRulesTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek } = ctx;


  // ── create_rule ────────────────────────────────────────────────────────────
  //
  // FINLYNQ-84: rules are JSONB conditions+actions. The legacy MCP shorthand
  // (match_payee + assign_category + rename_to? + assign_tags? + priority?)
  // is preserved for backwards compatibility — synthesized into a v2 rule
  // with a single payee/contains condition + a 1..3-action set.
  //
  // Issue #214 invariants preserved: `decryptNameish` BEFORE `fuzzyFind` on
  // the categories lookup — without it every row's name is undefined and
  // fuzzyFind's last reverse-includes step collapses to lo.includes("")
  // returning the first row.
  server.tool(
    "create_rule",
    "Create an auto-categorization rule for future imports. Legacy shorthand (match_payee + assign_category) is synthesized into a v2 rule (FINLYNQ-84).",
    {
      match_payee: z.string().describe("Payee pattern to match (substring, case-insensitive; legacy `%` wildcards are stripped)"),
      assign_category: z.string().describe("Category name to assign (fuzzy matched)"),
      rename_to: z.string().optional().describe("Optionally rename matched payee to this"),
      assign_tags: z.string().optional().describe("Tags to assign (comma-separated)"),
      priority: z.number().optional().describe("Rule priority (higher = checked first, default 0)"),
    },
    async ({ match_payee, assign_category, rename_to, assign_tags, priority }) => {
      const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
      const allCats = decryptNameish(rawCats, dek);
      const cat = fuzzyFind(assign_category, allCats);
      if (!cat) return err(`Category "${assign_category}" not found`);

      // Strip legacy `%` wildcards — the new condition's `op='contains'`
      // is substring-only.
      const cleanedValue = match_payee.replace(/%/g, "");
      const synthName = `Match "${cleanedValue}" → ${String(cat.name ?? "")}`.slice(0, 200);
      const todayISO = new Date().toISOString().split("T")[0];

      // Synthesize the v2 rule shape from the legacy shorthand.
      const conditions = { all: [{ field: "payee", op: "contains", value: cleanedValue }] };
      const actions: Array<Record<string, unknown>> = [
        { kind: "set_category", categoryId: Number(cat.id) },
      ];
      if (rename_to) actions.push({ kind: "rename_payee", to: rename_to });
      if (assign_tags) actions.push({ kind: "set_tags", tags: assign_tags });

      // Encrypt sensitive free-text (name + payee value + rename/tags) before
      // persisting (2026-06-01). FK ids stay plaintext so the matcher works
      // after a decrypt. plan/encryption-plaintext-gaps.md
      const enc = encryptRuleFields(dek, {
        name: synthName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conditions: conditions as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actions: actions as any,
      });

      await db.execute(sql`
        INSERT INTO transaction_rules
          (user_id, name, conditions, actions, priority, is_active, created_at)
        VALUES
          (${userId}, ${enc.name ?? synthName}, ${JSON.stringify(enc.conditions)}::jsonb,
           ${JSON.stringify(enc.actions)}::jsonb, ${priority ?? 0}, true, ${todayISO})
      `);
      return text({
        success: true,
        data: {
          message: `Rule created: "${cleanedValue}" → ${cat.name}${rename_to ? ` (rename to "${rename_to}")` : ""}`,
        },
      });
    }
  );


  // ── apply_rules_to_uncategorized ───────────────────────────────────────────
  //
  // FINLYNQ-84: rules are JSONB conditions+actions. This tool applies PURE
  // actions only (set_category, set_tags, rename_payee, set_entered_currency,
  // set_portfolio_holding). **Rules whose actions contain `set_account` or
  // `create_transfer` are REFUSED** here — those need approve-time staging
  // context to safely materialize without orphan balances / phantom debits.
  // Refusals surface in `skipped[]` so the caller can see what was passed.
  server.tool(
    "apply_rules_to_uncategorized",
    "Run all active categorization rules against uncategorized transactions. Rules with side-effect actions (set_account, create_transfer) are refused and surfaced in skipped[]; they need approve-time context.",
    {
      dry_run: z.boolean().optional().describe("Preview matches without saving (default false)"),
      limit: z.number().optional().describe("Max transactions to process (default 500)"),
    },
    async ({ dry_run, limit }) => {
      const maxRows = limit ?? 500;
      const txns = await q(db, sql`
        SELECT id, payee, amount, tags, account_id, date FROM transactions
        WHERE user_id = ${userId} AND (category_id IS NULL OR category_id = 0)
        ORDER BY date DESC LIMIT ${maxRows}
      `);
      if (!txns.length) return text({ success: true, data: { message: "No uncategorized transactions found", updated: 0 } });

      const rawRules = await q(db, sql`
        SELECT id, name, conditions, actions, priority
          FROM transaction_rules
         WHERE user_id = ${userId}
           AND is_active = true
         ORDER BY priority DESC
      `);
      // Pre-classify rules: those with side-effect actions get an explicit
      // `skipped[]` entry per match; the remaining rules go through the
      // normal apply loop.
      type ParsedRule = {
        id: number;
        name: string;
        conditions: { all: Array<{ field?: string; op?: string; value?: string; min?: number; max?: number; accountId?: number; weekday?: number; day?: number; from?: string; to?: string }> };
        actions: Array<{ kind: string; categoryId?: number; tags?: string; to?: string; currency?: string; holdingId?: number }>;
        priority: number;
        hasSideEffects: boolean;
      };
      const rules: ParsedRule[] = rawRules.map((r) => {
        // 2026-06-01 — decrypt rule sensitive free-text BEFORE the inline
        // matcher runs; the probe payee/tags below are decrypted too, so both
        // sides must be plaintext to match. FK ids stay plaintext.
        const dec = decryptRuleFields(dek, {
          name: String(r.name ?? ""),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          conditions: (r.conditions ?? { all: [] }) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          actions: (Array.isArray(r.actions) ? r.actions : []) as any,
        });
        const actions = (Array.isArray(dec.actions) ? dec.actions : []) as ParsedRule["actions"];
        const hasSideEffects = actions.some((a) => a.kind === "set_account" || a.kind === "create_transfer");
        return {
          id: Number(r.id),
          name: dec.name ?? String(r.name ?? ""),
          conditions: (dec.conditions ?? { all: [] }) as ParsedRule["conditions"],
          actions,
          priority: Number(r.priority ?? 0),
          hasSideEffects,
        };
      });

      // Inline matcher — supports payee/note/tags/amount/account/currency/date predicates.
      function matchesProbe(probe: { payee: string; tags: string; amount: number; accountId: number | null; date: string }, conds: ParsedRule["conditions"]): boolean {
        const all = conds.all ?? [];
        if (all.length === 0) return false;
        return all.every((c) => {
          const field = c.field ?? "";
          const op = c.op ?? "";
          if (field === "payee" || field === "tags") {
            const v = String(c.value ?? "");
            const haystack = (field === "tags" ? probe.tags : probe.payee).toLowerCase();
            const needle = v.toLowerCase();
            if (op === "contains") return haystack.includes(needle);
            if (op === "exact") return haystack === needle;
            if (op === "regex") { try { return new RegExp(v, "i").test(field === "tags" ? probe.tags : probe.payee); } catch { return false; } }
            return false;
          }
          if (field === "note") {
            // record_transaction's autoCategory writes don't carry note; skip.
            return false;
          }
          if (field === "amount") {
            if (op === "between") return probe.amount >= (c.min ?? -Infinity) && probe.amount <= (c.max ?? Infinity);
            const v = Number(c.value);
            if (Number.isNaN(v)) return false;
            if (op === "gt") return probe.amount > v;
            if (op === "lt") return probe.amount < v;
            if (op === "eq") return Math.abs(probe.amount - v) < 0.01;
            return false;
          }
          if (field === "account") {
            if (probe.accountId == null || c.accountId == null) return op === "is_not";
            return op === "is" ? probe.accountId === c.accountId : probe.accountId !== c.accountId;
          }
          if (field === "currency") {
            // Without a JOIN to accounts we can't probe entered currency here; skip.
            return false;
          }
          if (field === "date") {
            const dStr = probe.date;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dStr)) return false;
            const d = new Date(`${dStr}T00:00:00Z`);
            if (op === "weekday") return d.getUTCDay() === Number(c.weekday);
            if (op === "day_of_month") return d.getUTCDate() === Number(c.day);
            if (op === "between") return dStr >= String(c.from ?? "") && dStr <= String(c.to ?? "");
            return false;
          }
          return false;
        });
      }

      let updated = 0;
      const preview: { id: number; payee: string; categoryId: number }[] = [];
      const skipped: { ruleId: number; reason: string; txnId?: number }[] = [];

      for (const txn of txns) {
        const plainPayee = dek ? (decryptField(dek, String(txn.payee ?? "")) ?? "") : String(txn.payee ?? "");
        const plainTags = dek ? (decryptField(dek, String(txn.tags ?? "")) ?? "") : String(txn.tags ?? "");
        const probe = {
          payee: plainPayee,
          tags: plainTags,
          amount: Number(txn.amount),
          accountId: txn.account_id == null ? null : Number(txn.account_id),
          date: String(txn.date ?? ""),
        };
        for (const rule of rules) {
          if (!matchesProbe(probe, rule.conditions)) continue;
          if (rule.hasSideEffects) {
            skipped.push({ ruleId: rule.id, reason: "requires_staging", txnId: Number(txn.id) });
            break; // first-match-wins: same as legacy
          }
          // Resolve the pure-action patch inline (mirrors computePureActionPatch).
          let categoryId: number | undefined;
          let renameTo: string | undefined;
          let assignTags: string | undefined;
          for (const a of rule.actions) {
            if (a.kind === "set_category" && typeof a.categoryId === "number") categoryId = a.categoryId;
            else if (a.kind === "rename_payee" && typeof a.to === "string") renameTo = a.to;
            else if (a.kind === "set_tags" && typeof a.tags === "string") assignTags = a.tags;
          }
          if (categoryId == null) {
            // Rule matched but has no set_category action — pipeline-only
            // actions (rename_payee / set_tags) on uncategorized rows aren't
            // useful here; skip silently to give next-priority rule a chance.
            continue;
          }
          if (!dry_run) {
            const encRename = renameTo != null && dek ? encryptField(dek, renameTo) : renameTo;
            const encTags = assignTags != null && dek ? encryptField(dek, assignTags) : assignTags;
            // Audit trio: updated_at + source. source = mcp_http is INSERT-only
            // per CLAUDE.md; on UPDATE we preserve the existing value. Stamp
            // updated_at = NOW() per issue #28.
            await db.execute(sql`
              UPDATE transactions SET category_id = ${categoryId}
              ${renameTo != null ? sql`, payee = ${encRename}` : sql``}
              ${assignTags != null ? sql`, tags = ${encTags}` : sql``}
              , updated_at = NOW()
              WHERE id = ${txn.id} AND user_id = ${userId}
            `);
          }
          preview.push({ id: Number(txn.id), payee: plainPayee, categoryId });
          updated++;
          break;
        }
      }

      if (!dry_run && updated > 0) invalidateUserTxCache(userId);
      return text({
        success: true,
        data: {
          dry_run: dry_run ?? false,
          updated,
          scanned: txns.length,
          matches: preview.slice(0, 20),
          skipped,
          message: dry_run ? `Would update ${updated} of ${txns.length} transactions` : `Updated ${updated} of ${txns.length} transactions`,
        },
      });
    }
  );


  // ── list_rules ────────────────────────────────────────────────────────────
  // FINLYNQ-84: returns JSONB conditions + actions. Category/account/holding
  // names referenced inside actions are decrypted in a single batch + attached
  // as actionFKNames map for human-readable rendering.
  server.tool(
    "list_rules",
    "List all auto-categorization rules. Returns JSONB conditions + actions (FINLYNQ-84 v2 shape) plus decrypted FK names for human-readable rendering.",
    {},
    async () => {
      const rawRows = await q(db, sql`
        SELECT id, name, conditions, actions, is_active, priority, created_at, updated_at
        FROM transaction_rules
        WHERE user_id = ${userId}
        ORDER BY priority DESC, id
      `);
      // Collect every FK referenced in actions across all rules.
      const categoryIds = new Set<number>();
      const accountIds = new Set<number>();
      const holdingIds = new Set<number>();
      for (const r of rawRows) {
        const actions = Array.isArray(r.actions) ? r.actions as Array<Record<string, unknown>> : [];
        for (const a of actions) {
          if (a.kind === "set_category" && typeof a.categoryId === "number") categoryIds.add(a.categoryId);
          else if (a.kind === "set_account" && typeof a.accountId === "number") accountIds.add(a.accountId);
          else if (a.kind === "set_portfolio_holding" && typeof a.holdingId === "number") holdingIds.add(a.holdingId);
          else if (a.kind === "create_transfer" && typeof a.destAccountId === "number") accountIds.add(a.destAccountId);
        }
      }
      const categoryNames: Record<number, string | null> = {};
      const accountNames: Record<number, string | null> = {};
      const holdingNames: Record<number, string | null> = {};
      if (categoryIds.size > 0) {
        const catRows = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
        for (const r of catRows) {
          if (!categoryIds.has(Number(r.id))) continue;
          categoryNames[Number(r.id)] = r.name_ct && dek ? decryptField(dek, String(r.name_ct)) : null;
        }
      }
      if (accountIds.size > 0) {
        const acctRows = await q(db, sql`SELECT id, name_ct FROM accounts WHERE user_id = ${userId}`);
        for (const r of acctRows) {
          if (!accountIds.has(Number(r.id))) continue;
          accountNames[Number(r.id)] = r.name_ct && dek ? decryptField(dek, String(r.name_ct)) : null;
        }
      }
      if (holdingIds.size > 0) {
        const holdRows = await q(db, sql`SELECT id, name_ct FROM portfolio_holdings WHERE user_id = ${userId}`);
        for (const r of holdRows) {
          if (!holdingIds.has(Number(r.id))) continue;
          holdingNames[Number(r.id)] = r.name_ct && dek ? decryptField(dek, String(r.name_ct)) : null;
        }
      }
      const rows = rawRows.map((r) => {
        // Decrypt sensitive free-text (name + payee/note/tags condition values +
        // rename_payee.to + set_tags.tags) for display (2026-06-01). FK ids
        // collected above are NOT encrypted, so the name batch-load is unaffected.
        const dec = decryptRuleFields(dek, {
          name: String(r.name ?? ""),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          conditions: (r.conditions ?? { all: [] }) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          actions: (Array.isArray(r.actions) ? r.actions : []) as any,
        });
        return {
          id: Number(r.id),
          name: dec.name ?? String(r.name ?? ""),
          conditions: dec.conditions ?? { all: [] },
          actions: dec.actions ?? [],
          is_active: r.is_active,
          priority: Number(r.priority ?? 0),
          created_at: r.created_at,
          updated_at: r.updated_at,
          actionFKNames: {
            categories: categoryNames,
            accounts: accountNames,
            holdings: holdingNames,
          },
        };
      });
      return text({ success: true, data: rows });
    }
  );


  // ── update_rule ───────────────────────────────────────────────────────────
  //
  // FINLYNQ-84: update_rule accepts both (a) the legacy shorthand
  // (match_payee + assign_category + rename_to? + assign_tags? + priority?)
  // which SYNTHESIZES the full conditions+actions replacement, and (b) the
  // v2 shape (conditions / actions). `name`, `is_active`, `priority` are
  // always optional updates. The legacy fields (match_field/match_type/
  // match_value/assign_category) are now ignored on the SQL side — they
  // only feed the legacy-synthesis path.
  server.tool(
    "update_rule",
    "Update an existing transaction rule. Accepts legacy shorthand (match_payee + assign_category) OR the v2 shape (conditions + actions, FINLYNQ-84).",
    {
      id: z.number().describe("Rule id"),
      name: z.string().optional(),
      match_payee: z.string().optional().describe("Legacy alias: sets a single payee/contains condition + set_category action"),
      assign_category: z.string().optional().describe("Legacy: category name (fuzzy matched)"),
      assign_tags: z.string().optional().describe("Legacy: tags assigned by the rule"),
      rename_to: z.string().optional().describe("Legacy: payee rename target"),
      conditions: z.unknown().optional().describe("v2: full ConditionGroup JSON. Replaces conditions entirely."),
      actions: z.unknown().optional().describe("v2: full Action[] JSON. Replaces actions entirely."),
      is_active: z.boolean().optional(),
      priority: z.number().optional(),
    },
    async ({ id, name, match_payee, assign_category, assign_tags, rename_to, conditions, actions, is_active, priority }) => {
      const existing = await q(db, sql`SELECT id FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Rule #${id} not found`);

      // Resolve legacy shorthand into a conditions/actions replacement (if any
      // legacy field is set). Mixing legacy + v2 in one call is rejected.
      const hasLegacy = match_payee !== undefined || assign_category !== undefined
        || assign_tags !== undefined || rename_to !== undefined;
      const hasV2 = conditions !== undefined || actions !== undefined;
      if (hasLegacy && hasV2) {
        return err("Cannot mix legacy shorthand (match_payee/assign_category) with v2 shape (conditions/actions) on the same update_rule call");
      }

      let condsObj: unknown | undefined;
      let actionsObj: unknown | undefined;

      if (hasLegacy) {
        // Synthesize the full replacement.
        if (match_payee === undefined || assign_category === undefined) {
          return err("Legacy shorthand requires both match_payee and assign_category");
        }
        let assignCategoryId: number | null = null;
        if (assign_category !== "") {
          const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
          const allCats = decryptNameish(rawCats, dek);
          const cat = fuzzyFind(assign_category, allCats);
          if (!cat) return err(`Category "${assign_category}" not found`);
          assignCategoryId = Number(cat.id);
        }
        const cleanedValue = match_payee.replace(/%/g, "");
        condsObj = { all: [{ field: "payee", op: "contains", value: cleanedValue }] };
        const actionsArr: Array<Record<string, unknown>> = [];
        if (assignCategoryId != null) actionsArr.push({ kind: "set_category", categoryId: assignCategoryId });
        if (rename_to != null) actionsArr.push({ kind: "rename_payee", to: rename_to });
        if (assign_tags != null) actionsArr.push({ kind: "set_tags", tags: assign_tags });
        if (actionsArr.length === 0) return err("Legacy shorthand resolves to an empty action list — pass assign_category");
        actionsObj = actionsArr;
      } else if (hasV2) {
        if (conditions !== undefined) condsObj = conditions;
        if (actions !== undefined) actionsObj = actions;
      }

      // Encrypt sensitive free-text (name + payee/note/tags values + rename/tags)
      // before persisting (2026-06-01). FK ids stay plaintext. Undefined slices
      // are no-ops inside encryptRuleFields. plan/encryption-plaintext-gaps.md
      const enc = encryptRuleFields(dek, {
        name,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        conditions: condsObj as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actions: actionsObj as any,
      });

      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) updates.push(sql`name = ${enc.name ?? name}`);
      if (condsObj !== undefined) updates.push(sql`conditions = ${JSON.stringify(enc.conditions)}::jsonb`);
      if (actionsObj !== undefined) updates.push(sql`actions = ${JSON.stringify(enc.actions)}::jsonb`);
      if (is_active !== undefined) updates.push(sql`is_active = ${is_active}`);
      if (priority !== undefined) updates.push(sql`priority = ${priority}`);
      updates.push(sql`updated_at = NOW()`);
      if (updates.length === 1) return err("No fields to update");

      await db.execute(sql`UPDATE transaction_rules SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Rule #${id} updated (${updates.length - 1} field(s))` } });
    }
  );


  // ── delete_rule ───────────────────────────────────────────────────────────
  server.tool(
    "delete_rule",
    "Delete a transaction rule by id",
    { id: z.number().describe("Rule id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Rule #${id} not found`);
      await db.execute(sql`DELETE FROM transaction_rules WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Rule "${existing[0].name}" deleted` } });
    }
  );


  // ── test_rule ─────────────────────────────────────────────────────────────
  server.tool(
    "test_rule",
    "Dry-run a rule pattern against the user's existing transactions. Decrypts payee/tags in memory when matching. Returns matched rows without writing.",
    {
      match_payee: z.string().optional().describe("Payee pattern (required if match_field='payee' or match_type omitted)"),
      match_field: z.enum(["payee", "amount", "tags"]).optional().describe("Default 'payee'"),
      match_type: z.enum(["contains", "exact", "regex", "greater_than", "less_than"]).optional().describe("Default 'contains'"),
      match_value: z.string().optional().describe("Overrides match_payee when match_field != 'payee'"),
      match_amount: z.number().optional().describe("Alias — set as match_value when match_field='amount'"),
      sample_size: z.number().optional().describe("Max transactions to scan (default 5000)"),
    },
    async ({ match_payee, match_field, match_type, match_value, match_amount, sample_size }) => {
      const field = match_field ?? "payee";
      const type = match_type ?? "contains";
      const value =
        match_value !== undefined ? match_value :
        match_amount !== undefined ? String(match_amount) :
        match_payee ?? "";
      if (!value && field !== "amount") return err("match_value or match_payee is required");
      const limit = sample_size ?? 5000;

      // Stream D Phase 4: c.name + a.name dropped — read *_ct only.
      const rawTxns = await q(db, sql`
        SELECT t.id, t.date, t.payee, t.tags, t.amount, t.category_id,
               c.name_ct AS category_name_ct,
               t.account_id, a.name_ct AS account_name_ct
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
        ORDER BY t.date DESC, t.id DESC
        LIMIT ${limit}
      `);
      const raw: Row[] = rawTxns.map((r) => {
        const { category_name_ct, account_name_ct, ...rest } = r;
        return {
          ...rest,
          category_name: category_name_ct && dek ? decryptField(dek, category_name_ct) : null,
          account_name: account_name_ct && dek ? decryptField(dek, account_name_ct) : null,
        };
      });

      // Decrypt payee/tags in memory (identical pattern to apply_rules_to_uncategorized).
      const matched: Record<string, unknown>[] = [];
      const valueLower = value.toLowerCase();
      let regex: RegExp | null = null;
      if (type === "regex") {
        try { regex = new RegExp(value, "i"); }
        catch { return err(`Invalid regex: ${value}`); }
      }
      const ruleAmount = field === "amount" ? parseFloat(value) : NaN;

      for (const r of raw) {
        const plainPayee = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
        const plainTags = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
        let hit = false;
        if (field === "amount") {
          if (isNaN(ruleAmount)) continue;
          const amt = Number(r.amount);
          if (type === "greater_than") hit = amt > ruleAmount;
          else if (type === "less_than") hit = amt < ruleAmount;
          else if (type === "exact") hit = Math.abs(amt - ruleAmount) < 0.01;
        } else {
          const fieldVal = (field === "payee" ? plainPayee : plainTags).toLowerCase();
          if (type === "contains") hit = fieldVal.includes(valueLower);
          else if (type === "exact") hit = fieldVal === valueLower;
          else if (type === "regex" && regex) hit = regex.test(field === "payee" ? plainPayee : plainTags);
        }
        if (hit) {
          matched.push({
            id: Number(r.id),
            date: r.date,
            payee: plainPayee,
            tags: plainTags,
            amount: Number(r.amount),
            category: r.category_name,
            account: r.account_name,
          });
        }
      }

      return text({
        success: true,
        data: {
          scanned: raw.length,
          matchedCount: matched.length,
          matches: matched.slice(0, 50),
          rulePreview: { field, type, value },
          note: matched.length > 50 ? `Showing 50 of ${matched.length} matches` : undefined,
        },
      });
    }
  );


  // ── reorder_rules ─────────────────────────────────────────────────────────
  server.tool(
    "reorder_rules",
    "Reorder rules by assigning new priorities. The first id in `ordered_ids` gets the highest priority.",
    {
      ordered_ids: z.array(z.number()).min(1).describe("Rule ids in desired execution order (first = highest priority)"),
    },
    async ({ ordered_ids }) => {
      // Verify ownership of every id before writing anything.
      // Defense-in-depth (low finding, SECURITY_REVIEW 2026-05-06): use a
      // parameterized `ANY(ARRAY[…]::int[])` builder rather than concatenating
      // a CSV. Number() coercion still gates upstream so this is currently
      // safe; the swap removes the fragile pattern.
      const orderedIdsExpr = sql.join(ordered_ids.map((n) => sql`${Number(n)}`), sql`, `);
      const owned = await q(db, sql`
        SELECT id FROM transaction_rules WHERE user_id = ${userId} AND id = ANY(ARRAY[${orderedIdsExpr}]::int[])
      `);
      if (owned.length !== ordered_ids.length) {
        return err(`One or more rule ids are not owned by this user (expected ${ordered_ids.length}, found ${owned.length})`);
      }
      // Highest priority for the first id, decrementing down.
      // Use a wide base so new rules default (priority 0) land below.
      const base = ordered_ids.length * 10;
      for (let i = 0; i < ordered_ids.length; i++) {
        const priority = base - i * 10;
        await db.execute(sql`UPDATE transaction_rules SET priority = ${priority} WHERE id = ${ordered_ids[i]} AND user_id = ${userId}`);
      }
      return text({ success: true, data: { reordered: ordered_ids.length, order: ordered_ids } });
    }
  );


  // ── suggest_transaction_details ───────────────────────────────────────────
  server.tool(
    "suggest_transaction_details",
    "Suggest category + tags for a transaction based on rule matches and historical frequency. Decrypts payees in memory when matching history.",
    {
      payee: z.string().describe("Payee/merchant name"),
      amount: z.number().optional().describe("Transaction amount (for amount-based rules)"),
      account_id: z.number().optional().describe("Reserved for future use — account-scoped suggestions"),
      top_n: z.number().optional().describe("Max category suggestions (default 3)"),
    },
    async ({ payee, amount, account_id: _account_id, top_n }) => {
      const topN = top_n ?? 3;
      if (!payee.trim()) return err("payee is required");

      // 1. Rule match — FINLYNQ-84 JSONB conditions+actions.
      const rules = await q(db, sql`
        SELECT id, name, conditions, actions, priority
        FROM transaction_rules
        WHERE user_id = ${userId} AND is_active = true
        ORDER BY priority DESC, id
      `);
      const payeeLower = payee.toLowerCase();
      const matchedRules: Array<{ id: number; name: string; assignCategoryId: number | null; assignTags: string | null; renameTo: string | null }> = [];
      for (const r of rules) {
        // 2026-06-01 — decrypt rule sensitive free-text before matching against
        // the plaintext payee input. FK ids stay plaintext.
        const dec = decryptRuleFields(dek, {
          name: String(r.name ?? ""),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          conditions: (r.conditions ?? { all: [] }) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          actions: (Array.isArray(r.actions) ? r.actions : []) as any,
        });
        const conditions = (dec.conditions ?? { all: [] }) as { all: Array<Record<string, unknown>> };
        const actions = (Array.isArray(dec.actions) ? dec.actions : []) as Array<Record<string, unknown>>;
        // Probe — payee + amount only (this tool's input domain).
        const conds = conditions.all ?? [];
        if (conds.length === 0) continue;
        const allMatched = conds.every((c) => {
          const field = String(c.field ?? "");
          const op = String(c.op ?? "");
          if (field === "payee") {
            const v = String(c.value ?? "");
            const valLower = v.toLowerCase();
            if (op === "contains") return payeeLower.includes(valLower) || valLower.includes(payeeLower);
            if (op === "exact") return payeeLower === valLower;
            if (op === "regex") {
              try { return new RegExp(v, "i").test(payee); } catch { return false; }
            }
            return false;
          }
          if (field === "amount" && amount !== undefined) {
            if (op === "between") return amount >= Number(c.min ?? -Infinity) && amount <= Number(c.max ?? Infinity);
            const v = Number(c.value);
            if (Number.isNaN(v)) return false;
            if (op === "gt") return amount > v;
            if (op === "lt") return amount < v;
            if (op === "eq") return Math.abs(amount - v) < 0.01;
            return false;
          }
          // We don't have note/tags/account/currency/date in this surface.
          return false;
        });
        if (!allMatched) continue;
        // Surface the pure-action patch ids for caller convenience.
        let assignCategoryId: number | null = null;
        let assignTags: string | null = null;
        let renameTo: string | null = null;
        for (const a of actions) {
          if (a.kind === "set_category" && typeof a.categoryId === "number") assignCategoryId = a.categoryId;
          else if (a.kind === "set_tags" && typeof a.tags === "string") assignTags = a.tags;
          else if (a.kind === "rename_payee" && typeof a.to === "string") renameTo = a.to;
        }
        matchedRules.push({
          id: Number(r.id),
          name: dec.name ?? String(r.name ?? ""),
          assignCategoryId,
          assignTags,
          renameTo,
        });
      }

      // 2. Historical frequency — payee may be encrypted, so decrypt+match in memory.
      const raw = await q(db, sql`
        SELECT payee, category_id, tags
        FROM transactions
        WHERE user_id = ${userId} AND category_id IS NOT NULL AND payee IS NOT NULL AND payee <> ''
        ORDER BY date DESC, id DESC
        LIMIT 5000
      `);
      const catCounts = new Map<number, number>();
      const tagCounts = new Map<string, number>();
      for (const r of raw) {
        const p = dek ? (decryptField(dek, String(r.payee ?? "")) ?? "") : String(r.payee ?? "");
        if (p.toLowerCase().trim() !== payeeLower.trim()) continue;
        const cid = Number(r.category_id);
        if (cid) catCounts.set(cid, (catCounts.get(cid) ?? 0) + 1);
        const t = dek ? (decryptField(dek, String(r.tags ?? "")) ?? "") : String(r.tags ?? "");
        for (const tag of t.split(",").map((x) => x.trim()).filter(Boolean)) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      // Hydrate category names for the top-N counts. Stream D Phase 4:
      // plaintext name dropped; decrypt name_ct.
      const topCatIds = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN);
      const topCatIdsExpr = topCatIds.length
        ? sql.join(topCatIds.map(([id]) => sql`${Number(id)}`), sql`, `)
        : null;
      const categoryRows = topCatIdsExpr
        ? await q(db, sql`SELECT id, name_ct, type, "group" FROM categories WHERE user_id = ${userId} AND id = ANY(ARRAY[${topCatIdsExpr}]::int[])`)
        : [];
      const categorySuggestions = topCatIds.map(([id, count]) => {
        const c = categoryRows.find((x) => Number(x.id) === id);
        const ct = c?.name_ct as string | null | undefined;
        const name = ct && dek ? decryptField(dek, String(ct)) : null;
        return { id, count, name, type: c?.type ?? null, group: c?.group ?? null };
      });

      const topTags = Array.from(tagCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([tag, count]) => ({ tag, count }));

      return text({
        success: true,
        data: {
          payee,
          rules: matchedRules,
          categories: categorySuggestions,
          tags: topTags,
          historicalMatches: raw.length > 0 ? Array.from(catCounts.values()).reduce((s, n) => s + n, 0) : 0,
        },
      });
    }
  );
}
