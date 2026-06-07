/**
 * Email-import rule loading + matching (Epic B5; multi-condition 2026-06-17).
 *
 * Shared by the DEK-bearing sweep (process-pending-inbox) and the rules CRUD
 * list. `loadActiveEmailRules` returns decrypted, priority-ordered active rules
 * each carrying an AND-only `conditions` group; `ruleMatchesEmail` is the pure
 * matcher (ALL conditions must match).
 *
 * Fields: sender/subject/body/payee (text; contains/exact/regex) + amount
 * (numeric; gt/lt/between, compared on |amount| since parser signs are
 * heuristic and users reason in magnitudes). The DEK is REQUIRED to match —
 * a null DEK leaves text values as ciphertext (won't substring-match), so
 * matching is deferred to the sweep, never the webhook.
 *
 * Back-compat: pre-migration rows have `conditions = null` + the flat
 * match_type/op/value tri; the loader synthesizes a 1-element group from the
 * (decrypted) flat tri so they match exactly as before.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptEmailRuleFields } from "./crypto";
import { STRING_FIELDS, type EmailCondition, type EmailConditionField, type EmailConditionGroup } from "./schema";

/** Cap the body haystack before any user-authored regex test (body is
 *  attacker-controlled + large → bounds catastrophic backtracking). */
const MAX_BODY_REGEX = 20_000;

export interface ActiveEmailRule {
  id: number;
  name: string;
  /** Decrypted AND-only condition group (all must match). */
  conditions: EmailCondition[];
  accountId: number;
  categoryId: number | null;
  mode: "auto" | "review";
  /** Multiply the parsed amount by -1 before recording (0 stays +0). */
  flipSign: boolean;
  /** 'parsed' (body date, default) | 'received' (email received date). */
  dateSource: "parsed" | "received";
  /** Decrypted rule-level payee rename, or null. */
  payeeOverride: string | null;
  /** Recorded-currency override (ISO). NULL ⇒ use the account currency. */
  currency: string | null;
  priority: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object";
}

/** Extract the `.all` array from a (possibly junk) decrypted group. */
function groupAll(group: EmailConditionGroup | null | undefined): EmailCondition[] {
  const all = group && (group as { all?: unknown }).all;
  return Array.isArray(all) ? (all as EmailCondition[]) : [];
}

/** Load a user's active email-import rules, highest priority first, decrypted. */
export async function loadActiveEmailRules(
  userId: string,
  dek: Buffer | null,
): Promise<ActiveEmailRule[]> {
  const rows = await db
    .select({
      id: schema.emailImportRules.id,
      name: schema.emailImportRules.name,
      conditions: schema.emailImportRules.conditions,
      matchType: schema.emailImportRules.matchType,
      matchOp: schema.emailImportRules.matchOp,
      matchValue: schema.emailImportRules.matchValue,
      accountId: schema.emailImportRules.accountId,
      categoryId: schema.emailImportRules.categoryId,
      mode: schema.emailImportRules.mode,
      flipSign: schema.emailImportRules.flipSign,
      dateSource: schema.emailImportRules.dateSource,
      payeeOverride: schema.emailImportRules.payeeOverride,
      currency: schema.emailImportRules.currency,
      priority: schema.emailImportRules.priority,
    })
    .from(schema.emailImportRules)
    .where(
      and(
        eq(schema.emailImportRules.userId, userId),
        eq(schema.emailImportRules.isActive, true),
      ),
    )
    .orderBy(desc(schema.emailImportRules.priority), asc(schema.emailImportRules.id))
    .all();

  return rows.map((r) => {
    const dec = decryptEmailRuleFields(dek, {
      name: r.name,
      matchValue: r.matchValue,
      payeeOverride: r.payeeOverride,
      conditions: (r.conditions ?? null) as EmailConditionGroup | null,
    });

    let conditions = groupAll(dec.conditions);
    if (conditions.length === 0) {
      // Back-compat: synthesize from the decrypted flat tri (pre-migration row).
      const value = dec.matchValue ?? r.matchValue;
      if (r.matchType && r.matchOp && value) {
        conditions = [
          {
            field: r.matchType as "sender" | "subject",
            op: r.matchOp as "contains" | "exact" | "regex",
            value,
          },
        ];
      }
    }

    return {
      id: r.id,
      name: dec.name ?? r.name,
      conditions,
      accountId: r.accountId,
      categoryId: r.categoryId,
      mode: r.mode as "auto" | "review",
      flipSign: r.flipSign,
      dateSource: (r.dateSource as "parsed" | "received") ?? "parsed",
      payeeOverride: dec.payeeOverride ?? r.payeeOverride,
      currency: r.currency ?? null,
      priority: r.priority,
    };
  });
}

export interface EmailMatchContext {
  fromAddress: string | null;
  subject: string | null;
  /** Decrypted body (text, or HTML stripped to text). */
  body?: string | null;
  /** Parser's extracted payee. */
  payee?: string | null;
  /** Parser's extracted signed amount. */
  amount?: number | null;
}

function textHaystack(field: string, ctx: EmailMatchContext): string {
  switch (field) {
    case "sender":
      return ctx.fromAddress ?? "";
    case "subject":
      return ctx.subject ?? "";
    case "body":
      return ctx.body ?? "";
    case "payee":
      return ctx.payee ?? "";
    default:
      return "";
  }
}

function matchText(field: string, op: string, value: unknown, ctx: EmailMatchContext): boolean {
  if (typeof value !== "string" || value === "") return false;
  let haystack = textHaystack(field, ctx);
  switch (op) {
    case "contains":
      return haystack.toLowerCase().includes(value.toLowerCase());
    case "exact":
      return haystack.trim().toLowerCase() === value.trim().toLowerCase();
    case "regex":
      // ReDoS guard: cap the body haystack before a user-authored regex.
      if (field === "body" && haystack.length > MAX_BODY_REGEX) {
        haystack = haystack.slice(0, MAX_BODY_REGEX);
      }
      try {
        return new RegExp(value, "i").test(haystack);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** Amount conditions compare the MAGNITUDE (|amount|): parser signs are
 *  heuristic and users reason in magnitudes ("under $500"). */
function matchAmount(cond: Record<string, unknown>, ctx: EmailMatchContext): boolean {
  if (typeof ctx.amount !== "number" || Number.isNaN(ctx.amount)) return false;
  const mag = Math.abs(ctx.amount);
  if (cond.op === "between") {
    const a = Number(cond.min);
    const b = Number(cond.max);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    const lo = Math.min(Math.abs(a), Math.abs(b));
    const hi = Math.max(Math.abs(a), Math.abs(b));
    return mag >= lo && mag <= hi;
  }
  const t = Math.abs(Number(cond.value));
  if (Number.isNaN(t)) return false;
  if (cond.op === "gt") return mag > t;
  if (cond.op === "lt") return mag < t;
  return false;
}

function conditionMatches(cond: unknown, ctx: EmailMatchContext): boolean {
  if (!isObj(cond) || typeof cond.field !== "string" || typeof cond.op !== "string") return false;
  if (cond.field === "amount") return matchAmount(cond, ctx);
  if (STRING_FIELDS.has(cond.field as EmailConditionField)) {
    return matchText(cond.field, cond.op, cond.value, ctx);
  }
  return false;
}

/** Pure matcher — a rule matches when ALL its conditions match (AND). An empty
 *  condition list never matches (preserves the legacy "empty needle" behavior). */
export function ruleMatchesEmail(
  rule: Pick<ActiveEmailRule, "conditions">,
  ctx: EmailMatchContext,
): boolean {
  const conds = rule.conditions;
  if (!Array.isArray(conds) || conds.length === 0) return false;
  return conds.every((c) => conditionMatches(c, ctx));
}

/** Return the highest-priority active rule that matches, or null. */
export function firstMatchingRule(
  rules: ActiveEmailRule[],
  ctx: EmailMatchContext,
): ActiveEmailRule | null {
  for (const rule of rules) {
    if (ruleMatchesEmail(rule, ctx)) return rule;
  }
  return null;
}
