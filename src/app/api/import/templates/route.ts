import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { rankTemplates } from "@/lib/import-template-matcher";

const { importTemplates } = schema;

const postSchema = z.object({
  name: z.string().min(1, "Name is required"),
  accountId: z.number().int().nullable().optional(),
  fileType: z.string().default("csv"),
  columnMapping: z.record(z.string()).refine((v) => {
    try { JSON.stringify(v); return true; } catch { return false; }
  }, "Invalid column mapping"),
  hasHeaders: z.boolean().default(true),
  dateFormat: z.string().default("YYYY-MM-DD"),
  amountFormat: z.enum(["standard", "negate", "debit_credit"]).default("standard"),
  isDefault: z.boolean().default(false),
});

/** GET /api/import/templates — list all templates for the user.
 *  Optional query param: ?headers=Date,Amount,Description  (comma-separated)
 *  When headers is provided, each template includes a matchScore. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const templates = await db
      .select()
      .from(importTemplates)
      .where(eq(importTemplates.userId, userId))
      .orderBy(importTemplates.name)
      .all();

    // Optional header-based matching
    const rawHeaders = request.nextUrl.searchParams.get("headers");
    if (rawHeaders) {
      const fileHeaders = rawHeaders.split(",").map((h) => h.trim()).filter(Boolean);
      const ranked = rankTemplates(fileHeaders, templates);
      return NextResponse.json(
        ranked.map(({ template, score, matchedColumns, missingColumns }) => ({
          ...template,
          columnMapping: JSON.parse(template.columnMapping),
          matchScore: score,
          matchedColumns,
          missingColumns,
        }))
      );
    }

    return NextResponse.json(
      templates.map((t) => ({ ...t, columnMapping: JSON.parse(t.columnMapping) }))
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load import templates") },
      { status: 500 }
    );
  }
}

/** POST /api/import/templates — create a new template */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const data = parsed.data;

    const now = new Date().toISOString();

    // If marking as default, unset any existing default first
    if (data.isDefault) {
      await db
        .update(importTemplates)
        .set({ isDefault: 0 })
        .where(eq(importTemplates.userId, userId))
        .run();
    }

    const template = await db
      .insert(importTemplates)
      .values({
        userId,
        name: data.name,
        accountId: data.accountId ?? null,
        fileType: data.fileType,
        columnMapping: JSON.stringify(data.columnMapping),
        hasHeaders: data.hasHeaders ? 1 : 0,
        dateFormat: data.dateFormat,
        amountFormat: data.amountFormat,
        isDefault: data.isDefault ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return NextResponse.json(
      { ...template, columnMapping: JSON.parse(template.columnMapping) },
      { status: 201 }
    );
  } catch (error: unknown) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create import template") },
      { status: 500 }
    );
  }
}
