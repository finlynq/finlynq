/**
 * Email-import rule loading + matching (Epic B5).
 *
 * Shared by the DEK-bearing sweep (process-pending-inbox) and the rules CRUD
 * list. `loadActiveEmailRules` returns decrypted, priority-ordered active
 * rules; `ruleMatchesEmail` is the pure matcher.
 *
 * 2026-06-05 — rule `name` + `match_value` are user-DEK encrypted at rest. The
 * DEK is REQUIRED to match: a null DEK leaves match_value as ciphertext, which
 * won't substring-match any plaintext sender/subject → "no DEK ⇒ no match"
 * rather than a crash. That's why matching is deferred to the sweep (which has
 * the DEK), never the webhook.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptEmailRuleFields } from "./crypto";

export interface ActiveEmailRule {
  id: number;
  name: string;
  matchType: "sender" | "subject";
  matchOp: "contains" | "exact" | "regex";
  /** Decrypted needle. */
  matchValue: string;
  accountId: number;
  categoryId: number | null;
  mode: "auto" | "review";
  priority: number;
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
      matchType: schema.emailImportRules.matchType,
      matchOp: schema.emailImportRules.matchOp,
      matchValue: schema.emailImportRules.matchValue,
      accountId: schema.emailImportRules.accountId,
      categoryId: schema.emailImportRules.categoryId,
      mode: schema.emailImportRules.mode,
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
    });
    return {
      id: r.id,
      name: dec.name ?? r.name,
      matchType: r.matchType as "sender" | "subject",
      matchOp: r.matchOp as "contains" | "exact" | "regex",
      matchValue: dec.matchValue ?? r.matchValue,
      accountId: r.accountId,
      categoryId: r.categoryId,
      mode: r.mode as "auto" | "review",
      priority: r.priority,
    };
  });
}

export interface EmailMatchContext {
  fromAddress: string | null;
  subject: string | null;
}

/** Pure matcher. Case-insensitive contains/exact; regex applied verbatim
 *  (case-insensitive). A malformed regex never throws — it just doesn't match. */
export function ruleMatchesEmail(
  rule: Pick<ActiveEmailRule, "matchType" | "matchOp" | "matchValue">,
  ctx: EmailMatchContext,
): boolean {
  const haystack =
    rule.matchType === "sender" ? ctx.fromAddress ?? "" : ctx.subject ?? "";
  const needle = rule.matchValue ?? "";
  if (needle === "") return false;
  switch (rule.matchOp) {
    case "contains":
      return haystack.toLowerCase().includes(needle.toLowerCase());
    case "exact":
      return haystack.trim().toLowerCase() === needle.trim().toLowerCase();
    case "regex":
      try {
        return new RegExp(needle, "i").test(haystack);
      } catch {
        return false;
      }
  }
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
