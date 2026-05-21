/**
 * POST /api/import/staged/[id]/create-rule
 *
 * FINLYNQ-57 — inline rule creation from the staging-review dialog. When the
 * approve endpoint refuses with `code: 'unresolved_categories'`, the UI lets
 * the user create an auto-categorize rule that's applied to the CURRENT
 * staged batch only (not to historical `transactions` — they keep their
 * existing category).
 *
 * FINLYNQ-84 (2026-05-21): body accepts BOTH the legacy shorthand
 *   `{ matchField, matchType, matchValue, assignCategoryId }`
 * AND the new v2 shape
 *   `{ conditions: ConditionGroup, actions: Action[] }`.
 *
 * Legacy shorthand is synthesized into a v2 rule with a single payee/string
 * condition and a single `set_category` action, then written to the new
 * JSONB columns. Either path applies the resulting rule to matching rows
 * in this batch only.
 *
 * Behavior:
 *   1. Validate body — accept either shape.
 *   2. Synthesize ConditionGroup + Action[] (legacy) or pass through (v2).
 *   3. Insert into `transaction_rules` (new JSONB columns).
 *   4. Walk staged_transactions in THIS batch, decoded per-tier, applying
 *      `computePureActionPatch` to matched rows.
 *   5. Return `{ success: true, data: { ruleId, updatedRowIds: [...] } }`.
 *
 * Load-bearing (CLAUDE.md):
 *   - `import_hash` is NEVER recomputed when assigning a category. We
 *     only mutate the staged row's `category` column.
 *   - Per-row encryption tier: rows at `encryption_tier='service'`
 *     re-encrypt under PF_STAGING_KEY (sv1:); rows at 'user' re-encrypt
 *     under the user DEK (v1:). We NEVER flip a row's tier.
 *   - HTTP only — stdio MCP has no DEK on the staging tier; out of scope.
 *   - Side-effect actions (`set_account` / `create_transfer`) on the v2
 *     payload are REFUSED here. They need approve-time context, not the
 *     inline-create surface. Use the full /api/rules endpoint to create
 *     such rules + let them fire at approve time.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptStaged, encryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField, encryptField, decryptField } from "@/lib/crypto/envelope";
import { matchesRule, type TransactionRule } from "@/lib/auto-categorize";
import { computePureActionPatch } from "@/lib/rules/execute";
import {
  ConditionGroup,
  Action,
  collectActionFKs,
  ruleHasSideEffects,
  type ConditionGroup as ConditionGroupType,
  type Action as ActionType,
} from "@/lib/rules/schema";

export const dynamic = "force-dynamic";

// Legacy shorthand: matchField=payee|tags, matchType, matchValue, assignCategoryId.
const LegacyBodySchema = z.object({
  matchField: z.enum(["payee", "tags"]).default("payee"),
  matchType: z.enum(["contains", "exact", "regex"]).default("contains"),
  matchValue: z.string().min(1).max(2000),
  assignCategoryId: z.number().int().positive(),
});

// FINLYNQ-84 advanced shape.
const AdvancedBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  conditions: ConditionGroup,
  actions: z.array(Action).min(1).max(10),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Try advanced shape first; fall back to legacy on a fail. Either way we
  // end up with a (conditions, actions, displayName) tuple to write.
  let conditions: ConditionGroupType;
  let actions: ActionType[];
  let displayName: string | undefined;
  let legacyAssignCategoryId: number | undefined;

  const advancedParse = AdvancedBodySchema.safeParse(raw);
  if (advancedParse.success) {
    conditions = advancedParse.data.conditions;
    actions = advancedParse.data.actions;
    displayName = advancedParse.data.name;
    // Reject side-effect actions here — inline-create from staging review is
    // a "fix this category and the batch" surface; full rule lifecycle is on
    // /api/rules where approve-time wiring is in scope.
    if (ruleHasSideEffects(actions)) {
      return NextResponse.json(
        {
          error: "Side-effect actions (set_account, create_transfer) are not allowed on inline-create. Create the rule via /api/rules and re-trigger approve.",
          code: "side_effect_action_disallowed",
        },
        { status: 400 },
      );
    }
  } else {
    const legacyParse = LegacyBodySchema.safeParse(raw);
    if (!legacyParse.success) {
      return NextResponse.json(
        { error: legacyParse.error.issues[0]?.message ?? "Invalid body" },
        { status: 400 },
      );
    }
    const lb = legacyParse.data;
    // Synthesize a v2 rule: single string-condition + single set_category action.
    const cleanedValue = lb.matchValue.replace(/%/g, "");
    conditions = {
      all: [{ field: lb.matchField, op: lb.matchType, value: cleanedValue }],
    } as ConditionGroupType;
    actions = [{ kind: "set_category", categoryId: lb.assignCategoryId }] as ActionType[];
    legacyAssignCategoryId = lb.assignCategoryId;
  }

  // Verify staged_import ownership.
  const staged = await db
    .select({ id: schema.stagedImports.id, status: schema.stagedImports.status })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (staged.status !== "pending") {
    return NextResponse.json(
      { error: "Staged import is not pending — edits are no longer accepted" },
      { status: 409 },
    );
  }

  // Cross-tenant FK guard on every id inside actions + conditions.
  const fks = collectActionFKs(actions);
  for (const c of conditions.all) {
    if (c.field === "account") fks.accountIds.push(c.accountId);
  }
  const uniqueCats = [...new Set(fks.categoryIds)];
  const uniqueAccts = [...new Set(fks.accountIds)];
  const uniqueHoldings = [...new Set(fks.holdingIds)];
  if (uniqueCats.length > 0) {
    const owned = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(
        eq(schema.categories.userId, userId),
      ))
      .all();
    const ownedSet = new Set(owned.map((r) => r.id));
    for (const cid of uniqueCats) {
      if (!ownedSet.has(cid)) {
        return NextResponse.json({ error: "Category not found" }, { status: 404 });
      }
    }
  }
  if (uniqueAccts.length > 0) {
    const owned = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, userId))
      .all();
    const ownedSet = new Set(owned.map((r) => r.id));
    for (const aid of uniqueAccts) {
      if (!ownedSet.has(aid)) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
    }
  }
  if (uniqueHoldings.length > 0) {
    const owned = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(eq(schema.portfolioHoldings.userId, userId))
      .all();
    const ownedSet = new Set(owned.map((r) => r.id));
    for (const hid of uniqueHoldings) {
      if (!ownedSet.has(hid)) {
        return NextResponse.json({ error: "Holding not found" }, { status: 404 });
      }
    }
  }

  // For the legacy shorthand we need the category name for both the rule's
  // display label and the staged-row re-encryption. For the advanced path
  // we may have multiple categories referenced; we re-encrypt per matched
  // row using the FIRST `set_category` action's id (since pure patch's
  // categoryId is the last-wins value).
  const targetCategoryId = (() => {
    for (const a of actions) {
      if (a.kind === "set_category") return a.categoryId;
    }
    return legacyAssignCategoryId ?? null;
  })();

  let categoryNamePlain = "";
  if (targetCategoryId != null) {
    const catRow = await db
      .select({ nameCt: schema.categories.nameCt })
      .from(schema.categories)
      .where(and(
        eq(schema.categories.id, targetCategoryId),
        eq(schema.categories.userId, userId),
      ))
      .get();
    if (catRow?.nameCt) {
      categoryNamePlain = decryptField(dek, catRow.nameCt) ?? "";
    }
  }

  // Synthesize a display label if the caller didn't supply one.
  const synthName = (() => {
    if (displayName && displayName.trim().length > 0) return displayName.slice(0, 200);
    // For legacy shorthand: "Match "<value>" → <category>".
    if (legacyAssignCategoryId != null) {
      const firstCond = conditions.all[0];
      const val =
        firstCond && firstCond.field !== "amount" && firstCond.field !== "account" &&
        firstCond.field !== "date" && firstCond.field !== "currency"
          ? firstCond.value
          : "";
      return `Match "${val}" → ${categoryNamePlain || `category #${targetCategoryId}`}`.slice(0, 200);
    }
    // Advanced path — describe by condition count + action count.
    return `Rule (${conditions.all.length} cond / ${actions.length} action)`.slice(0, 200);
  })();

  const todayISO = new Date().toISOString().split("T")[0];

  const inserted = await db
    .insert(schema.transactionRules)
    .values({
      userId,
      name: synthName,
      conditions: conditions as unknown as object,
      actions: actions as unknown as object,
      isActive: true,
      priority: 0,
      createdAt: todayISO,
    })
    .returning({ id: schema.transactionRules.id });
  const ruleId = inserted[0]?.id;

  // Walk current batch + apply patch to matching rows.
  const stagedRows = await db
    .select({
      id: schema.stagedTransactions.id,
      payee: schema.stagedTransactions.payee,
      category: schema.stagedTransactions.category,
      tags: schema.stagedTransactions.tags,
      amount: schema.stagedTransactions.amount,
      encryptionTier: schema.stagedTransactions.encryptionTier,
      txType: schema.stagedTransactions.txType,
    })
    .from(schema.stagedTransactions)
    .where(and(
      eq(schema.stagedTransactions.stagedImportId, id),
      eq(schema.stagedTransactions.userId, userId),
    ))
    .all();

  const decode = (v: string | null, tier: string): string | null => {
    if (v == null) return null;
    return tier === "user" ? tryDecryptField(dek, v) : decryptStaged(v);
  };

  const probeRule: TransactionRule = {
    id: ruleId ?? 0,
    name: synthName,
    conditions,
    actions,
    isActive: true,
    priority: 0,
  };

  const updatedRowIds: string[] = [];
  for (const r of stagedRows) {
    const existing = decode(r.category, r.encryptionTier);
    if (existing && existing.trim() !== "") continue;
    if (r.txType === "R") continue;
    if ((r.txType as string) === "T") continue;
    const decodedPayee = decode(r.payee, r.encryptionTier) ?? "";
    const probe = { payee: decodedPayee, amount: r.amount, tags: r.tags ?? "" };
    if (!matchesRule(probe, probeRule)) continue;
    // Apply pure patch — staged-row inline-create only supports set_category
    // for now (we already refused side-effect actions above). The patch tells
    // us which category id to encrypt onto the row.
    const patch = computePureActionPatch(actions);
    if (patch.categoryId == null) continue;
    const newCategoryCt = r.encryptionTier === "user"
      ? encryptField(dek, categoryNamePlain)
      : encryptStaged(categoryNamePlain);
    // Load-bearing: import_hash NEVER recomputed on edit.
    await db
      .update(schema.stagedTransactions)
      .set({ category: newCategoryCt })
      .where(and(
        eq(schema.stagedTransactions.id, r.id),
        eq(schema.stagedTransactions.userId, userId),
      ));
    updatedRowIds.push(r.id);
  }

  // No invalidateUserTxCache — we didn't write to `transactions`.
  void sql;

  return NextResponse.json({
    success: true,
    data: {
      ruleId,
      categoryId: targetCategoryId,
      categoryName: categoryNamePlain,
      updatedRowIds,
      updatedCount: updatedRowIds.length,
    },
  });
}
