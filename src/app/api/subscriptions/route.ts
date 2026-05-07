import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
import { detectRecurringTransactions } from "@/lib/recurring-detector";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireDevMode } from "@/lib/require-dev-mode";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows, decryptTxRows } from "@/lib/crypto/encrypted-columns";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";

const createSchema = z.object({
  name: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  frequency: z.string().optional(),
  categoryId: z.number().optional(),
  accountId: z.number().optional(),
  nextDate: z.string().optional(),
  status: z.string().optional(),
  cancelReminderDate: z.string().optional(),
  notes: z.string().optional(),
});

const putSchema = z.object({
  id: z.number(),
}).passthrough();

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const { userId } = auth.context;
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
  const decrypted = decryptNamedRows(rawSubs, auth.context.dek, {
    nameCt: "name",
    categoryNameCt: "categoryName",
    accountNameCt: "accountName",
  }) as Array<typeof rawSubs[number] & { name: string | null; categoryName: string | null; accountName: string | null }>;
  const subs = decrypted.sort((a, b) => {
    const s = (a.status ?? "").localeCompare(b.status ?? "");
    if (s !== 0) return s;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });

  return NextResponse.json(subs);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const { userId } = auth.context;
  try {
    const body = await request.json();

    // Auto-detect subscriptions from recurring transactions
    if (body.action === "detect") {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffStr = cutoff.toISOString().split("T")[0];

      const rawTxns = await db
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
          payee: schema.transactions.payee,
          amount: schema.transactions.amount,
          accountId: schema.transactions.accountId,
          categoryId: schema.transactions.categoryId,
        })
        .from(schema.transactions)
        .where(and(
          eq(schema.transactions.userId, userId),
          sql`${schema.transactions.date} >= ${cutoffStr} AND ${schema.transactions.payee} != ''`
        ))
        .all();
      // Payee is encrypted at rest — decrypt before running the recurring
      // detector (which needs plaintext to group by payee).
      const txns = decryptTxRows(auth.context.dek, rawTxns);

      const detected = detectRecurringTransactions(
        txns.map((t) => ({
          ...t,
          payee: t.payee ?? "",
          accountId: t.accountId ?? 0,
          categoryId: t.categoryId,
        }))
      );

      // Filter to likely subscriptions (recurring expenses)
      const suggestions = detected
        .filter((r) => r.avgAmount < 0)
        .map((r) => {
          // Map detector frequencies to subscription frequencies
          let frequency = r.frequency as string;
          if (frequency === "biweekly") frequency = "monthly"; // approximate

          return {
            name: r.payee,
            amount: Math.abs(r.avgAmount),
            frequency,
            nextDate: r.nextDate,
            accountId: r.accountId,
            categoryId: r.categoryId,
            count: r.count,
            lastDate: r.lastDate,
          };
        });

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
    const enc = buildNameFields(auth.context.dek, { name: d.name });
    // Stream D Phase 4 — plaintext name dropped.
    const sub = await db
      .insert(schema.subscriptions)
      .values({
        userId,
        amount: d.amount,
        currency: d.currency ?? "CAD",
        frequency: d.frequency ?? "monthly",
        categoryId: d.categoryId || null,
        accountId: d.accountId || null,
        nextDate: d.nextDate || null,
        status: d.status ?? "active",
        cancelReminderDate: d.cancelReminderDate || null,
        notes: d.notes || null,
        ...enc,
      })
      .returning()
      .get();

    return NextResponse.json(sub, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await logApiError("POST", "/api/subscriptions", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...rawData } = parsed.data;
    // Stream D Phase 4 — plaintext name dropped. Strip name from update set.
    const rawName = (rawData as Record<string, unknown>).name;
    const data = { ...rawData };
    delete (data as Record<string, unknown>).name;
    // Cross-tenant FK guard (H-1) — `categoryId` and `accountId` may be
    // re-pointed by an UPDATE. Schema is `passthrough()` so we read from
    // `data` defensively. Numeric IDs only; non-numeric values are caller
    // bugs the existing handler already swallows.
    const updatedCategoryId = (data as Record<string, unknown>).categoryId;
    const updatedAccountId = (data as Record<string, unknown>).accountId;
    const refs: {
      categoryIds?: number[];
      accountIds?: number[];
    } = {};
    if (typeof updatedCategoryId === "number" && updatedCategoryId > 0) {
      refs.categoryIds = [updatedCategoryId];
    }
    if (typeof updatedAccountId === "number" && updatedAccountId > 0) {
      refs.accountIds = [updatedAccountId];
    }
    if (refs.categoryIds || refs.accountIds) {
      await verifyOwnership(auth.context.userId, refs);
    }
    const enc = typeof rawName === "string"
      ? buildNameFields(auth.context.dek, { name: rawName })
      : {};
    const sub = await db
      .update(schema.subscriptions)
      .set({ ...data, ...enc })
      .where(and(eq(schema.subscriptions.id, id), eq(schema.subscriptions.userId, auth.context.userId)))
      .returning()
      .get();
    return NextResponse.json(sub);
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await logApiError("PUT", "/api/subscriptions", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(schema.subscriptions).where(and(eq(schema.subscriptions.id, id), eq(schema.subscriptions.userId, auth.context.userId)));
  return NextResponse.json({ success: true });
}
