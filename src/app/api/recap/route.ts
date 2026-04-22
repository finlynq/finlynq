import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyRecap } from "@/lib/weekly-recap";
import { requireEncryption } from "@/lib/auth/require-encryption";

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const dateParam = request.nextUrl.searchParams.get("date") ?? undefined;
  const recap = await generateWeeklyRecap(auth.userId, dateParam, auth.dek);
  return NextResponse.json(recap);
}
