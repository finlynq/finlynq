/**
 * /api/email-rules (Epic C2; multi-condition 2026-06-17).
 *
 *   GET  — list the user's email-import rules (decrypted), priority desc. Each
 *          rule returns a `conditions` array (synthesized from the legacy flat
 *          tri for pre-migration rows).
 *   POST — create a rule. Accepts `conditions` (preferred) OR the legacy flat
 *          match tri (back-compat shim); normalizes to `conditions`, encrypts
 *          text-field string values + name + payeeOverride; verifies
 *          account_id / category_id ownership (cross-tenant → 404). New rows
 *          leave the flat match columns NULL.
 *
 * requireEncryption (writes/reads encrypted fields). Bare JSON.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody } from "@/lib/validate";
import {
  encryptEmailRuleFields,
  decryptEmailRuleFields,
} from "@/lib/email-rules/crypto";
import {
  EmailConditionGroup,
  type EmailCondition,
} from "@/lib/email-rules/schema";

export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    conditions: EmailConditionGroup.optional(),
    // Legacy flat match tri — back-compat input shim (normalized to conditions).
    matchType: z.enum(["sender", "subject"]).optional(),
    matchOp: z.enum(["contains", "exact", "regex"]).optional(),
    matchValue: z.string().min(1).max(512).optional(),
    accountId: z.number().int().positive(),
    categoryId: z.number().int().positive().nullable().optional(),
    mode: z.enum(["auto", "review"]).optional(),
    flipSign: z.boolean().optional(),
    dateSource: z.enum(["parsed", "received"]).optional(),
    payeeOverride: z.string().max(120).nullable().optional(),
    isActive: z.boolean().optional(),
    priority: z.number().int().optional(),
  })
  .refine(
    (d) => d.conditions != null || (d.matchType != null && d.matchOp != null && d.matchValue != null),
    { message: "Provide conditions or the legacy match fields.", path: ["conditions"] },
  );

/** Extract the `.all` array (decrypted), synthesizing from the flat tri for
 *  pre-migration rows. Shared GET shape. */
function rowConditions(
  decConditions: unknown,
  flat: { matchType: string | null; matchOp: string | null; matchValue: string | null },
): EmailCondition[] {
  const c = decConditions as { all?: unknown } | null | undefined;
  if (c && Array.isArray(c.all)) return c.all as EmailCondition[];
  if (flat.matchType && flat.matchOp && flat.matchValue) {
    return [
      {
        field: flat.matchType as "sender" | "subject",
        op: flat.matchOp as "contains" | "exact" | "regex",
        value: flat.matchValue,
      },
    ];
  }
  return [];
}

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

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
      isActive: schema.emailImportRules.isActive,
      priority: schema.emailImportRules.priority,
    })
    .from(schema.emailImportRules)
    .where(eq(schema.emailImportRules.userId, userId))
    .orderBy(desc(schema.emailImportRules.priority), asc(schema.emailImportRules.id))
    .all();

  const items = rows.map((r) => {
    const dec = decryptEmailRuleFields(dek, {
      name: r.name,
      matchValue: r.matchValue,
      payeeOverride: r.payeeOverride,
      conditions: (r.conditions ?? null) as EmailConditionGroup | null,
    });
    return {
      id: r.id,
      name: dec.name ?? r.name,
      conditions: rowConditions(dec.conditions, {
        matchType: r.matchType,
        matchOp: r.matchOp,
        matchValue: dec.matchValue ?? r.matchValue,
      }),
      accountId: r.accountId,
      categoryId: r.categoryId,
      mode: r.mode,
      flipSign: r.flipSign,
      dateSource: r.dateSource,
      payeeOverride: dec.payeeOverride ?? r.payeeOverride,
      isActive: r.isActive,
      priority: r.priority,
    };
  });
  return NextResponse.json(items);
}

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, createSchema);
  if (parsed.error) return parsed.error;
  const d = parsed.data;

  // Ownership: account is required; category optional but checked when present.
  const acct = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, d.accountId), eq(schema.accounts.userId, userId)))
    .limit(1);
  if (!acct[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (d.categoryId != null) {
    const cat = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.id, d.categoryId), eq(schema.categories.userId, userId)))
      .limit(1);
    if (!cat[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Normalize to conditions (legacy flat tri → single condition).
  const conditionsGroup = d.conditions ?? {
    all: [{ field: d.matchType!, op: d.matchOp!, value: d.matchValue! }],
  };

  const enc = encryptEmailRuleFields(dek, {
    name: d.name,
    payeeOverride: d.payeeOverride ?? undefined,
    conditions: conditionsGroup,
  });
  const inserted = await db
    .insert(schema.emailImportRules)
    .values({
      userId,
      name: enc.name ?? d.name,
      conditions: enc.conditions ?? conditionsGroup,
      // Conditions-only going forward — flat match columns stay NULL.
      matchType: null,
      matchOp: null,
      matchValue: null,
      accountId: d.accountId,
      categoryId: d.categoryId ?? null,
      mode: d.mode ?? "auto",
      flipSign: d.flipSign ?? false,
      dateSource: d.dateSource ?? "parsed",
      payeeOverride: enc.payeeOverride ?? d.payeeOverride ?? null,
      isActive: d.isActive ?? true,
      priority: d.priority ?? 0,
    })
    .returning({ id: schema.emailImportRules.id });

  return NextResponse.json({ id: inserted[0].id }, { status: 201 });
}
