import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { detectRecurringTransactions } from "@/lib/recurring-detector";
import { dismissedLookups, withoutDismissed } from "@/lib/subscriptions/dismissals";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows, decryptTxRows, encryptOptional, decryptOptional } from "@/lib/crypto/encrypted-columns";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { frequencyOrMonthly, isValidIsoDate, normalizeFrequency, SUBSCRIPTION_FREQUENCIES } from "@/lib/subscriptions/schedule";
import { advanceStaleSubscriptionDatesSafe } from "@/lib/subscriptions/advance-next-dates";
import { todayISO } from "@/lib/utils/date";
import { pgErrorConstraint } from "@/lib/db-utils";

// The Subscriptions page (list + calendar, merged 2026-10) is a regular,
// non-dev-mode feature on web AND mobile, so none of these handlers are
// dev-mode gated any more.

const STATUSES = ["active", "paused", "cancelled"] as const;
const FREQUENCY_ERROR = `frequency must be one of: ${SUBSCRIPTION_FREQUENCIES.join(", ")}`;

// Optional, clearable date: "" and null both mean "no date".
const optionalDate = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v == null || v.trim() === "" ? (v === undefined ? undefined : null) : v.trim()))
  .refine((v) => v == null || isValidIsoDate(v), { message: "Dates must be YYYY-MM-DD" });

// A subscription amount is a cost and is stored positive (the convention MCP
// and the detector already follow); a signed input is accepted and normalized.
const nonZeroAmount = z
  .number()
  .refine((n) => Number.isFinite(n) && n !== 0, { message: "Amount must not be zero" })
  .transform((n) => Math.abs(n));

const optionalFk = z.union([z.number().int().positive(), z.null()]).optional();
const optionalFrequency = z
  .string()
  .optional()
  .refine((v) => v === undefined || normalizeFrequency(v) !== null, { message: FREQUENCY_ERROR })
  .transform((v) => (v === undefined ? undefined : normalizeFrequency(v)!));

// The web form sends `null` for every empty optional field; the old schema
// declared them `.optional()` only, which rejects null — so a subscription with
// no category, account, date or notes could not be created at all.
const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  amount: nonZeroAmount,
  currency: z.string().nullable().optional(),
  frequency: optionalFrequency,
  categoryId: optionalFk,
  accountId: optionalFk,
  nextDate: optionalDate,
  status: z.enum(STATUSES).optional(),
  cancelReminderDate: optionalDate,
  notes: z.string().nullable().optional(),
});

// Explicit field list. This was `.passthrough()` and the whole body was spread
// into the UPDATE's SET clause, so any column — `user_id` included — could be
// rewritten by a PUT. Unknown keys are now stripped.
const putSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).optional(),
  amount: nonZeroAmount.optional(),
  currency: z.string().trim().min(3).optional(),
  frequency: optionalFrequency,
  categoryId: optionalFk,
  accountId: optionalFk,
  nextDate: optionalDate,
  status: z.enum(STATUSES).optional(),
  cancelReminderDate: optionalDate,
  notes: z.string().nullable().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  // A next-payment date that has passed is rolled forward to the next
  // occurrence before reading, so the page, the Action Center and the weekly
  // recap all see a current date (lib/subscriptions/advance-next-dates.ts).
  await advanceStaleSubscriptionDatesSafe(db, userId);

  // Stream D Phase 4 — plaintext name/categoryName/accountName dropped.
  const rawSubs = await db
    .select({
      id: schema.subscriptions.id,
      nameCt: schema.subscriptions.nameCt,
      amount: schema.subscriptions.amount,
      currency: schema.subscriptions.currency,
      frequency: schema.subscriptions.frequency,
      categoryId: schema.subscriptions.categoryId,
      categoryNameCt: schema.categories.nameCt,
      accountId: schema.subscriptions.accountId,
      accountNameCt: schema.accounts.nameCt,
      nextDate: schema.subscriptions.nextDate,
      status: schema.subscriptions.status,
      cancelReminderDate: schema.subscriptions.cancelReminderDate,
      notes: schema.subscriptions.notes,
    })
    .from(schema.subscriptions)
    .leftJoin(schema.categories, eq(schema.subscriptions.categoryId, schema.categories.id))
    .leftJoin(schema.accounts, eq(schema.subscriptions.accountId, schema.accounts.id))
    .where(eq(schema.subscriptions.userId, userId))
    .orderBy(schema.subscriptions.status)
    .all();

  // Stream D: decrypt joined name columns. Sort then happens in memory by
  // (status, name) since `ORDER BY name` on the SQL side won't sort encrypted
  // rows correctly.
  const decrypted = (decryptNamedRows(rawSubs, auth.context.dek, {
    nameCt: "name",
    categoryNameCt: "categoryName",
    accountNameCt: "accountName",
  }) as Array<typeof rawSubs[number] & { name: string | null; categoryName: string | null; accountName: string | null }>)
    // Free-text `notes` is user-DEK encrypted at rest (2026-06-01).
    .map((r) => ({ ...r, notes: decryptOptional(auth.context.dek, r.notes) }));
  const subs = decrypted.sort((a, b) => {
    const s = (a.status ?? "").localeCompare(b.status ?? "");
    if (s !== 0) return s;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });

  // FINLYNQ-123 — a subscription's cost is a point-in-time figure, so its
  // display-currency equivalent converts at the CURRENT rate. Native `amount`
  // and `currency` are left untouched; these two fields are purely additive so
  // the page can total mixed-currency subscriptions under one honest label
  // instead of raw-summing them (feedback #7).
  const displayCurrency = await getDisplayCurrency(userId, request.nextUrl.searchParams.get("currency"));
  const rateMap = await getRateMap(displayCurrency, userId);
  const withDisplay = subs.map((s) => ({
    ...s,
    // Canonical cadence on the way out ("yearly" written by MCP reads as
    // "annual"), so every client prices and schedules it the same way.
    frequency: frequencyOrMonthly(s.frequency),
    displayCurrency,
    displayAmount: convertWithRateMap(s.amount, s.currency ?? displayCurrency, rateMap),
  }));

  return NextResponse.json(withDisplay);
}

export async function POST(request: NextRequest) {
  // requireEncryption, not requireAuth: buildNameFields(null) returns {} and
  // encryptOptional(null, note) stores the note as PLAINTEXT — a DEK-less
  // write persisted a permanently nameless row (review 2026-07-30 #7).
  const auth = await requireEncryption(request); if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();

    // Auto-detect subscriptions from recurring transactions
    if (body.action === "detect") {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 25);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const rawTxns = await db
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
          payee: schema.transactions.payee,
          amount: schema.transactions.amount,
          currency: schema.transactions.currency,
          accountId: schema.transactions.accountId,
          categoryId: schema.transactions.categoryId,
        })
        .from(schema.transactions)
        .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
        .where(and(
          eq(schema.transactions.userId, userId),
          sql`${schema.transactions.date} >= ${cutoffStr} AND ${schema.transactions.payee} != ''`,
          // Transfer / trade / swap legs and Reconciliation-type ('R', e.g. the
          // canonical "Transfer") categories are never subscriptions.
          sql`${schema.transactions.linkId} IS NULL AND ${schema.transactions.tradeLinkId} IS NULL AND ${schema.transactions.swapLinkId} IS NULL`,
          sql`(${schema.categories.type} IS NULL OR ${schema.categories.type} <> 'R')`,
        ))
        .all();
      // Payee is encrypted at rest — decrypt before running the recurring
      // detector (which needs plaintext to group by payee).
      const txns = decryptTxRows(dek, rawTxns);

      const detected = detectRecurringTransactions(
        txns.map((t) => ({
          ...t,
          payee: t.payee ?? "",
          accountId: t.accountId ?? 0,
          categoryId: t.categoryId,
        })),
        { asOf: todayISO() },
      );

      // Filter to likely subscriptions (recurring expenses), leaving out the
      // payees the user marked "Not a subscription" (GH #428).
      const dismissed = await dismissedLookups(userId);
      const suggestions = withoutDismissed(detected, (r) => r.payee, dismissed, dek)
        .filter((r) => r.avgAmount < 0)
        .map((r) => ({
          name: r.payee,
          amount: Math.abs(r.avgAmount),
          // Carry the source transactions' native currency through to the
          // suggestion. Dropping it here is what silently stamped every
          // auto-detected subscription 'CAD' (feedback #7).
          currency: r.currency,
          // Every detector cadence now maps 1:1 onto a subscription cadence
          // (biweekly used to be approximated as monthly, and "yearly" was
          // passed through and then costed as monthly).
          frequency: frequencyOrMonthly(r.frequency),
          nextDate: r.nextDate,
          accountId: r.accountId,
          categoryId: r.categoryId,
          count: r.count,
          lastDate: r.lastDate,
        }));

      return NextResponse.json({ suggestions });
    }

    // Normal create
    const parsed = validateBody(body, createSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    // Cross-tenant FK guard (H-1) — both categoryId and accountId arrive
    // from the client body. Verify before INSERT.
    await verifyOwnership(userId, {
      categoryIds: d.categoryId != null ? [d.categoryId] : undefined,
      accountIds: d.accountId != null ? [d.accountId] : undefined,
    });
    // Currency resolution (feedback #7). A hardcoded "CAD" fallback stamped
    // every subscription created without an explicit currency — including
    // every auto-detected one — with a currency the user may not even hold.
    // Order: explicit > owning account's currency > the user's display currency.
    let currency = d.currency?.trim().toUpperCase() || null;
    if (!currency && d.accountId != null) {
      const acct = await db
        .select({ currency: schema.accounts.currency })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, d.accountId), eq(schema.accounts.userId, userId)))
        .get();
      currency = acct?.currency ?? null;
    }
    if (!currency) currency = await getDisplayCurrency(userId);

    const enc = buildNameFields(dek, { name: d.name });
    // Stream D Phase 4 — plaintext name dropped.
    const sub = await db
      .insert(schema.subscriptions)
      .values({
        userId,
        amount: d.amount,
        currency,
        frequency: d.frequency ?? "monthly",
        categoryId: d.categoryId ?? null,
        accountId: d.accountId ?? null,
        nextDate: d.nextDate ?? null,
        status: d.status ?? "active",
        cancelReminderDate: d.cancelReminderDate ?? null,
        notes: encryptOptional(dek, d.notes || null),
        ...enc,
      })
      .returning()
      .get();

    return NextResponse.json(sub, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // name_lookup is unique per user — a second "Netflix" is a 409, not a 500.
    if (pgErrorConstraint(error) === "subscriptions_user_name_lookup_uniq") {
      return NextResponse.json({ error: "A subscription with that name already exists" }, { status: 409 });
    }
    await logApiError("POST", "/api/subscriptions", error, userId);
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
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, name, notes, currency, ...rest } = parsed.data;

    // Cross-tenant FK guard (H-1) — `categoryId` and `accountId` may be
    // re-pointed by an UPDATE.
    const refs: { categoryIds?: number[]; accountIds?: number[] } = {};
    if (rest.categoryId != null) refs.categoryIds = [rest.categoryId];
    if (rest.accountId != null) refs.accountIds = [rest.accountId];
    if (refs.categoryIds || refs.accountIds) await verifyOwnership(userId, refs);

    const set: Partial<typeof schema.subscriptions.$inferInsert> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) (set as Record<string, unknown>)[k] = v;
    }
    if (currency !== undefined) set.currency = currency.toUpperCase();
    // Free-text `notes` is user-DEK encrypted at rest (2026-06-01).
    if (notes !== undefined) set.notes = encryptOptional(dek, notes || null);
    // Stream D Phase 4 — plaintext name dropped; rename writes name_ct/lookup.
    const enc = name !== undefined ? buildNameFields(dek, { name }) : {};

    if (Object.keys(set).length === 0 && Object.keys(enc).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const sub = await db
      .update(schema.subscriptions)
      .set({ ...set, ...enc })
      .where(and(eq(schema.subscriptions.id, id), eq(schema.subscriptions.userId, userId)))
      .returning()
      .get();
    if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(sub);
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (pgErrorConstraint(error) === "subscriptions_user_name_lookup_uniq") {
      return NextResponse.json({ error: "A subscription with that name already exists" }, { status: 409 });
    }
    await logApiError("PUT", "/api/subscriptions", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(schema.subscriptions).where(and(eq(schema.subscriptions.id, id), eq(schema.subscriptions.userId, auth.context.userId)));
  return NextResponse.json({ success: true });
}
