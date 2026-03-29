import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, asc } from "drizzle-orm";
import { requireUnlock } from "@/lib/require-unlock";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  name: z.string(),
  matchField: z.string(),
  matchType: z.string(),
  matchValue: z.string(),
  assignCategoryId: z.number().optional(),
  assignTags: z.string().optional(),
  renameTo: z.string().optional(),
  priority: z.number().optional(),
});

const putSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  matchField: z.string().optional(),
  matchType: z.string().optional(),
  matchValue: z.string().optional(),
  assignCategoryId: z.number().optional(),
  assignTags: z.string().optional(),
  renameTo: z.string().optional(),
  isActive: z.number().optional(),
  priority: z.number().optional(),
});

const { transactionRules, categories } = schema;

// GET — list all rules
export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const rules = db
    .select({
      id: transactionRules.id,
      name: transactionRules.name,
      matchField: transactionRules.matchField,
      matchType: transactionRules.matchType,
      matchValue: transactionRules.matchValue,
      assignCategoryId: transactionRules.assignCategoryId,
      categoryName: categories.name,
      assignTags: transactionRules.assignTags,
      renameTo: transactionRules.renameTo,
      isActive: transactionRules.isActive,
      priority: transactionRules.priority,
      createdAt: transactionRules.createdAt,
    })
    .from(transactionRules)
    .leftJoin(categories, eq(transactionRules.assignCategoryId, categories.id))
    .orderBy(asc(transactionRules.priority))
    .all();

  return NextResponse.json(rules);
}

// POST — create a new rule
export async function POST(req: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await req.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const { name, matchField, matchType, matchValue, assignCategoryId, assignTags, renameTo, priority } = parsed.data;

    const rule = db
      .insert(transactionRules)
      .values({
        name: name.trim(),
        matchField,
        matchType,
        matchValue: matchValue.trim(),
        assignCategoryId: assignCategoryId || null,
        assignTags: assignTags || null,
        renameTo: renameTo || null,
        isActive: 1,
        priority: priority ?? 0,
        createdAt: new Date().toISOString().split("T")[0],
      })
      .returning()
      .get();

    return NextResponse.json(rule, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create rule") }, { status: 500 });
  }
}

// PUT — update an existing rule
export async function PUT(req: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await req.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...updates } = parsed.data;

    // Build a clean update object
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name.trim();
    if (updates.matchField !== undefined) data.matchField = updates.matchField;
    if (updates.matchType !== undefined) data.matchType = updates.matchType;
    if (updates.matchValue !== undefined) data.matchValue = updates.matchValue.trim();
    if (updates.assignCategoryId !== undefined) data.assignCategoryId = updates.assignCategoryId || null;
    if (updates.assignTags !== undefined) data.assignTags = updates.assignTags || null;
    if (updates.renameTo !== undefined) data.renameTo = updates.renameTo || null;
    if (updates.isActive !== undefined) data.isActive = updates.isActive;
    if (updates.priority !== undefined) data.priority = updates.priority;

    const rule = db
      .update(transactionRules)
      .set(data)
      .where(eq(transactionRules.id, id))
      .returning()
      .get();

    if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    return NextResponse.json(rule);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update rule") }, { status: 500 });
  }
}

// DELETE — delete a rule
export async function DELETE(req: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID is required" }, { status: 400 });

  db.delete(transactionRules).where(eq(transactionRules.id, parseInt(id))).run();
  return NextResponse.json({ success: true });
}
