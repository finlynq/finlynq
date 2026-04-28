import { NextRequest, NextResponse } from "next/server";
import { getCategories, createCategory, updateCategory, deleteCategory, getTransactionCountByCategory } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows } from "@/lib/crypto/encrypted-columns";

const postSchema = z.object({
  name: z.string(),
  type: z.string(),
  group: z.string(),
  note: z.string().optional(),
});

const putSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: z.string().optional(),
  group: z.string().optional(),
  note: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const rows = await getCategories(auth.context.userId);
    const data = decryptNamedRows(rows, auth.context.dek, { nameCt: "name" });
    return NextResponse.json(data);
  } catch (error: unknown) {
    await logApiError("GET", "/api/categories", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to load categories") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const enc = buildNameFields(auth.context.dek, { name: parsed.data.name });
    const category = await createCategory(auth.context.userId, { ...parsed.data, ...enc });
    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/categories", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create category") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;
    const toEncrypt: Record<string, string | null | undefined> = {};
    if ("name" in data && data.name !== undefined) toEncrypt.name = data.name;
    const enc = buildNameFields(auth.context.dek, toEncrypt);
    const category = await updateCategory(id, auth.context.userId, { ...data, ...enc });
    return NextResponse.json(category);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/categories", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update category") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const txCount = await getTransactionCountByCategory(id, auth.context.userId);
  if (txCount > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${txCount} transaction${txCount === 1 ? "" : "s"} reference this category` },
      { status: 409 }
    );
  }

  await deleteCategory(id, auth.context.userId);
  return NextResponse.json({ success: true });
}
