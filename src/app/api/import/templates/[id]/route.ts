import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id } = await params;
  const templateId = parseInt(id, 10);

  try {
    const body = await request.json() as {
      name?: string;
      columnMapping?: Record<string, string>;
      defaultAccount?: string;
      isDefault?: boolean;
    };

    const existing = db
      .select()
      .from(schema.importTemplates)
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .get();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const updated = db
      .update(schema.importTemplates)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.columnMapping !== undefined ? { columnMapping: JSON.stringify(body.columnMapping) } : {}),
        ...(body.defaultAccount !== undefined ? { defaultAccount: body.defaultAccount } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault ? 1 : 0 } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .returning()
      .get();

    return NextResponse.json({
      ...updated,
      headers: JSON.parse(updated.headers ?? "[]"),
      columnMapping: JSON.parse(updated.columnMapping ?? "{}"),
    });
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

  try {
    const existing = db
      .select()
      .from(schema.importTemplates)
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .get();

    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    db.delete(schema.importTemplates)
      .where(and(eq(schema.importTemplates.id, templateId), eq(schema.importTemplates.userId, userId)))
      .run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to delete template") }, { status: 500 });
  }
}
