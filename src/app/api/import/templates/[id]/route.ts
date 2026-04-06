import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const { importTemplates } = schema;

const putSchema = z.object({
  name: z.string().min(1).optional(),
  accountId: z.number().int().nullable().optional(),
  fileType: z.string().optional(),
  columnMapping: z.record(z.string()).optional(),
  hasHeaders: z.boolean().optional(),
  dateFormat: z.string().optional(),
  amountFormat: z.enum(["standard", "negate", "debit_credit"]).optional(),
  isDefault: z.boolean().optional(),
});

/** PUT /api/import/templates/:id — update a template */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const data = parsed.data;

    // Verify ownership
    const existing = await db
      .select()
      .from(importTemplates)
      .where(and(eq(importTemplates.id, id), eq(importTemplates.userId, userId)))
      .get();
    if (!existing) return NextResponse.json({ error: "Template not found" }, { status: 404 });

    // If marking as default, unset existing default first
    if (data.isDefault) {
      await db
        .update(importTemplates)
        .set({ isDefault: 0 })
        .where(eq(importTemplates.userId, userId))
        .run();
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.accountId !== undefined) updates.accountId = data.accountId;
    if (data.fileType !== undefined) updates.fileType = data.fileType;
    if (data.columnMapping !== undefined) updates.columnMapping = JSON.stringify(data.columnMapping);
    if (data.hasHeaders !== undefined) updates.hasHeaders = data.hasHeaders ? 1 : 0;
    if (data.dateFormat !== undefined) updates.dateFormat = data.dateFormat;
    if (data.amountFormat !== undefined) updates.amountFormat = data.amountFormat;
    if (data.isDefault !== undefined) updates.isDefault = data.isDefault ? 1 : 0;

    const updated = await db
      .update(importTemplates)
      .set(updates)
      .where(and(eq(importTemplates.id, id), eq(importTemplates.userId, userId)))
      .returning()
      .get();

    return NextResponse.json({ ...updated, columnMapping: JSON.parse(updated!.columnMapping) });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update import template") },
      { status: 500 }
    );
  }
}

/** DELETE /api/import/templates/:id — delete a template */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  try {
    const existing = await db
      .select()
      .from(importTemplates)
      .where(and(eq(importTemplates.id, id), eq(importTemplates.userId, userId)))
      .get();
    if (!existing) return NextResponse.json({ error: "Template not found" }, { status: 404 });

    await db
      .delete(importTemplates)
      .where(and(eq(importTemplates.id, id), eq(importTemplates.userId, userId)))
      .run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete import template") },
      { status: 500 }
    );
  }
}
