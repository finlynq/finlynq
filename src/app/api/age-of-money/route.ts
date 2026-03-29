import { NextRequest, NextResponse } from "next/server";
import { calculateAgeOfMoney } from "@/lib/age-of-money";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const result = calculateAgeOfMoney(auth.context.userId);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to calculate age of money";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
