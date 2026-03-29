import { NextRequest, NextResponse } from "next/server";
import { requireUnlock } from "@/lib/require-unlock";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  currentAge: z.number(),
  targetRetirementAge: z.number(),
  currentInvestments: z.number(),
  monthlySavings: z.number(),
  annualReturn: z.number(),
  inflation: z.number(),
  annualExpenses: z.number(),
  withdrawalRate: z.number(),
});

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const {
      currentAge,
      targetRetirementAge,
      currentInvestments,
      monthlySavings,
      annualReturn,
      inflation,
      annualExpenses,
      withdrawalRate,
    } = parsed.data;

    const realReturn = (annualReturn - inflation) / 100;
    const monthlyReturn = realReturn / 12;
    const fireNumber = annualExpenses / (withdrawalRate / 100);

    // Calculate years to FIRE
    // FV = PV*(1+r)^n + PMT*((1+r)^n - 1)/r = fireNumber
    // Solve for n
    let yearsToFire = 0;
    let balance = currentInvestments;
    const projections: { age: number; year: number; netWorth: number; fireNumber: number }[] = [];

    projections.push({
      age: currentAge,
      year: 0,
      netWorth: Math.round(balance * 100) / 100,
      fireNumber,
    });

    let fireReached = false;
    let fireAge = targetRetirementAge;
    const maxYears = Math.max(targetRetirementAge - currentAge + 10, 50);

    for (let y = 1; y <= maxYears; y++) {
      // Compound monthly within each year
      for (let m = 0; m < 12; m++) {
        balance = balance * (1 + monthlyReturn) + monthlySavings;
      }

      projections.push({
        age: currentAge + y,
        year: y,
        netWorth: Math.round(balance * 100) / 100,
        fireNumber,
      });

      if (!fireReached && balance >= fireNumber) {
        yearsToFire = y;
        fireAge = currentAge + y;
        fireReached = true;
      }
    }

    if (!fireReached) {
      yearsToFire = maxYears;
      fireAge = currentAge + maxYears;
    }

    // Calculate projected FIRE date
    const now = new Date();
    const fireDate = new Date(now.getFullYear() + yearsToFire, now.getMonth(), now.getDate());

    // Coast FIRE: amount needed now such that it grows to fireNumber by retirement age
    // coastFire = fireNumber / (1 + realReturn)^yearsToRetirement
    const yearsToRetirement = targetRetirementAge - currentAge;
    const coastFireNumber = fireNumber / Math.pow(1 + realReturn, yearsToRetirement);

    // Coast FIRE age: when can you stop saving entirely?
    // Find year when balance (without further contributions) will grow to fireNumber by retirement
    let coastFireAge = currentAge;
    let coastBalance = currentInvestments;
    for (let y = 0; y <= yearsToRetirement; y++) {
      const remainingYears = yearsToRetirement - y;
      const futureValue = coastBalance * Math.pow(1 + realReturn, remainingYears);
      if (futureValue >= fireNumber) {
        coastFireAge = currentAge + y;
        break;
      }
      // Add one year of savings + growth
      for (let m = 0; m < 12; m++) {
        coastBalance = coastBalance * (1 + monthlyReturn) + monthlySavings;
      }
      coastFireAge = currentAge + y + 1;
    }

    // Sensitivity table: return rates x savings adjustments
    const returnRates = [5, 6, 7, 8, 9];
    const savingsAdjustments = [-1000, -500, 0, 500, 1000];
    const sensitivityTable: { returnRate: number; savings: number; yearsToFire: number }[] = [];

    for (const rr of returnRates) {
      for (const adj of savingsAdjustments) {
        const adjSavings = monthlySavings + adj;
        if (adjSavings < 0) {
          sensitivityTable.push({ returnRate: rr, savings: adjSavings, yearsToFire: -1 });
          continue;
        }
        const mr = ((rr - inflation) / 100) / 12;
        let bal = currentInvestments;
        let years = 0;
        let found = false;
        for (let y = 1; y <= 80; y++) {
          for (let m = 0; m < 12; m++) {
            bal = bal * (1 + mr) + adjSavings;
          }
          if (bal >= fireNumber) {
            years = y;
            found = true;
            break;
          }
        }
        sensitivityTable.push({
          returnRate: rr,
          savings: adjSavings,
          yearsToFire: found ? years : -1,
        });
      }
    }

    return NextResponse.json({
      fireNumber: Math.round(fireNumber * 100) / 100,
      yearsToFire,
      fireAge,
      fireDate: fireDate.toISOString().split("T")[0],
      coastFireNumber: Math.round(coastFireNumber * 100) / 100,
      coastFireAge,
      currentInvestments,
      monthlySavings,
      projections,
      sensitivityTable,
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}
