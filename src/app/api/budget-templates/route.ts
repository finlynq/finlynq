import { NextRequest, NextResponse } from "next/server";
import {
  getBudgetTemplates,
  createBudgetTemplate,
  deleteBudgetTemplate,
} from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  name: z.string(),
  categoryId: z.number(),
  amount: z.number(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const data = await getBudgetTemplates(auth.context.userId);
  return NextResponse.json(data);
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
