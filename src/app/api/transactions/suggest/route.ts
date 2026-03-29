import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql } from "drizzle-orm";
import { suggestCategory } from "@/lib/auto-categorize";
import { requireUnlock } from "@/lib/require-unlock";

const { transactions, categories } = schema;

// POST { payee } → suggested category
export async function POST(req: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await req.json();
    const { payee } = body;

    if (!payee?.trim()) {
      return NextResponse.json({ error: "Payee is required" }, { status: 400 });
    }

    // Get existing transactions with their payee and categoryId
    const existing = db
      .select({
        payee: transactions.payee,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(
        sql`${transactions.payee} IS NOT NULL AND ${transactions.payee} != '' AND ${transactions.categoryId} IS NOT NULL`
      )
      .all();

    const suggestedCategoryId = suggestCategory(payee, existing);

    if (!suggestedCategoryId) {
      return NextResponse.json({ suggestion: null });
    }

    // Get category details
    const category = db
      .select({
        id: categories.id,
        name: categories.name,
        type: categories.type,
        group: categories.group,
      })
      .from(categories)
      .where(sql`${categories.id} = ${suggestedCategoryId}`)
      .get();

    return NextResponse.json({ suggestion: category ?? null });
  } catch {
    return NextResponse.json({ error: "Failed to suggest category" }, { status: 500 });
  }
}
