import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyRecap } from "@/lib/weekly-recap";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, dek } = auth.context;
  // Recap tolerates a missing DEK â€” payees will render as ciphertext on
  // encrypted rows, but the rest of the recap (totals, categories, budgets)
  // stays correct. Better than 423ing the whole dashboard.
  const dateParam = request.nextUrl.searchParams.get("date") ?? undefined;
  const recap = await generateWeeklyRecap(userId, dateParam, dek);
  return NextResponse.json(recap);
}
