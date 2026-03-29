import { NextRequest, NextResponse } from "next/server";
import { runMonteCarloSimulation } from "@/lib/monte-carlo";
import { requireUnlock } from "@/lib/require-unlock";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  currentInvestments: z.number(),
  monthlySavings: z.number(),
  annualReturn: z.number(),
  annualExpenses: z.number(),
  annualVolatility: z.number().optional(),
  inflation: z.number().optional(),
  yearsToSimulate: z.number().optional(),
  withdrawalRate: z.number().optional(),
});

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const {
      currentInvestments,
      monthlySavings,
      annualReturn,
      annualVolatility,
      inflation,
      yearsToSimulate,
      withdrawalRate,
      annualExpenses,
    } = parsed.data;

    const result = runMonteCarloSimulation({
      currentInvestments,
      monthlySavings,
      annualReturn,
      annualVolatility: annualVolatility ?? 15,
      inflation: inflation ?? 2,
      yearsToSimulate: yearsToSimulate ?? 30,
      numSimulations: 1000,
      withdrawalRate: withdrawalRate ?? 4,
      annualExpenses,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Simulation failed") }, { status: 500 });
  }
}
