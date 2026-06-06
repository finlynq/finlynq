/**
 * /api/email-rules (Epic C2).
 *
 *   GET  — list the user's email-import rules (decrypted), priority desc.
 *   POST — create a rule. Encrypts name + match_value under the user DEK;
 *          verifies account_id / category_id ownership (cross-tenant → 404).
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

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  matchType: z.enum(["sender", "subject"]),
  matchOp: z.enum(["contains", "exact", "regex"]),
  matchValue: z.string().min(1).max(512),
  accountId: z.number().int().positive(),
  categoryId: z.number().int().positive().nullable().optional(),
  mode: z.enum(["auto", "review"]).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

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
      isActive: schema.emailImportRules.isActive,
      priority: schema.emailImportRules.priority,
    })
    .from(schema.emailImportRules)
    .where(eq(schema.emailImportRules.userId, userId))
    .orderBy(desc(schema.emailImportRules.priority), asc(schema.emailImportRules.id))
    .all();

  const items = rows.map((r) => {
    const dec = decryptEmailRuleFields(dek, { name: r.name, matchValue: r.matchValue });
    return {
      id: r.id,
      name: dec.name ?? r.name,
      matchType: r.matchType,
      matchOp: r.matchOp,
      matchValue: dec.matchValue ?? r.matchValue,
      accountId: r.accountId,
      categoryId: r.categoryId,
      mode: r.mode,
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

  const enc = encryptEmailRuleFields(dek, { name: d.name, matchValue: d.matchValue });
  const inserted = await db
    .insert(schema.emailImportRules)
    .values({
      userId,
      name: enc.name ?? d.name,
      matchType: d.matchType,
      matchOp: d.matchOp,
      matchValue: enc.matchValue ?? d.matchValue,
      accountId: d.accountId,
      categoryId: d.categoryId ?? null,
      mode: d.mode ?? "auto",
      isActive: d.isActive ?? true,
      priority: d.priority ?? 0,
    })
    .returning({ id: schema.emailImportRules.id });

  return NextResponse.json({ id: inserted[0].id }, { status: 201 });
}
