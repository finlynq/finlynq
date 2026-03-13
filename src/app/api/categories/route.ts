import { NextRequest, NextResponse } from "next/server";
import { getCategories, createCategory, updateCategory, deleteCategory } from "@/lib/queries";

export async function GET() {
  const data = getCategories();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
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
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteCategory(id);
  return NextResponse.json({ success: true });
}
