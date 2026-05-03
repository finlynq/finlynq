import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and } from "drizzle-orm";
import {
  generateAmortizationSchedule,
  calculateExtraPaymentImpact,
  calculateDebtPayoff,
} from "@/lib/loan-calculator";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireDevMode } from "@/lib/require-dev-mode";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows } from "@/lib/crypto/encrypted-columns";

const createLoanSchema = z.object({
  name: z.string(),
  type: z.string(),
  principal: z.number(),
  annualRate: z.number(),
  termMonths: z.number(),
  startDate: z.string(),
  currency: z.string().regex(/^[A-Z]{3,4}$/, "ISO currency code").optional(),
  accountId: z.number().optional(),
  paymentAmount: z.number().optional(),
  paymentFrequency: z.string().optional(),
  extraPayment: z.number().optional(),
  note: z.string().optional(),
});

const updateLoanSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: z.string().optional(),
  principal: z.number().optional(),
  annualRate: z.number().optional(),
  termMonths: z.number().optional(),
  startDate: z.string().optional(),
  currency: z.string().regex(/^[A-Z]{3,4}$/, "ISO currency code").optional(),
  accountId: z.number().optional().nullable(),
  paymentAmount: z.number().optional(),
  paymentFrequency: z.string().optional(),
  extraPayment: z.number().optional(),
  note: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const { userId } = auth.context;
  // Stream D Phase 4 — plaintext name/accountName dropped.
  const rawLoans = await db
    .select({
      id: schema.loans.id,
      nameCt: schema.loans.nameCt,
      type: schema.loans.type,
      accountId: schema.loans.accountId,
      accountNameCt: schema.accounts.nameCt,
      currency: schema.loans.currency,
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
    .where(eq(schema.loans.userId, userId))
    .all();
  const loans = decryptNamedRows(rawLoans, auth.context.dek, {
    nameCt: "name",
    accountNameCt: "accountName",
  });

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
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
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
    const parsed = validateBody(body, createLoanSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const enc = buildNameFields(auth.context.dek, { name: d.name });
    // Stream D Phase 4 — plaintext name dropped.
    const loan = await db.insert(schema.loans).values({
      userId: auth.context.userId,
      type: d.type,
      accountId: d.accountId || null,
      ...(d.currency ? { currency: d.currency.toUpperCase() } : {}),
      principal: d.principal,
      annualRate: d.annualRate,
      termMonths: d.termMonths,
      startDate: d.startDate,
      paymentAmount: d.paymentAmount,
      paymentFrequency: d.paymentFrequency ?? "monthly",
      extraPayment: d.extraPayment ?? 0,
      note: d.note ?? "",
      ...enc,
    }).returning().get();

    return NextResponse.json(loan, { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/loans", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  try {
    const body = await request.json();
    const parsed = validateBody(body, updateLoanSchema);
    if (parsed.error) return parsed.error;
    const { id, name, ...data } = parsed.data;
    const toEncrypt: Record<string, string | null | undefined> = {};
    if (name !== undefined) toEncrypt.name = name;
    const enc = buildNameFields(auth.context.dek, toEncrypt);
    if (data.currency) data.currency = data.currency.toUpperCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loan = await db.update(schema.loans).set({ ...data, ...enc } as any).where(and(eq(schema.loans.id, id), eq(schema.loans.userId, auth.context.userId))).returning().get();
    return NextResponse.json(loan);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/loans", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(schema.loans).where(and(eq(schema.loans.id, id), eq(schema.loans.userId, auth.context.userId)));
  return NextResponse.json({ success: true });
}
