import { NextRequest, NextResponse } from "next/server";
import {
  getBudgetTemplates,
  createBudgetTemplate,
  deleteBudgetTemplate,
} from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { safeName } from "@/lib/safe-name";

const postSchema = z.object({
  name: z.string(),
  categoryId: z.number(),
  amount: z.number(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;
  const data = await getBudgetTemplates(userId);

  // Same defect the budgets route carried (GH #338): `getBudgetTemplates`
  // returns the encrypted `categoryNameCt` and the budgets page's
  // `BudgetTemplate` type declares a plaintext `categoryName`, so the field
  // was a shape the route never sent. It is invisible today only because the
  // Apply-Template dialog happens to render the template's own name — a change
  // to that dialog would surface the same blank label. Decrypt here (and
  // destructure the ciphertext out of the payload) so the response matches the
  // declared shape before anything renders it.
  return NextResponse.json(
    data.map(({ categoryNameCt, ...t }) => ({
      ...t,
      categoryName: safeName(decryptName(categoryNameCt, dek, null), "Category", t.categoryId),
    }))
  );
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const { name, categoryId, amount } = parsed.data;

    const template = await createBudgetTemplate(auth.context.userId, {
      name,
      categoryId,
      amount,
    });
    return NextResponse.json(template, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to save template") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await deleteBudgetTemplate(id, auth.context.userId);
  return NextResponse.json({ success: true });
}
