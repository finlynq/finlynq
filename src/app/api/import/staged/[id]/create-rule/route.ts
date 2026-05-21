/**
 * POST /api/import/staged/[id]/create-rule
 *
 * FINLYNQ-57 — inline rule creation from the staging-review dialog. When the
 * approve endpoint refuses with `code: 'unresolved_categories'`, the UI lets
 * the user create an auto-categorize rule that's applied to the CURRENT
 * staged batch only (not to historical `transactions` — they keep their
 * existing category). This is the surface that endpoint POSTs to.
 *
 * Body:
 *   {
 *     "matchField":         'payee'           // gate today only covers payee
 *     "matchType":          'contains' | 'exact' | 'regex'
 *     "matchValue":         string             // the user's match pattern
 *     "assignCategoryId":   number             // FK into categories.id
 *   }
 *
 * Behavior:
 *   1. Insert into `transaction_rules` with synthesized `name` + `is_active=true`
 *      + `created_at` (NOT NULL columns; no DB defaults).
 *   2. Walk staged_transactions rows in THIS batch, decoded per-tier, and
 *      UPDATE rows whose plaintext payee matches the new rule. The staged
 *      `category` column is the encrypted category NAME (not a FK), so we
 *      look up the picked category's name once and re-encrypt under the
 *      row's existing tier before writing.
 *   3. Return `{ success: true, data: { ruleId, updatedRowIds: [...] } }`.
 *
 * Load-bearing (CLAUDE.md):
 *   - `import_hash` is NEVER recomputed when the user assigns a category —
 *     we only mutate `category` here, not the payee or the hash.
 *   - `decryptNameish`-before-`fuzzyFind` invariant — we accept
 *     `assignCategoryId` directly (no name resolution), so the resolver
 *     class is sidestepped entirely. The category name fetch DOES decrypt
 *     via `decryptNameish` before any read of `.name` (defensive — keeps
 *     us inside the audit-invariants pattern even though we don't fuzzy-
 *     match here).
 *   - Per-row encryption tier: rows at `encryption_tier='service'` re-encrypt
 *     the new category name under PF_STAGING_KEY (sv1:); rows at 'user'
 *     re-encrypt under the user's DEK (v1:). We NEVER flip a row's tier.
 *   - HTTP only — stdio MCP has no DEK on the staging tier; out of scope.
 *
 * Sign-vs-category invariant (issue #212) — the approve endpoint enforces
 * this via the import-pipeline per-row reject path. Assigning a category
 * here doesn't bypass that gate; an E-type category on a positive-amount
 * row will still be rejected at approve time. We don't double-validate.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptStaged, encryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField, encryptField, decryptField } from "@/lib/crypto/envelope";
import { matchesRule, type TransactionRule } from "@/lib/auto-categorize";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  matchField: z.enum(["payee", "tags"]).default("payee"),
  matchType: z.enum(["contains", "exact", "regex"]).default("contains"),
  matchValue: z.string().min(1).max(2000),
  assignCategoryId: z.number().int().positive(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  let body: z.infer<typeof BodySchema>;
  try {
    const json = await request.json();
    body = BodySchema.parse(json);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid body" : "Invalid JSON" },
      { status: 400 },
    );
  }

  // Verify staged_import ownership. Cross-tenant attacks return 404 without
  // leaking that the id exists for another user — same shape as the per-row
  // PATCH endpoint.
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

  // Verify category ownership + fetch its encrypted name so we can re-encrypt
  // it for each matched staged row's tier. Same cross-tenant guard pattern.
  const catRow = await db
    .select({
      id: schema.categories.id,
      nameCt: schema.categories.nameCt,
    })
    .from(schema.categories)
    .where(and(
      eq(schema.categories.id, body.assignCategoryId),
      eq(schema.categories.userId, userId),
    ))
    .get();
  if (!catRow) {
    return NextResponse.json({ error: "Category not found" }, { status: 404 });
  }
  // Decrypt the category name once. CLAUDE.md "decryptNameish-before-fuzzyFind"
  // doesn't strictly apply here (no fuzzyFind — id is exact) but we still
  // decrypt before reading the plaintext to keep the audit invariant clean.
  const categoryNamePlain = catRow.nameCt
    ? (decryptField(dek, catRow.nameCt) ?? "")
    : "";

  // ─── Step 1: insert the new transaction_rules row ──────────────────────
  //
  // Schema columns: (user_id, name, match_field, match_type, match_value,
  // assign_category_id, assign_tags, rename_to, is_active, priority,
  // created_at). `name` is NOT NULL — synthesize a human label.
  // `is_active` is now BOOLEAN per the 2026-05-18 FINLYNQ-12 migration.
  // `created_at` has no DB default; supply ISO date.
  const cleanedValue = body.matchValue.replace(/%/g, "");
  const synthName = `Match "${cleanedValue}" → ${categoryNamePlain || `category #${catRow.id}`}`.slice(0, 200);
  const todayISO = new Date().toISOString().split("T")[0];

  const inserted = await db
    .insert(schema.transactionRules)
    .values({
      userId,
      name: synthName,
      matchField: body.matchField,
      matchType: body.matchType,
      matchValue: cleanedValue,
      assignCategoryId: catRow.id,
      isActive: true,
      priority: 0,
      createdAt: todayISO,
    })
    .returning({ id: schema.transactionRules.id });
  const ruleId = inserted[0]?.id;

  // ─── Step 2: walk the current batch + apply to matching rows ───────────
  //
  // Scoped to THIS staged_import only (item spec): "applies to the current
  // batch only, not historical transactions". Historical rows in
  // `transactions` are untouched.
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

  // Build a minimal TransactionRule-shaped object for matchesRule (same
  // shape the import pipeline uses — InferSelectModel of schema.transactionRules
  // covers the fields we read).
  const probeRule: TransactionRule = {
    id: ruleId ?? 0,
    userId,
    name: synthName,
    matchField: body.matchField,
    matchType: body.matchType,
    matchValue: cleanedValue,
    assignCategoryId: catRow.id,
    assignTags: null,
    renameTo: null,
    isActive: true,
    priority: 0,
    createdAt: todayISO,
  };

  const updatedRowIds: string[] = [];
  for (const r of stagedRows) {
    // Skip rows that already have a category (don't clobber user choices).
    const existing = decode(r.category, r.encryptionTier);
    if (existing && existing.trim() !== "") continue;
    // Transfers + true-ups don't need a category — skip even if matched.
    if (r.txType === "R") continue;
    if ((r.txType as string) === "T") continue;
    const decodedPayee = decode(r.payee, r.encryptionTier) ?? "";
    const probe = { payee: decodedPayee, amount: r.amount, tags: r.tags ?? "" };
    if (!matchesRule(probe, probeRule)) continue;
    // Re-encrypt the category NAME under the row's existing tier. We never
    // flip tiers mid-edit; the login-time upgrade job is the only path that
    // promotes service → user.
    const newCategoryCt = r.encryptionTier === "user"
      ? encryptField(dek, categoryNamePlain)
      : encryptStaged(categoryNamePlain);
    // CLAUDE.md load-bearing: `import_hash` is NEVER recomputed on edit. We
    // only touch the `category` column.
    await db
      .update(schema.stagedTransactions)
      .set({ category: newCategoryCt })
      .where(and(
        eq(schema.stagedTransactions.id, r.id),
        eq(schema.stagedTransactions.userId, userId),
      ));
    updatedRowIds.push(r.id);
  }

  // No invalidateUserTxCache call — we didn't write to `transactions`. The
  // user-tx-cache invalidation happens at approve time when rows materialize.
  // Silence the lint helper used by the audit script — explicit no-op.
  void sql;

  return NextResponse.json({
    success: true,
    data: {
      ruleId,
      categoryId: catRow.id,
      categoryName: categoryNamePlain,
      updatedRowIds,
      updatedCount: updatedRowIds.length,
    },
  });
}
