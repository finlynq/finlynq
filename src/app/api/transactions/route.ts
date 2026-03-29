import { NextRequest, NextResponse } from "next/server";
import { getTransactions, getTransactionCount, createTransaction, updateTransaction, deleteTransaction } from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  date: z.string(),
  amount: z.number(),
  accountId: z.number(),
  categoryId: z.number(),
  currency: z.string(),
  payee: z.string().optional(),
  quantity: z.number().optional(),
  portfolioHolding: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  isBusiness: z.number().optional(),
  splitPerson: z.string().optional(),
  splitRatio: z.number().optional(),
});

const putSchema = z.object({
  id: z.number(),
  date: z.string().optional(),
  amount: z.number().optional(),
  accountId: z.number().optional(),
  categoryId: z.number().optional(),
  currency: z.string().optional(),
  payee: z.string().optional(),
  quantity: z.number().optional(),
  portfolioHolding: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  isBusiness: z.number().optional(),
  splitPerson: z.string().optional(),
  splitRatio: z.number().optional(),
});

export async function GET(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
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
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const tx = createTransaction(parsed.data);
    return NextResponse.json(tx, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create transaction") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;
    const tx = updateTransaction(id, data);
    return NextResponse.json(tx);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update transaction") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  deleteTransaction(id);
  return NextResponse.json({ success: true });
}
