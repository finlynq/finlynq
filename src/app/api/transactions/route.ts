import { NextRequest, NextResponse } from "next/server";
import { getTransactions, getTransactionCount, createTransaction, updateTransaction, deleteTransaction } from "@/lib/queries";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const filters = {
    startDate: params.get("startDate") ?? undefined,
    endDate: params.get("endDate") ?? undefined,
    accountId: params.get("accountId") ? parseInt(params.get("accountId")!) : undefined,
    categoryId: params.get("categoryId") ? parseInt(params.get("categoryId")!) : undefined,
    search: params.get("search") ?? undefined,
    limit: params.get("limit") ? parseInt(params.get("limit")!) : 100,
    offset: params.get("offset") ? parseInt(params.get("offset")!) : 0,
  };

  const data = getTransactions(filters);
  const total = getTransactionCount(filters);

  return NextResponse.json({ data, total });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const tx = createTransaction(body);
    return NextResponse.json(tx, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create transaction";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, ...data } = body;
    const tx = updateTransaction(id, data);
    return NextResponse.json(tx);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to update transaction";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteTransaction(id);
  return NextResponse.json({ success: true });
}
