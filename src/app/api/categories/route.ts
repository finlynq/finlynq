import { NextRequest, NextResponse } from "next/server";
import { getCategories, createCategory, updateCategory, deleteCategory } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { db } from "@/db";
import { isPgErrorCode, pgErrorConstraint } from "@/lib/db-utils";
import {
  getCategoryDeleteBlockers,
  categoryDeleteBlockedMessage,
} from "@/lib/categories/delete-blockers";

/**
 * Category names are unique per user via the `categories_user_name_lookup_uniq`
 * index over the name_lookup HMAC. Renaming onto an existing name is ordinary
 * user behaviour, not a server fault — without this it escaped as a raw 23505
 * and the user got an opaque 500 (prod 2026-07-24 20:25 UTC).
 */
function duplicateNameResponse(error: unknown): NextResponse | null {
  if (!isPgErrorCode(error, "23505")) return null;
  const constraint = pgErrorConstraint(error);
  if (constraint && constraint !== "categories_user_name_lookup_uniq") return null;
  return NextResponse.json(
    { error: "You already have a category with that name. Pick a different name." },
    { status: 409 },
  );
}

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
    const duplicate = duplicateNameResponse(error);
    if (duplicate) return duplicate;
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
    const duplicate = duplicateNameResponse(error);
    if (duplicate) return duplicate;
    await logApiError("PUT", "/api/categories", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update category") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    // Counts every ON DELETE NO ACTION referent, not just transactions — a
    // category attached to a budget used to escape as a raw 23503 from this
    // handler, which had no try/catch at all.
    const blockers = await getCategoryDeleteBlockers(db, auth.context.userId, id);
    if (blockers.length > 0) {
      return NextResponse.json({ error: categoryDeleteBlockedMessage(blockers) }, { status: 409 });
    }

    await deleteCategory(id, auth.context.userId);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/categories", error, auth.context.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete category") },
      { status: 500 },
    );
  }
}
