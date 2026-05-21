/**
 * FINLYNQ-84 — Transaction rules v2: multi-condition matching + richer actions.
 *
 * Zod discriminated unions for the new `transaction_rules` shape. Replaces the
 * legacy flat columns (`matchField`, `matchType`, `matchValue`, `assignCategoryId`,
 * `assignTags`, `renameTo`) with JSONB `conditions` (AND-only group of typed
 * conditions) + JSONB `actions` (typed action array).
 *
 * Load-bearing invariants enforced here:
 * - Condition composition is AND-only (`ConditionGroup.all[]`). No nested OR
 *   in v2; deferred to a future iteration if real-world rules demand it.
 * - `set_portfolio_holding` is assign-existing-id-only (no auto-create branch).
 *   Sidesteps the `holding_accounts` dual-write invariant — that's the job of
 *   `add_portfolio_holding`.
 * - `create_transfer.linkId` is NOT an action-config field. `link_id` is
 *   server-generated only (minted inside `createTransferPair`). The action
 *   carries only the destination account.
 *
 * See plan: pf-app/plan/finlynq-84-rules-v2.md
 * See living doc (post-ship): pf-app/docs/transaction-rules-v2.md
 */
import { z } from "zod";

const StringOp = z.enum(["contains", "exact", "regex"]);
const AmountOp = z.enum(["gt", "lt", "eq"]);
const SetOp = z.enum(["is", "is_not"]);

const StringCondition = z.object({
  field: z.enum(["payee", "note", "tags"]),
  op: StringOp,
  value: z.string().min(1).max(500),
});

const AmountConditionSingle = z.object({
  field: z.literal("amount"),
  op: AmountOp,
  value: z.number(),
});

const AmountConditionBetween = z.object({
  field: z.literal("amount"),
  op: z.literal("between"),
  min: z.number(),
  max: z.number(),
});

const AccountCondition = z.object({
  field: z.literal("account"),
  op: SetOp,
  accountId: z.number().int().positive(),
});

const CurrencyCondition = z.object({
  field: z.literal("currency"),
  op: SetOp,
  value: z.string().length(3).toUpperCase(),
});

const DateWeekdayCondition = z.object({
  field: z.literal("date"),
  op: z.literal("weekday"),
  weekday: z.number().int().min(0).max(6), // 0=Sun..6=Sat (UTC)
});

const DateDayOfMonthCondition = z.object({
  field: z.literal("date"),
  op: z.literal("day_of_month"),
  day: z.number().int().min(1).max(31),
});

const DateBetweenCondition = z.object({
  field: z.literal("date"),
  op: z.literal("between"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// FINLYNQ-84 cycle 2 (2026-05-21): Zod v4 rejects discriminatedUnion when
// two branches share a discriminator value. The original schema had
// `field: "amount"` ×2 (single + between) and `field: "date"` ×3 (weekday +
// day_of_month + between), which threw at union-build time and broke every
// .safeParse() on the rule endpoints. Switched to top-level z.union so the
// 8 leaf schemas can be tried in order. Tradeoff: error messages on parse
// failure become "no schema matched" instead of "field=amount but op=foo
// invalid"; existing tests don't depend on the Zod error fingerprint
// (they assert HTTP status codes + body presence), so the trade is fine.
export const Condition = z.union([
  StringCondition,
  AmountConditionSingle,
  AmountConditionBetween,
  AccountCondition,
  CurrencyCondition,
  DateWeekdayCondition,
  DateDayOfMonthCondition,
  DateBetweenCondition,
]);
export type Condition = z.infer<typeof Condition>;

export const ConditionGroup = z.object({
  all: z.array(Condition).min(1).max(20),
});
export type ConditionGroup = z.infer<typeof ConditionGroup>;

export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_category"), categoryId: z.number().int().positive() }),
  z.object({ kind: z.literal("set_tags"), tags: z.string().max(500) }),
  z.object({ kind: z.literal("rename_payee"), to: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("set_account"), accountId: z.number().int().positive() }),
  z.object({ kind: z.literal("set_entered_currency"), currency: z.string().length(3).toUpperCase() }),
  z.object({ kind: z.literal("set_portfolio_holding"), holdingId: z.number().int().positive() }),
  z.object({ kind: z.literal("create_transfer"), destAccountId: z.number().int().positive() }),
]);
export type Action = z.infer<typeof Action>;

export const Rule = z.object({
  name: z.string().min(1).max(120),
  conditions: ConditionGroup,
  actions: z.array(Action).min(1).max(10),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export type Rule = z.infer<typeof Rule>;

/**
 * Helper — extract every FK id referenced by an action array, so callers
 * can drive `verifyOwnership` in one batch instead of N+1 queries.
 *
 * Used by REST POST/PUT /api/rules and the staged-import inline create-rule
 * endpoint. Returns deduped arrays per FK kind.
 */
export function collectActionFKs(actions: Action[]): {
  categoryIds: number[];
  accountIds: number[];
  holdingIds: number[];
} {
  const categoryIds = new Set<number>();
  const accountIds = new Set<number>();
  const holdingIds = new Set<number>();
  for (const a of actions) {
    switch (a.kind) {
      case "set_category":
        categoryIds.add(a.categoryId);
        break;
      case "set_account":
        accountIds.add(a.accountId);
        break;
      case "set_portfolio_holding":
        holdingIds.add(a.holdingId);
        break;
      case "create_transfer":
        accountIds.add(a.destAccountId);
        break;
      default:
        break;
    }
  }
  return {
    categoryIds: [...categoryIds],
    accountIds: [...accountIds],
    holdingIds: [...holdingIds],
  };
}

/**
 * Action kinds that mutate ROWS OTHER THAN the matched transaction (or create
 * new rows). These must NOT be applied by paths that only have a single
 * committed row in scope (e.g. `apply_rules_to_uncategorized`) — silent
 * balance corruption risk otherwise. Approve-time paths can run them.
 */
export const SIDE_EFFECT_ACTION_KINDS = new Set(["set_account", "create_transfer"]);

export function actionHasSideEffects(action: Action): boolean {
  return SIDE_EFFECT_ACTION_KINDS.has(action.kind);
}

export function ruleHasSideEffects(actions: Action[]): boolean {
  return actions.some(actionHasSideEffects);
}
