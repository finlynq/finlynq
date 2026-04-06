import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

/** Score how well a set of headers matches a saved template (0–100). */
function scoreHeaderMatch(templateHeaders: string[], fileHeaders: string[]): number {
  if (templateHeaders.length === 0 || fileHeaders.length === 0) return 0;
  const fileSet = new Set(fileHeaders.map((h) => h.toLowerCase().trim()));
  const matches = templateHeaders.filter((h) => fileSet.has(h.toLowerCase().trim())).length;
  return Math.round((matches / templateHeaders.length) * 100);
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const headersParam = request.nextUrl.searchParams.get("headers");

    const templates = db
      .select()
      .from(schema.importTemplates)
      .where(eq(schema.importTemplates.userId, userId))
      .all();

    const result = templates.map((t) => ({
      ...t,
      headers: JSON.parse(t.headers ?? "[]") as string[],
      columnMapping: JSON.parse(t.columnMapping ?? "{}") as Record<string, string>,
    }));

    // If ?headers= provided, score and sort by match quality
    if (headersParam) {
      const fileHeaders = JSON.parse(headersParam) as string[];
      const scored = result.map((t) => ({
        ...t,
        matchScore: scoreHeaderMatch(t.headers, fileHeaders),
      }));
      scored.sort((a, b) => b.matchScore - a.matchScore);
      return NextResponse.json(scored);
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to list templates") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    const body = await request.json() as {
      name: string;
      fileType?: string;
      headers: string[];
      columnMapping: Record<string, string>;
      defaultAccount?: string;
      isDefault?: boolean;
    };

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Template name is required" }, { status: 400 });
    }
    if (!body.columnMapping?.date || !body.columnMapping?.amount) {
      return NextResponse.json({ error: "date and amount mappings are required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const inserted = db
      .insert(schema.importTemplates)
      .values({
        userId,
        name: body.name.trim(),
        fileType: body.fileType ?? "csv",
        headers: JSON.stringify(body.headers ?? []),
        columnMapping: JSON.stringify(body.columnMapping),
        defaultAccount: body.defaultAccount ?? "",
        isDefault: body.isDefault ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return NextResponse.json({
      ...inserted,
      headers: JSON.parse(inserted.headers ?? "[]"),
      columnMapping: JSON.parse(inserted.columnMapping ?? "{}"),
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create template") }, { status: 500 });
  }
}
