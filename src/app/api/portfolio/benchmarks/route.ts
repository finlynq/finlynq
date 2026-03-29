import { NextRequest, NextResponse } from "next/server";
import { getAllBenchmarkReturns } from "@/lib/benchmarks";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") ?? "1y";

    if (!["ytd", "1y", "3y", "5y"].includes(period)) {
      return NextResponse.json({ error: "Invalid period. Use ytd, 1y, 3y, or 5y." }, { status: 400 });
    }

    const benchmarks = await getAllBenchmarkReturns(period);

    return NextResponse.json({
      period,
      benchmarks,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch benchmarks";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
