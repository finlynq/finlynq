import { NextRequest, NextResponse } from "next/server";
import { getBudgets, upsertBudget, deleteBudget } from "@/lib/queries";

export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month") ?? undefined;
  const data = getBudgets(month);
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const budget = upsertBudget(body);
    return NextResponse.json(budget, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to save budget";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteBudget(id);
  return NextResponse.json({ success: true });
}
