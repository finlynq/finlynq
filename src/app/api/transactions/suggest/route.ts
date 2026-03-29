import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, and, eq } from "drizzle-orm";
import { suggestCategory } from "@/lib/auto-categorize";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const { transactions, categories } = schema;

// POST { payee } → suggested category
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const body = await req.json();

    const suggestSchema = z.object({
      payee: z.string().min(1, "Payee is required"),
    });
    const parsed = validateBody(body, suggestSchema);
    if (parsed.error) return parsed.error;

    const { payee } = parsed.data;

    // Get existing transactions with their payee and categoryId
    const existing = db
      .select({
        payee: transactions.payee,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          sql`${transactions.payee} IS NOT NULL AND ${transactions.payee} != '' AND ${transactions.categoryId} IS NOT NULL`
        )
      )
      .all();

    const suggestedCategoryId = suggestCategory(payee, existing);

    if (!suggestedCategoryId) {
      return NextResponse.json({ suggestion: null });
    }

    // Get category details
    const category = db
      .select({
        id: categories.id,
        name: categories.name,
        type: categories.type,
        group: categories.group,
      })
      .from(categories)
      .where(and(eq(categories.id, suggestedCategoryId), eq(categories.userId, userId)))
      .get();

    return NextResponse.json({ suggestion: category ?? null });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to suggest category");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
