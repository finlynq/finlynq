import { NextRequest, NextResponse } from "next/server";
import { getCategories, createCategory, updateCategory, deleteCategory, getTransactionCountByCategory } from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const data = getCategories();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const category = createCategory(body);
    return NextResponse.json(category, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create category";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const { id, ...data } = body;
    const category = updateCategory(id, data);
    return NextResponse.json(category);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update category";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const txCount = getTransactionCountByCategory(id);
  if (txCount > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${txCount} transaction${txCount === 1 ? "" : "s"} reference this category` },
      { status: 409 }
    );
  }

  deleteCategory(id);
  return NextResponse.json({ success: true });
}
