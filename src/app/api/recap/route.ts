import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyRecap } from "@/lib/weekly-recap";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const dateParam = request.nextUrl.searchParams.get("date") ?? undefined;
  const recap = await generateWeeklyRecap(auth.context.userId, dateParam);
  return NextResponse.json(recap);
}
