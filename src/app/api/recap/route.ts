import { NextRequest, NextResponse } from "next/server";
import { generateWeeklyRecap } from "@/lib/weekly-recap";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const dateParam = request.nextUrl.searchParams.get("date") ?? undefined;
  const recap = generateWeeklyRecap(dateParam);
  return NextResponse.json(recap);
}
