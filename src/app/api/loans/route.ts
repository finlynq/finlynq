import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  buildLoanSchedule,
  calculateExtraPaymentImpact,
  calculateDebtPayoff,
  LoanValidationError,
  PAYMENT_FREQUENCIES,
  INTEREST_METHODS,
  loanScheduleExtras,
} from "@/lib/loan-calculator";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows, encryptOptional, decryptOptional } from "@/lib/crypto/encrypted-columns";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";
import { todayISO } from "@/lib/utils/date";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { pickRecordCurrency } from "@/lib/fx/record-currency";
import { loanAccountRefusal } from "@/lib/loans/linked-account";
// Issue #213 — shared YYYY-MM-DD validator (regex + leap-year/Feb-30 round-trip).
import { ymdDate, parseYmdSafe } from "../../../../mcp-server/lib/date-validators";

const paymentFrequencyEnum = z.enum(PAYMENT_FREQUENCIES);
const interestMethodEnum = z.enum(INTEREST_METHODS);

const createLoanSchema = z.object({
  name: z.string(),
  type: z.string(),
  principal: z.number().positive(),
  annualRate: z.number().nonnegative(),
  // FINLYNQ-136: term OR payment — payment-driven loans solve for the term.
  termMonths: z.number().int().positive().nullable().optional(),
  startDate: ymdDate,
  currency: z.string().regex(/^[A-Z]{3,4}$/, "ISO currency code").optional(),
  accountId: z.number().nullable().optional(),
  paymentAmount: z.number().positive().nullable().optional(),
  paymentFrequency: paymentFrequencyEnum.optional(),
  extraPayment: z.number().nonnegative().optional(),
  residualValue: z.number().nonnegative().nullable().optional(),
  // rate (default) | flat (interestAmount each payment) | total (interestAmount over the loan)
  interestMethod: interestMethodEnum.optional(),
  interestAmount: z.number().nonnegative().nullable().optional(),
  note: z.string().optional(),
}).refine((d) => d.termMonths != null || d.paymentAmount != null, {
  message: "Either termMonths or paymentAmount is required",
});

const updateLoanSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: z.string().optional(),
  principal: z.number().positive().optional(),
  annualRate: z.number().nonnegative().optional(),
  termMonths: z.number().int().positive().nullable().optional(),
  startDate: ymdDate.optional(),
  currency: z.string().regex(/^[A-Z]{3,4}$/, "ISO currency code").optional(),
  accountId: z.number().optional().nullable(),
  paymentAmount: z.number().positive().nullable().optional(),
  paymentFrequency: paymentFrequencyEnum.optional(),
  extraPayment: z.number().nonnegative().optional(),
  residualValue: z.number().nonnegative().nullable().optional(),
  // rate (default) | flat (interestAmount each payment) | total (interestAmount over the loan)
  interestMethod: interestMethodEnum.optional(),
  interestAmount: z.number().nonnegative().nullable().optional(),
  note: z.string().optional(),
});

// FINLYNQ-136: outstanding balance per linked account = SUM(transactions.amount)
// (same definition as getAccountBalances). txCount distinguishes "no ledger
// activity yet" (fall back to projection) from a genuinely zero balance.
async function getLinkedAccountBalances(userId: string, accountIds: number[]) {
  const map = new Map<number, { balance: number; txCount: number }>();
  if (!accountIds.length) return map;
  const rows = await db
    .select({
      accountId: schema.transactions.accountId,
      balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      txCount: sql<number>`COUNT(*)`,
    })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.userId, userId), inArray(schema.transactions.accountId, accountIds)))
    .groupBy(schema.transactions.accountId)
    .all();
  for (const r of rows) {
    if (r.accountId != null) map.set(r.accountId, { balance: Number(r.balance), txCount: Number(r.txCount) });
  }
  return map;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
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
      residualValue: schema.loans.residualValue,
      note: schema.loans.note,
      manualSchedule: schema.loans.manualSchedule,
      interestOverrides: schema.loans.interestOverrides,
      interestMethod: schema.loans.interestMethod,
      interestAmount: schema.loans.interestAmount,
    })
    .from(schema.loans)
    .leftJoin(schema.accounts, eq(schema.loans.accountId, schema.accounts.id))
    .where(eq(schema.loans.userId, userId))
    .all();
  const loans = decryptNamedRows(rawLoans, auth.context.dek, {
    nameCt: "name",
    accountNameCt: "accountName",
  }).map((l) => ({
    ...l,
    // Free-text note is user-DEK encrypted at rest (2026-06-01).
    note: decryptOptional(auth.context.dek, l.note),
  }));

  // FINLYNQ-136: account-linked balances — one query for all linked accounts.
  const linkedIds = [...new Set(loans.map((l) => l.accountId).filter((x): x is number => x != null))];
  const acctBalances = await getLinkedAccountBalances(userId, linkedIds);
  const today = todayISO();

  // FINLYNQ-123 dual basis: every amount below stays in the LOAN's own
  // currency (that's what the schedule was computed in), and each row also
  // carries a current-rate conversion into the display currency so the page
  // can total across a mixed-currency book. Summing the native figures under
  // one label — which is what the page used to do — reports an ₽8.1M mortgage
  // as $8.1M.
  const displayCurrency = await getDisplayCurrency(
    userId,
    request.nextUrl.searchParams.get("currency"),
  );
  const rateMap = await getRateMap(displayCurrency, userId);
  const toDisplay = (amount: number | null, from: string | null) =>
    amount == null ? null : convertWithRateMap(amount, from ?? displayCurrency, rateMap);

  // Add amortization summary for each loan
  const withSummary = loans.map((rawLoan) => {
    // The stored schedule rows feed the calculator but are NOT part of the
    // list response (a 30-year manual schedule is 360 rows per loan); the
    // schedule panel fetches them from /api/loans/schedule.
    const { manualSchedule: _manual, interestOverrides: _overrides, ...loan } = rawLoan;
    void _manual;
    void _overrides;
    const extras = loanScheduleExtras(rawLoan);
    const integrityRow = (error: string, value: unknown) => ({
      ...loan,
      monthlyPayment: null,
      totalInterest: null,
      payoffDate: null,
      remainingBalance: null,
      principalPaid: null,
      interestPaid: null,
      periodsRemaining: null,
      balanceSource: null,
      displayCurrency,
      remainingBalanceDisplay: null,
      monthlyEquivalentPaymentDisplay: null,
      totalInterestDisplay: null,
      dataIntegrity: { error, value },
    });
    // Issue #213 — guard against legacy bad start_date so the whole list
    // doesn't crash with `Invalid time value`. Same pattern as MCP HTTP
    // `list_loans` / `get_loan_amortization` / `get_debt_payoff_plan`.
    if (parseYmdSafe(loan.startDate) === null) {
      return integrityRow("invalid start_date", loan.startDate);
    }
    let summary;
    try {
      summary = buildLoanSchedule({
        principal: loan.principal,
        annualRate: loan.annualRate,
        termMonths: loan.termMonths,
        startDate: loan.startDate,
        paymentAmount: loan.paymentAmount,
        paymentFrequency: loan.paymentFrequency,
        extraPayment: loan.extraPayment ?? 0,
        residualValue: loan.residualValue,
        ...extras,
      });
    } catch (e) {
      // A legacy row whose payment no longer amortizes shouldn't poison the list.
      if (e instanceof LoanValidationError) return integrityRow(e.message, null);
      throw e;
    }
    const paid = summary.schedule.filter((r) => r.date <= today);
    const principalPaid = paid.reduce((s, r) => s + r.principal, 0);
    const interestPaid = paid.reduce((s, r) => s + r.interest, 0);

    // Projection-derived fallback values.
    let remainingBalance = Math.max(loan.principal - principalPaid, 0);
    let balanceSource: "account" | "projection" = "projection";
    let payoffDate = summary.payoffDate;
    let periodsRemaining = summary.schedule.length - paid.length;

    // FINLYNQ-136: when a linked account has ledger activity, its balance is
    // the source of truth (|sum| — liability accounts carry negative balances)
    // and the payoff projection is re-anchored to it from today.
    const acct = loan.accountId != null ? acctBalances.get(loan.accountId) : undefined;
    if (acct && acct.txCount > 0) {
      remainingBalance = Math.round(Math.abs(acct.balance) * 100) / 100;
      balanceSource = "account";
      const residual = loan.residualValue ?? 0;
      if (remainingBalance <= residual + 0.01) {
        payoffDate = today;
        periodsRemaining = 0;
      } else if (summary.scheduleMode === "manual") {
        // The user supplied the dates themselves; re-projecting from today's
        // balance with a calculated payment would overwrite them.
      } else {
        try {
          const anchored = buildLoanSchedule({
            principal: remainingBalance,
            annualRate: loan.annualRate,
            startDate: today,
            paymentAmount: loan.paymentAmount ?? summary.paymentPerPeriod,
            paymentFrequency: loan.paymentFrequency,
            extraPayment: loan.extraPayment ?? 0,
            residualValue: loan.residualValue,
          });
          payoffDate = anchored.payoffDate;
          periodsRemaining = anchored.schedule.length;
        } catch {
          // Payment doesn't amortize the actual balance — keep projection dates.
        }
      }
    }

    return {
      ...loan,
      monthlyPayment: summary.monthlyPayment,
      paymentPerPeriod: summary.paymentPerPeriod,
      monthlyEquivalentPayment: summary.monthlyEquivalentPayment,
      totalInterest: summary.totalInterest,
      payoffDate,
      remainingBalance,
      balanceSource,
      principalPaid:
        balanceSource === "account"
          ? Math.round(Math.max(loan.principal - remainingBalance, 0) * 100) / 100
          : Math.round(principalPaid * 100) / 100,
      interestPaid: Math.round(interestPaid * 100) / 100,
      periodsRemaining,
      scheduleMode: summary.scheduleMode,
      effectiveAnnualRate: summary.effectiveAnnualRate,
      interestOverrideCount: Object.keys(extras.interestOverrides ?? {}).length,
      // Additive reporting-currency companions — the native fields above are
      // untouched, so nothing that already read this response changes.
      displayCurrency,
      remainingBalanceDisplay: toDisplay(remainingBalance, loan.currency),
      monthlyEquivalentPaymentDisplay: toDisplay(
        summary.monthlyEquivalentPayment,
        loan.currency,
      ),
      // Sorts the Loans list's Interest column across currencies.
      totalInterestDisplay: toDisplay(summary.totalInterest, loan.currency),
    };
  });

  return NextResponse.json(withSummary);
}

export async function POST(request: NextRequest) {
  // requireEncryption, not requireAuth: buildNameFields(null) returns {} and
  // encryptOptional(null, note) stores the note as PLAINTEXT — a DEK-less
  // write persisted a permanently nameless row (review 2026-07-30 #7).
  const auth = await requireEncryption(request); if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();

    if (body.action === "amortization") {
      // FINLYNQ-136: honors paymentAmount (payment-driven) + residualValue
      // (lease) and returns the per-calendar-month interest accrual.
      // With `loanId`, the loan's own manual schedule / interest overrides are
      // applied, so the panel shows what every other surface computes.
      let extras = {};
      const loanId = Number(body.loanId);
      if (Number.isInteger(loanId) && loanId > 0) {
        const stored = await db
          .select({
            manualSchedule: schema.loans.manualSchedule,
            interestOverrides: schema.loans.interestOverrides,
            interestMethod: schema.loans.interestMethod,
            interestAmount: schema.loans.interestAmount,
          })
          .from(schema.loans)
          .where(and(eq(schema.loans.id, loanId), eq(schema.loans.userId, userId)))
          .get();
        if (stored) extras = loanScheduleExtras(stored);
      }
      const result = buildLoanSchedule({
        ...extras,
        // A caller trying out a method before saving states it explicitly.
        ...(body.interestMethod
          ? { interestMethod: body.interestMethod, interestAmount: body.interestAmount }
          : {}),
        principal: body.principal,
        annualRate: body.annualRate,
        termMonths: body.termMonths,
        startDate: body.startDate,
        paymentAmount: body.paymentAmount,
        paymentFrequency: body.paymentFrequency ?? "monthly",
        extraPayment: body.extraPayment ?? 0,
        residualValue: body.residualValue,
      });
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
    // Cross-tenant FK guard (H-1) — verify the optional accountId belongs
    // to the caller before INSERT. `null`/undefined skipped by the helper.
    if (d.accountId != null) {
      await verifyOwnership(userId, { accountIds: [d.accountId] });
    }
    // Interest is booked on the linked account, and its balance becomes the
    // loan's: an investment account can do neither.
    const accountRefusal = await loanAccountRefusal(db, userId, d.accountId);
    if (accountRefusal) return NextResponse.json({ error: accountRefusal }, { status: 400 });
    // FINLYNQ-136: reject non-amortizing inputs (payment below first period's
    // interest, residual >= principal) at create time with a clear 400.
    buildLoanSchedule({
      principal: d.principal,
      annualRate: d.annualRate,
      termMonths: d.termMonths,
      startDate: d.startDate,
      paymentAmount: d.paymentAmount,
      paymentFrequency: d.paymentFrequency ?? "monthly",
      extraPayment: d.extraPayment ?? 0,
      residualValue: d.residualValue,
      interestMethod: d.interestMethod,
      interestAmount: d.interestAmount,
    });
    // Currency resolution (feedback #7): explicit > linked account > display.
    // Falling through to the column default is what let MCP-created loans land
    // as CAD; the web form always sends one, but the REST API is public.
    let accountCurrency: string | null = null;
    if (d.accountId != null) {
      const acct = await db
        .select({ currency: schema.accounts.currency })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, d.accountId), eq(schema.accounts.userId, userId)))
        .get();
      accountCurrency = acct?.currency ?? null;
    }
    const currency = pickRecordCurrency({
      explicit: d.currency,
      accountCurrency,
      displayCurrency: await getDisplayCurrency(userId),
    });
    const enc = buildNameFields(dek, { name: d.name });
    // Stream D Phase 4 — plaintext name dropped.
    const loan = await db.insert(schema.loans).values({
      userId,
      type: d.type,
      accountId: d.accountId || null,
      currency,
      principal: d.principal,
      annualRate: d.annualRate,
      termMonths: d.termMonths ?? null,
      startDate: d.startDate,
      paymentAmount: d.paymentAmount,
      paymentFrequency: d.paymentFrequency ?? "monthly",
      extraPayment: d.extraPayment ?? 0,
      residualValue: d.residualValue ?? null,
      interestMethod: d.interestMethod ?? "rate",
      interestAmount: d.interestMethod && d.interestMethod !== "rate" ? d.interestAmount ?? null : null,
      note: encryptOptional(dek, d.note) ?? "",
      ...enc,
    }).returning().get();

    return NextResponse.json(loan, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (error instanceof LoanValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    await logApiError("POST", "/api/loans", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  // requireEncryption — with a null DEK the rename silently no-ops and the note
  // lands in plaintext (review 2026-07-30 #7).
  const auth = await requireEncryption(request); if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();
    const parsed = validateBody(body, updateLoanSchema);
    if (parsed.error) return parsed.error;
    const { id, name, ...data } = parsed.data;
    // Cross-tenant FK guard (H-1) — `accountId` may be re-pointed to another
    // user's account on update. `null` is an explicit unlink; skip it.
    if (data.accountId != null && data.accountId > 0) {
      await verifyOwnership(userId, { accountIds: [data.accountId] });
    }
    // FINLYNQ-136: validate the MERGED row still amortizes (e.g. lowering the
    // payment below the period interest, or raising residual past principal).
    const existing = await db
      .select()
      .from(schema.loans)
      .where(and(eq(schema.loans.id, id), eq(schema.loans.userId, userId)))
      .all();
    if (!existing.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Only a NEW link is checked, so a loan already on such an account stays editable.
    const accountRefusal = await loanAccountRefusal(db, userId, data.accountId, existing[0].accountId);
    if (accountRefusal) return NextResponse.json({ error: accountRefusal }, { status: 400 });
    const merged = { ...existing[0], ...data };
    if (parseYmdSafe(merged.startDate) !== null) {
      buildLoanSchedule({
        principal: merged.principal,
        annualRate: merged.annualRate,
        termMonths: merged.termMonths,
        startDate: merged.startDate,
        paymentAmount: merged.paymentAmount,
        paymentFrequency: merged.paymentFrequency,
        extraPayment: merged.extraPayment ?? 0,
        residualValue: merged.residualValue,
        ...loanScheduleExtras(existing[0]),
        // After the stored extras: this request may be changing the method.
        interestMethod: merged.interestMethod,
        interestAmount: merged.interestAmount,
      });
    }
    const toEncrypt: Record<string, string | null | undefined> = {};
    if (name !== undefined) toEncrypt.name = name;
    const enc = buildNameFields(dek, toEncrypt);
    if (data.currency) data.currency = data.currency.toUpperCase();
    const updatePayload: Record<string, unknown> = { ...data, ...enc };
    // Encrypt the free-text note when present (2026-06-01 plaintext-gap closure).
    if (data.note !== undefined) {
      updatePayload.note = encryptOptional(dek, data.note);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loan = await db.update(schema.loans).set(updatePayload as any).where(and(eq(schema.loans.id, id), eq(schema.loans.userId, userId))).returning().get();
    return NextResponse.json(loan);
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (error instanceof LoanValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    await logApiError("PUT", "/api/loans", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(schema.loans).where(and(eq(schema.loans.id, id), eq(schema.loans.userId, auth.context.userId)));
  return NextResponse.json({ success: true });
}
