/**
 * /api/email-rules/[id] (Epic C2).
 *
 *   PUT    — update a rule (partial). Re-encrypts name/match_value; re-checks
 *            account/category ownership when those change.
 *   DELETE — remove a rule.
 *
 * requireEncryption. Cross-tenant → 404. Bare JSON.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody } from "@/lib/validate";
import { encryptEmailRuleFields } from "@/lib/email-rules/crypto";
import { EmailConditionGroup } from "@/lib/email-rules/schema";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  conditions: EmailConditionGroup.optional(),
  // Legacy flat match tri — back-compat input shim (normalized to conditions).
  matchType: z.enum(["sender", "subject"]).optional(),
  matchOp: z.enum(["contains", "exact", "regex"]).optional(),
  matchValue: z.string().min(1).max(512).optional(),
  accountId: z.number().int().positive().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  mode: z.enum(["auto", "review"]).optional(),
  flipSign: z.boolean().optional(),
  dateSource: z.enum(["parsed", "received"]).optional(),
  payeeOverride: z.string().max(120).nullable().optional(),
  // Recorded-currency override (ISO). Explicit null clears it (→ account currency).
  currency: z.string().regex(/^[A-Za-z]{3,4}$/).nullable().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;
  const ruleId = parseInt(id, 10);
  if (!Number.isFinite(ruleId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, updateSchema);
  if (parsed.error) return parsed.error;
  const d = parsed.data;

  // Ownership of the rule itself.
  const existing = await db
    .select({ id: schema.emailImportRules.id })
    .from(schema.emailImportRules)
    .where(and(eq(schema.emailImportRules.id, ruleId), eq(schema.emailImportRules.userId, userId)))
    .limit(1);
  if (!existing[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (d.accountId != null) {
    const acct = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, d.accountId), eq(schema.accounts.userId, userId)))
      .limit(1);
    if (!acct[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (d.categoryId != null) {
    const cat = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.id, d.categoryId), eq(schema.categories.userId, userId)))
      .limit(1);
    if (!cat[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Normalize to conditions: explicit group, else synthesize from a full flat
  // tri (legacy client), else leave conditions untouched (e.g. toggling active).
  const conditionsGroup =
    d.conditions ??
    (d.matchType && d.matchOp && d.matchValue
      ? { all: [{ field: d.matchType, op: d.matchOp, value: d.matchValue }] }
      : undefined);

  const enc = encryptEmailRuleFields(dek, {
    name: d.name,
    payeeOverride: d.payeeOverride ?? undefined,
    conditions: conditionsGroup,
  });

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (d.name !== undefined) set.name = enc.name ?? d.name;
  if (conditionsGroup) {
    set.conditions = enc.conditions ?? conditionsGroup;
    // Migrate onto conditions-canonical — drop the legacy flat tri.
    set.matchType = null;
    set.matchOp = null;
    set.matchValue = null;
  }
  if (d.accountId !== undefined) set.accountId = d.accountId;
  if (d.categoryId !== undefined) set.categoryId = d.categoryId;
  if (d.mode !== undefined) set.mode = d.mode;
  if (d.flipSign !== undefined) set.flipSign = d.flipSign;
  if (d.dateSource !== undefined) set.dateSource = d.dateSource;
  // payee_override: explicit null clears it; a string is encrypted.
  if (d.payeeOverride !== undefined)
    set.payeeOverride = d.payeeOverride === null ? null : enc.payeeOverride ?? d.payeeOverride;
  // currency: explicit null clears it (→ account currency); a code is uppercased.
  if (d.currency !== undefined)
    set.currency = d.currency === null ? null : d.currency.toUpperCase();
  if (d.isActive !== undefined) set.isActive = d.isActive;
  if (d.priority !== undefined) set.priority = d.priority;

  await db
    .update(schema.emailImportRules)
    .set(set)
    .where(and(eq(schema.emailImportRules.id, ruleId), eq(schema.emailImportRules.userId, userId)));

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;
  const { id } = await params;
  const ruleId = parseInt(id, 10);
  if (!Number.isFinite(ruleId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const existing = await db
    .select({ id: schema.emailImportRules.id })
    .from(schema.emailImportRules)
    .where(and(eq(schema.emailImportRules.id, ruleId), eq(schema.emailImportRules.userId, userId)))
    .limit(1);
  if (!existing[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db
    .delete(schema.emailImportRules)
    .where(and(eq(schema.emailImportRules.id, ruleId), eq(schema.emailImportRules.userId, userId)));

  return NextResponse.json({ ok: true });
}
