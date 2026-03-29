import { NextResponse } from "next/server";
import { calculateAgeOfMoney } from "@/lib/age-of-money";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const result = calculateAgeOfMoney();
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to calculate age of money";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
