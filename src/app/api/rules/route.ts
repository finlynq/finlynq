/**
 * /api/rules — CRUD for transaction_rules v2 (FINLYNQ-84).
 *
 * POST / PUT now accept the JSONB shape: `{ name, conditions, actions,
 * priority?, isActive? }`. The legacy flat (`matchField`, `matchType`,
 * `matchValue`, `assignCategoryId`, `assignTags`, `renameTo`) was retired
 * with the schema-pg.ts migration on 2026-05-21.
 *
 * GET decrypts every FK referenced inside the `actions` JSONB array so the
 * UI can render plain-English summaries without N+1 round-trips. Stream D
 * Phase 4 — `categories.name`/`accounts.name`/`portfolio_holdings.name` are
 * ciphertext-only; decryption needs the unlocked DEK from `requireAuth`.
 *
 * Load-bearing (CLAUDE.md):
 * - Cross-tenant FK guard via `verifyOwnership` for every id appearing inside
 *   `actions[].categoryId / accountId / holdingId / destAccountId`.
 * - `decryptNameish`-before-`fuzzyFind` invariant: no fuzzyFind here (rules
 *   carry typed FK ids, not names), so the invariant trivially holds.
 */
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";
import {
  ConditionGroup,
  Action,
  collectActionFKs,
  type ConditionGroup as ConditionGroupType,
  type Action as ActionType,
} from "@/lib/rules/schema";

const postSchema = z.object({
  name: z.string().min(1).max(120),
  conditions: ConditionGroup,
  actions: z.array(Action).min(1).max(10),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

const putSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(120).optional(),
  conditions: ConditionGroup.optional(),
  actions: z.array(Action).min(1).max(10).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

const { transactionRules, categories, accounts, portfolioHoldings } = schema;

// GET — list all rules with decrypted FK names for UI summaries.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;

  const rawRules = await db
    .select({
      id: transactionRules.id,
      name: transactionRules.name,
      conditions: transactionRules.conditions,
      actions: transactionRules.actions,
      isActive: transactionRules.isActive,
      priority: transactionRules.priority,
      createdAt: transactionRules.createdAt,
      updatedAt: transactionRules.updatedAt,
    })
    .from(transactionRules)
    .where(eq(transactionRules.userId, userId))
    .orderBy(desc(transactionRules.priority), transactionRules.id)
    .all();

  // Collect every FK id referenced inside the actions JSONB across all rules,
  // batch-load + decrypt their display names once, then re-attach per-rule.
  // Avoids N+1 SELECT-per-rule and keeps the decrypt loop bounded.
  const categoryIdSet = new Set<number>();
  const accountIdSet = new Set<number>();
  const holdingIdSet = new Set<number>();
  for (const r of rawRules) {
    const actions = Array.isArray(r.actions) ? (r.actions as ActionType[]) : [];
    const fks = collectActionFKs(actions);
    fks.categoryIds.forEach((id) => categoryIdSet.add(id));
    fks.accountIds.forEach((id) => accountIdSet.add(id));
    fks.holdingIds.forEach((id) => holdingIdSet.add(id));
  }

  const { decryptName } = await import("@/lib/crypto/encrypted-columns");

  const fetchNames = async <T extends { id: number; nameCt: string | null }>(
    table: typeof categories | typeof accounts | typeof portfolioHoldings,
    ids: Set<number>,
  ): Promise<Map<number, string | null>> => {
    if (ids.size === 0) return new Map();
    const rows = (await db
      .select({ id: table.id, nameCt: table.nameCt })
      .from(table)
      .where(eq(table.userId, userId))
      .all()) as T[];
    const m = new Map<number, string | null>();
    for (const row of rows) {
      if (!ids.has(row.id)) continue;
      m.set(row.id, decryptName(row.nameCt, dek, null));
    }
    return m;
  };

  const [categoryNames, accountNames, holdingNames] = await Promise.all([
    fetchNames(categories, categoryIdSet),
    fetchNames(accounts, accountIdSet),
    fetchNames(portfolioHoldings, holdingIdSet),
  ]);

  const rules = rawRules.map((r) => ({
    ...r,
    conditions: (r.conditions ?? { all: [] }) as ConditionGroupType,
    actions: (Array.isArray(r.actions) ? r.actions : []) as ActionType[],
    actionFKNames: {
      categories: Object.fromEntries(categoryNames),
      accounts: Object.fromEntries(accountNames),
      holdings: Object.fromEntries(holdingNames),
    },
  }));

  return NextResponse.json(rules);
}

// POST — create a new rule.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) return auth.response;
  try {
    const body = await req.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const { name, conditions, actions, priority, isActive } = parsed.data;

    // Cross-tenant FK guards — every id referenced inside the conditions /
    // actions must belong to this user. Without this, a rule could fire on
    // user A's transactions and (e.g. via `set_category`) point them at
    // user B's category row.
    const fks = collectActionFKs(actions);
    // Conditions can carry FK ids too (account.is, account.is_not). Collect.
    for (const c of conditions.all) {
      if (c.field === "account") fks.accountIds.push(c.accountId);
    }
    const uniqueAccts = [...new Set(fks.accountIds)];
    const uniqueCats = [...new Set(fks.categoryIds)];
    const uniqueHoldings = [...new Set(fks.holdingIds)];
    if (uniqueCats.length > 0) {
      await verifyOwnership(auth.context.userId, { categoryIds: uniqueCats });
    }
    if (uniqueAccts.length > 0) {
      await verifyOwnership(auth.context.userId, { accountIds: uniqueAccts });
    }
    if (uniqueHoldings.length > 0) {
      await verifyOwnership(auth.context.userId, { holdingIds: uniqueHoldings });
    }

    const rule = await db
      .insert(transactionRules)
      .values({
        userId: auth.context.userId,
        name: name.trim(),
        conditions: conditions as unknown as object,
        actions: actions as unknown as object,
        isActive: isActive ?? true,
        priority: priority ?? 0,
        createdAt: new Date().toISOString().split("T")[0],
      })
      .returning()
      .get();

    return NextResponse.json(rule, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create rule") }, { status: 500 });
  }
}

// PUT — update an existing rule.
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) return auth.response;
  try {
    const body = await req.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...updates } = parsed.data;

    // Same cross-tenant FK guard as POST. Only run on the slice the caller
    // is updating; if conditions / actions are absent we have nothing to verify.
    if (updates.actions) {
      const fks = collectActionFKs(updates.actions);
      const uniqueAccts = [...new Set(fks.accountIds)];
      const uniqueCats = [...new Set(fks.categoryIds)];
      const uniqueHoldings = [...new Set(fks.holdingIds)];
      if (uniqueCats.length > 0) {
        await verifyOwnership(auth.context.userId, { categoryIds: uniqueCats });
      }
      if (uniqueAccts.length > 0) {
        await verifyOwnership(auth.context.userId, { accountIds: uniqueAccts });
      }
      if (uniqueHoldings.length > 0) {
        await verifyOwnership(auth.context.userId, { holdingIds: uniqueHoldings });
      }
    }
    if (updates.conditions) {
      const acctIds: number[] = [];
      for (const c of updates.conditions.all) {
        if (c.field === "account") acctIds.push(c.accountId);
      }
      const uniq = [...new Set(acctIds)];
      if (uniq.length > 0) {
        await verifyOwnership(auth.context.userId, { accountIds: uniq });
      }
    }

    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) data.name = updates.name.trim();
    if (updates.conditions !== undefined) data.conditions = updates.conditions;
    if (updates.actions !== undefined) data.actions = updates.actions;
    if (updates.isActive !== undefined) data.isActive = updates.isActive;
    if (updates.priority !== undefined) data.priority = updates.priority;

    const rule = await db
      .update(transactionRules)
      .set(data)
      .where(and(
        eq(transactionRules.id, id),
        eq(transactionRules.userId, auth.context.userId),
      ))
      .returning()
      .get();

    if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    return NextResponse.json(rule);
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update rule") }, { status: 500 });
  }
}

// DELETE — delete a rule.
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) return auth.response;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID is required" }, { status: 400 });

  await db.delete(transactionRules).where(and(
    eq(transactionRules.id, parseInt(id)),
    eq(transactionRules.userId, auth.context.userId),
  ));
  return NextResponse.json({ success: true });
}
