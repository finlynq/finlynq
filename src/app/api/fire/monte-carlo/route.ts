import { NextRequest, NextResponse } from "next/server";
import { runMonteCarloSimulation } from "@/lib/monte-carlo";
import { requireUnlock } from "@/lib/require-unlock";

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const {
      currentInvestments,
      monthlySavings,
      annualReturn,
      annualVolatility,
      inflation,
      yearsToSimulate,
      withdrawalRate,
      annualExpenses,
    } = body;

    // Validate required fields
    if (currentInvestments == null || monthlySavings == null || annualReturn == null || annualExpenses == null) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const result = runMonteCarloSimulation({
      currentInvestments: Number(currentInvestments),
      monthlySavings: Number(monthlySavings),
      annualReturn: Number(annualReturn),
      annualVolatility: Number(annualVolatility ?? 15),
      inflation: Number(inflation ?? 2),
      yearsToSimulate: Number(yearsToSimulate ?? 30),
      numSimulations: 1000,
      withdrawalRate: Number(withdrawalRate ?? 4),
      annualExpenses: Number(annualExpenses),
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Simulation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
