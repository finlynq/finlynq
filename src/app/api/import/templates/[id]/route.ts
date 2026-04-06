import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { deserializeTemplate } from "@/lib/import-templates";
import type { ColumnMapping } from "@/lib/import-templates";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id } = await params;
  const templateId = parseInt(id, 10);

  if (isNaN(templateId)) {
    return NextResponse.json({ error: "Invalid template ID" }, { status: 400 });
  }

  try {
    const body = await request.json() as {
      name?: string;
      fileHeaders?: string[];
      columnMapping?: ColumnMapping;
      defaultAccount?: string | null;
      isDefault?: boolean;
    };

    const existing = await db
      .select()
      .from(schema.importTemplates)
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .get();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    // If setting as default, clear others
    if (body.isDefault) {
      await db.update(schema.importTemplates)
        .set({ isDefault: 0 })
        .where(eq(schema.importTemplates.userId, userId))
        .run();
    }

    const updated = await db
      .update(schema.importTemplates)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.fileHeaders !== undefined ? { fileHeaders: JSON.stringify(body.fileHeaders) } : {}),
        ...(body.columnMapping !== undefined ? { columnMapping: JSON.stringify(body.columnMapping) } : {}),
        ...(body.defaultAccount !== undefined ? { defaultAccount: body.defaultAccount } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault ? 1 : 0 } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .returning()
      .get();

    return NextResponse.json(deserializeTemplate(updated));
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update template") }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id } = await params;
  const templateId = parseInt(id, 10);

  if (isNaN(templateId)) {
    return NextResponse.json({ error: "Invalid template ID" }, { status: 400 });
  }

  try {
    const existing = await db
      .select()
      .from(schema.importTemplates)
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .get();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    await db.delete(schema.importTemplates)
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to delete template") }, { status: 500 });
  }
}
