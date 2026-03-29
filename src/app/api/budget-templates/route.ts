import { NextRequest, NextResponse } from "next/server";
import {
  getBudgetTemplates,
  createBudgetTemplate,
  deleteBudgetTemplate,
} from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const data = getBudgetTemplates();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const { name, categoryId, amount } = body;

    if (!name || !categoryId || !amount) {
      return NextResponse.json(
        { error: "name, categoryId, and amount are required" },
        { status: 400 }
      );
    }

    const template = createBudgetTemplate({
      name,
      categoryId: Number(categoryId),
      amount: Number(amount),
    });
    return NextResponse.json(template, { status: 201 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to save template";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteBudgetTemplate(id);
  return NextResponse.json({ success: true });
}
