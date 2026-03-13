import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import {
  generateAmortizationSchedule,
  calculateExtraPaymentImpact,
  calculateDebtPayoff,
} from "@/lib/loan-calculator";

export async function GET() {
  const loans = db
    .select({
      id: schema.loans.id,
      name: schema.loans.name,
      type: schema.loans.type,
      accountId: schema.loans.accountId,
      accountName: schema.accounts.name,
      principal: schema.loans.principal,
      annualRate: schema.loans.annualRate,
      termMonths: schema.loans.termMonths,
      startDate: schema.loans.startDate,
      paymentAmount: schema.loans.paymentAmount,
      paymentFrequency: schema.loans.paymentFrequency,
      extraPayment: schema.loans.extraPayment,
      note: schema.loans.note,
    })
    .from(schema.loans)
    .leftJoin(schema.accounts, eq(schema.loans.accountId, schema.accounts.id))
    .all();

  // Add amortization summary for each loan
  const withSummary = loans.map((loan) => {
    const summary = generateAmortizationSchedule(
      loan.principal,
      loan.annualRate,
      loan.termMonths,
      loan.startDate,
      loan.extraPayment ?? 0,
      loan.paymentFrequency
    );
    const paid = summary.schedule.filter(
      (r) => r.date <= new Date().toISOString().split("T")[0]
    );
    const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
    const interestPaid = paid.reduce((s, r) => s + r.interest, 0);
    return {
      ...loan,
      monthlyPayment: summary.monthlyPayment,
      totalInterest: summary.totalInterest,
      payoffDate: summary.payoffDate,
      remainingBalance: Math.max(loan.principal - principalPaid, 0),
      principalPaid: Math.round(principalPaid * 100) / 100,
      interestPaid: Math.round(interestPaid * 100) / 100,
      periodsRemaining: summary.schedule.length - paid.length,
    };
  });

  return NextResponse.json(withSummary);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.action === "amortization") {
      const result = generateAmortizationSchedule(
        body.principal, body.annualRate, body.termMonths,
        body.startDate, body.extraPayment ?? 0, body.paymentFrequency ?? "monthly"
      );
      return NextResponse.json(result);
    }

    if (body.action === "what-if") {
      const result = calculateExtraPaymentImpact(
        body.principal, body.annualRate, body.termMonths,
        body.startDate, body.extraAmounts ?? [100, 200, 500, 1000]
      );
      return NextResponse.json(result);
    }

    if (body.action === "debt-payoff") {
      const avalanche = calculateDebtPayoff(body.debts, body.extraBudget ?? 0, "avalanche");
      const snowball = calculateDebtPayoff(body.debts, body.extraBudget ?? 0, "snowball");
      return NextResponse.json({ avalanche, snowball });
    }

    // Create new loan
    const loan = db.insert(schema.loans).values({
      name: body.name,
      type: body.type,
      accountId: body.accountId || null,
      principal: body.principal,
      annualRate: body.annualRate,
      termMonths: body.termMonths,
      startDate: body.startDate,
      paymentAmount: body.paymentAmount,
      paymentFrequency: body.paymentFrequency ?? "monthly",
      extraPayment: body.extraPayment ?? 0,
      note: body.note ?? "",
    }).returning().get();

    return NextResponse.json(loan, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  db.delete(schema.loans).where(eq(schema.loans.id, id)).run();
  return NextResponse.json({ success: true });
}
