import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";
import { deserializeTemplate, autoDetectColumnMapping } from "@/lib/import-templates";
import type { ColumnMapping } from "@/lib/import-templates";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const rows = db
      .select()
      .from(schema.importTemplates)
      .where(eq(schema.importTemplates.userId, userId))
      .all();

    return NextResponse.json(rows.map(deserializeTemplate));
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to fetch templates") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const body = await request.json() as {
      name: string;
      fileHeaders: string[];
      columnMapping?: ColumnMapping;
      defaultAccount?: string;
      isDefault?: boolean;
    };

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Template name is required" }, { status: 400 });
    }
    if (!Array.isArray(body.fileHeaders) || body.fileHeaders.length === 0) {
      return NextResponse.json({ error: "fileHeaders is required" }, { status: 400 });
    }

    // Auto-detect mapping if not provided
    const mapping: ColumnMapping | null =
      body.columnMapping ?? autoDetectColumnMapping(body.fileHeaders);

    if (!mapping) {
      return NextResponse.json(
        { error: "Could not detect column mapping. Please provide columnMapping explicitly." },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();

    // If this is set as default, clear other defaults for user
    if (body.isDefault) {
      db.update(schema.importTemplates)
        .set({ isDefault: 0 })
        .where(eq(schema.importTemplates.userId, userId))
        .run();
    }

    const result = db
      .insert(schema.importTemplates)
      .values({
        userId,
        name: body.name.trim(),
        fileHeaders: JSON.stringify(body.fileHeaders),
        columnMapping: JSON.stringify(mapping),
        defaultAccount: body.defaultAccount ?? null,
        isDefault: body.isDefault ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return NextResponse.json(deserializeTemplate(result), { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create template") }, { status: 500 });
  }
}
