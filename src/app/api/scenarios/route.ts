import { NextRequest, NextResponse } from "next/server";
import {
  calculateMonthlyPayment,
  generateAmortizationSchedule,
  calculateDebtPayoff,
  type Debt,
} from "@/lib/loan-calculator";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireDevMode } from "@/lib/require-dev-mode";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  try {
    const body = await request.json();

    const scenarioSchema = z.object({
      type: z.enum(["home-purchase", "extra-savings", "debt-payoff", "income-change"]),
    }).passthrough();
    const parsed = validateBody(body, scenarioSchema);
    if (parsed.error) return parsed.error;

    const { type } = parsed.data;

    if (type === "home-purchase") {
      const { purchasePrice, downPaymentPct, interestRate, amortizationYears, propertyTaxYear, maintenanceYear } = body;
      const downPayment = purchasePrice * (downPaymentPct / 100);
      const principal = purchasePrice - downPayment;
      const termMonths = amortizationYears * 12;
      const monthlyPayment = calculateMonthlyPayment(principal, interestRate, termMonths);
      const totalPayments = monthlyPayment * termMonths;
      const totalInterest = totalPayments - principal;
      const monthlyPropertyTax = propertyTaxYear / 12;
      const monthlyMaintenance = maintenanceYear / 12;
      const monthlyCashFlow = monthlyPayment + monthlyPropertyTax + monthlyMaintenance;

      const schedule = generateAmortizationSchedule(principal, interestRate, termMonths, new Date().toISOString().split("T")[0]);
      const balanceOverTime = schedule.schedule
        .filter((_, i) => i % 12 === 0 || i === schedule.schedule.length - 1)
        .map((row) => ({
          year: Math.ceil(row.period / 12),
          balance: row.balance,
          equity: purchasePrice - row.balance,
        }));

      return NextResponse.json({
        downPayment,
        principal,
        monthlyPayment: Math.round(monthlyPayment * 100) / 100,
        totalInterest: Math.round(totalInterest * 100) / 100,
        totalPayments: Math.round(totalPayments * 100) / 100,
        monthlyCashFlow: Math.round(monthlyCashFlow * 100) / 100,
        monthlyPropertyTax: Math.round(monthlyPropertyTax * 100) / 100,
        monthlyMaintenance: Math.round(monthlyMaintenance * 100) / 100,
        balanceOverTime,
      });
    }

    if (type === "extra-savings") {
      const { monthlySavings, returnRate, years } = body;
      const monthlyRate = returnRate / 100 / 12;
      const months = years * 12;
      const projections: { year: number; contributions: number; growth: number; total: number }[] = [];

      for (let y = 1; y <= years; y++) {
        const m = y * 12;
        let futureValue: number;
        if (monthlyRate === 0) {
          futureValue = monthlySavings * m;
        } else {
          futureValue = monthlySavings * ((Math.pow(1 + monthlyRate, m) - 1) / monthlyRate);
        }
        const totalContributions = monthlySavings * m;
        projections.push({
          year: y,
          contributions: Math.round(totalContributions * 100) / 100,
          growth: Math.round((futureValue - totalContributions) * 100) / 100,
          total: Math.round(futureValue * 100) / 100,
        });
      }

      const finalValue = projections[projections.length - 1]?.total ?? 0;
      const totalContributions = monthlySavings * months;

      return NextResponse.json({
        futureValue: Math.round(finalValue * 100) / 100,
        totalContributions: Math.round(totalContributions * 100) / 100,
        totalGrowth: Math.round((finalValue - totalContributions) * 100) / 100,
        projections,
      });
    }

    if (type === "debt-payoff") {
      const { debts, extraBudget } = body as { debts: Debt[]; extraBudget: number };
      const avalanche = calculateDebtPayoff(debts, extraBudget ?? 0, "avalanche");
      const snowball = calculateDebtPayoff(debts, extraBudget ?? 0, "snowball");

      function simulateDebt(debtsIn: Debt[], extra: number, strategy: "avalanche" | "snowball") {
        const sorted = [...debtsIn].sort((a, b) =>
          strategy === "avalanche" ? b.rate - a.rate : a.balance - b.balance
        );
        const balances = new Map(sorted.map((d) => [d.name, d.balance]));
        const timeline: { month: number; totalDebt: number }[] = [];
        let month = 0;
        let availableExtra = extra;
        const paidOff = new Set<string>();

        timeline.push({ month: 0, totalDebt: debtsIn.reduce((s, d) => s + d.balance, 0) });

        while (Array.from(balances.values()).some((b) => b > 0.01) && month < 600) {
          month++;
          let extraThisMonth = availableExtra;

          for (const debt of sorted) {
            const bal = balances.get(debt.name) ?? 0;
            if (bal <= 0.01) continue;
            const interest = (bal * debt.rate) / 100 / 12;
            let payment = debt.minPayment;
            if (sorted.find((d) => (balances.get(d.name) ?? 0) > 0.01)?.name === debt.name) {
              payment += extraThisMonth;
              extraThisMonth = 0;
            }
            const newBal = Math.max(bal + interest - payment, 0);
            balances.set(debt.name, newBal);
            if (newBal <= 0.01 && !paidOff.has(debt.name)) {
              paidOff.add(debt.name);
              availableExtra += debt.minPayment;
            }
          }

          if (month % 1 === 0) {
            timeline.push({
              month,
              totalDebt: Math.round(Array.from(balances.values()).reduce((s, b) => s + b, 0) * 100) / 100,
            });
          }
        }
        return timeline;
      }

      const avalancheTimeline = simulateDebt(debts, extraBudget ?? 0, "avalanche");
      const snowballTimeline = simulateDebt(debts, extraBudget ?? 0, "snowball");

      return NextResponse.json({
        avalanche,
        snowball,
        avalancheTimeline,
        snowballTimeline,
      });
    }

    if (type === "income-change") {
      const { currentIncome, newIncome, currentSavingsRate } = body;

      function estimateTax(annual: number) {
        let tax = 0;
        const brackets = [
          { limit: 55867, rate: 0.15 },
          { limit: 111733, rate: 0.205 },
          { limit: 154906, rate: 0.26 },
          { limit: 220000, rate: 0.29 },
          { limit: Infinity, rate: 0.33 },
        ];
        let remaining = annual;
        let prevLimit = 0;
        for (const b of brackets) {
          const taxable = Math.min(remaining, b.limit - prevLimit);
          if (taxable <= 0) break;
          tax += taxable * b.rate;
          remaining -= taxable;
          prevLimit = b.limit;
        }
        tax += annual * 0.05;
        return Math.round(tax * 100) / 100;
      }

      const currentTax = estimateTax(currentIncome);
      const newTax = estimateTax(newIncome);
      const currentMonthlyNet = (currentIncome - currentTax) / 12;
      const newMonthlyNet = (newIncome - newTax) / 12;
      const currentMonthlySavings = currentMonthlyNet * (currentSavingsRate / 100);
      const additionalMonthlyNet = newMonthlyNet - currentMonthlyNet;
      const newMonthlySavings = currentMonthlySavings + additionalMonthlyNet;
      const newSavingsRate = newMonthlyNet > 0 ? (newMonthlySavings / newMonthlyNet) * 100 : 0;

      return NextResponse.json({
        current: {
          annualIncome: currentIncome,
          annualTax: currentTax,
          monthlyNet: Math.round(currentMonthlyNet * 100) / 100,
          monthlySavings: Math.round(currentMonthlySavings * 100) / 100,
          savingsRate: currentSavingsRate,
        },
        new: {
          annualIncome: newIncome,
          annualTax: newTax,
          monthlyNet: Math.round(newMonthlyNet * 100) / 100,
          monthlySavings: Math.round(newMonthlySavings * 100) / 100,
          savingsRate: Math.round(newSavingsRate * 100) / 100,
        },
        difference: {
          annualIncome: newIncome - currentIncome,
          annualTax: Math.round((newTax - currentTax) * 100) / 100,
          monthlyNet: Math.round(additionalMonthlyNet * 100) / 100,
          monthlySavings: Math.round((newMonthlySavings - currentMonthlySavings) * 100) / 100,
        },
      });
    }

    return NextResponse.json({ error: "Unknown scenario type" }, { status: 400 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Scenario calculation failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
