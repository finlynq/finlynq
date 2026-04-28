/**
 * POST /api/budgets/seed — Create starter budgets from the onboarding wizard.
 *
 * Accepts category name + amount. Looks up or creates the category,
 * then upserts a budget for the given month.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { getCategories, createCategory, upsertBudget } from "@/lib/queries";

const schema = z.object({
  categoryName: z.string().min(1),
  amount: z.number().positive(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const parsed = validateBody(await request.json(), schema);
  if (parsed.error) return parsed.error;
  const { categoryName, amount, month } = parsed.data;

  try {
    // Find existing category by name or create it
    const cats = await getCategories(userId);
    const existing = cats.find(
      (c: any) => c.name.toLowerCase() === categoryName.toLowerCase()
    );

    const category = existing ?? await createCategory(userId, {
      type: "expense",
      group: "Personal",
      name: categoryName,
    });

    if (!category) {
      return NextResponse.json({ error: "Failed to create category" }, { status: 500 });
    }

    await upsertBudget(userId, { categoryId: category.id, month, amount });

    return NextResponse.json({ success: true, categoryId: category.id });
  } catch (err) {
    return NextResponse.json({ error: safeErrorMessage(err, "Unknown error") }, { status: 500 });
  }
}
