/**
 * SERVER ONLY. Creates the catch-all rule (GH #456): finds or makes the
 * "Uncategorized" category, then inserts an ordinary rule at the lowest
 * priority whose one condition matches any amount and whose action files the
 * row under that category. Rules + why it works: ./catch-all.ts.
 *
 * Idempotent by shape: if the user already has a catch-all rule (enabled or
 * not, renamed or not), it is returned and nothing is written.
 */
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { nameLookup, encryptName } from "@/lib/crypto/encrypted-columns";
import { normalizeDbRows } from "@/lib/db-utils";
import { todayISO } from "@/lib/utils/date";
import { encryptRuleFields } from "./crypto";
import {
  CATCH_ALL_CATEGORY_NAME,
  CATCH_ALL_RULE_NAME,
  catchAllCondition,
  catchAllPriority,
  isCatchAllRule,
} from "./catch-all";
import type { Action, ConditionGroup } from "./schema";

const { transactionRules } = schema;

export type CatchAllResult = {
  ruleId: number;
  categoryId: number | null;
  /** false when an existing catch-all rule was returned. */
  created: boolean;
  /** true when the "Uncategorized" category had to be made. */
  categoryCreated: boolean;
  isActive: boolean;
};

async function findCategoryByName(userId: string, dek: Buffer, name: string): Promise<number | null> {
  const rows = normalizeDbRows(
    await db.execute(sql`
      SELECT id FROM categories
       WHERE user_id = ${userId} AND name_lookup = ${nameLookup(dek, name)}
       LIMIT 1
    `),
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

/** Find the "Uncategorized" category, or make it (an expense category). */
export async function resolveOrCreateCatchAllCategory(
  userId: string,
  dek: Buffer,
): Promise<{ id: number; created: boolean }> {
  const existing = await findCategoryByName(userId, dek, CATCH_ALL_CATEGORY_NAME);
  if (existing != null) return { id: existing, created: false };
  const { ct, lookup } = encryptName(dek, CATCH_ALL_CATEGORY_NAME);
  try {
    const rows = normalizeDbRows(
      await db.execute(sql`
        INSERT INTO categories (user_id, type, "group", name_ct, name_lookup)
        VALUES (${userId}, 'E', 'Other', ${ct}, ${lookup})
        RETURNING id
      `),
    );
    if (rows.length > 0) return { id: Number(rows[0].id), created: true };
  } catch {
    // (user_id, name_lookup) unique race: someone made it a moment ago.
  }
  const raced = await findCategoryByName(userId, dek, CATCH_ALL_CATEGORY_NAME);
  if (raced == null) throw new Error("Could not create the Uncategorized category");
  return { id: raced, created: false };
}

type RuleRowLite = {
  id: number;
  priority: number | null;
  isActive: boolean | null;
  conditions: unknown;
  actions: unknown;
};

export async function createCatchAllRule(userId: string, dek: Buffer): Promise<CatchAllResult> {
  const rules = (await db
    .select({
      id: transactionRules.id,
      priority: transactionRules.priority,
      isActive: transactionRules.isActive,
      conditions: transactionRules.conditions,
      actions: transactionRules.actions,
    })
    .from(transactionRules)
    .where(sql`${transactionRules.userId} = ${userId}`)) as RuleRowLite[];

  // Amount conditions and category ids are stored in plaintext (only free text
  // is encrypted), so the shape check works on the stored JSON as is.
  const existing = rules.find((r) =>
    isCatchAllRule({
      conditions: r.conditions as { all?: Array<Record<string, unknown>> } | null,
      actions: Array.isArray(r.actions) ? (r.actions as Array<{ kind?: string }>) : [],
    }),
  );
  if (existing) {
    const action = (existing.actions as Array<{ kind?: string; categoryId?: number }>).find(
      (a) => a.kind === "set_category",
    );
    return {
      ruleId: existing.id,
      categoryId: action?.categoryId ?? null,
      created: false,
      categoryCreated: false,
      isActive: existing.isActive !== false,
    };
  }

  const category = await resolveOrCreateCatchAllCategory(userId, dek);
  const conditions: ConditionGroup = { all: [catchAllCondition()] };
  const actions: Action[] = [{ kind: "set_category", categoryId: category.id }];
  const enc = encryptRuleFields(dek, { name: CATCH_ALL_RULE_NAME, conditions, actions });

  const inserted = await db
    .insert(transactionRules)
    .values({
      userId,
      name: enc.name ?? CATCH_ALL_RULE_NAME,
      conditions: enc.conditions as unknown as object,
      actions: enc.actions as unknown as object,
      isActive: true,
      priority: catchAllPriority(rules.map((r) => Number(r.priority ?? 0))),
      createdAt: todayISO(),
    })
    .returning({ id: transactionRules.id });

  return {
    ruleId: Number(inserted[0].id),
    categoryId: category.id,
    created: true,
    categoryCreated: category.created,
    isActive: true,
  };
}
