/**
 * The catch-all rule (GH #456): one click on the Rules page creates an
 * ordinary rule that files every transaction no other rule matched under an
 * "Uncategorized" category. It is exactly the rule a user could build by hand
 * (we used to tell people to); this only builds it for them.
 *
 * Nothing in the engine knows about it. It works because rules are first-match
 * by priority DESC (`applyRules`, auto-categorize.ts): the catch-all sits at
 * the lowest priority, so any other rule that matches wins. Its one condition
 * is "amount between -1e12 and 1e12", the import guard's own cap
 * (`MAX_REASONABLE_AMOUNT`), so it matches any amount we would ever store.
 * The user can edit, disable or delete it like any rule; clicking again after
 * a delete builds a new one.
 *
 * Client-safe (pure). The DB side is catch-all-server.ts.
 */
import { MAX_REASONABLE_AMOUNT } from "@/lib/utils/number";
import type { Condition } from "./schema";

/** Name of the category the catch-all files into (found by name, else made). */
export const CATCH_ALL_CATEGORY_NAME = "Uncategorized";
/** Default name of the rule; the user may rename it. */
export const CATCH_ALL_RULE_NAME = "Anything no other rule matches";
/** Highest priority the catch-all is ever given. */
export const CATCH_ALL_MAX_PRIORITY = -1000;

/** The one condition: any amount the app can store. */
export function catchAllCondition(): Condition {
  return { field: "amount", op: "between", min: -MAX_REASONABLE_AMOUNT, max: MAX_REASONABLE_AMOUNT };
}

/** Is this condition the "any amount" one? */
export function isAnyAmountCondition(c: { field?: string; op?: string; min?: number; max?: number }): boolean {
  return (
    c.field === "amount" &&
    c.op === "between" &&
    typeof c.min === "number" &&
    typeof c.max === "number" &&
    c.min <= -MAX_REASONABLE_AMOUNT &&
    c.max >= MAX_REASONABLE_AMOUNT
  );
}

/**
 * A rule is a catch-all when its only condition is "any amount" and it sets a
 * category. Recognised by shape, not by name or a stored flag, so a renamed one
 * still counts and a deleted one leaves nothing behind.
 */
export function isCatchAllRule(rule: {
  conditions?: { all?: Array<{ field?: string; op?: string; min?: number; max?: number }> } | null;
  actions?: Array<{ kind?: string }> | null;
}): boolean {
  const all = rule.conditions?.all ?? [];
  if (all.length !== 1 || !isAnyAmountCondition(all[0])) return false;
  return (rule.actions ?? []).some((a) => a.kind === "set_category");
}

/**
 * Priority for a new catch-all: below every existing rule, and never above
 * -1000, so a rule added later at the default 0 still runs first.
 */
export function catchAllPriority(existingPriorities: readonly number[]): number {
  const finite = existingPriorities.filter((p) => Number.isFinite(p));
  if (finite.length === 0) return CATCH_ALL_MAX_PRIORITY;
  return Math.min(CATCH_ALL_MAX_PRIORITY, Math.min(...finite) - 1);
}
