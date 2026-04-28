import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { sql, and, eq } from "drizzle-orm";
import { suggestCategory } from "@/lib/auto-categorize";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const { transactions, categories } = schema;

// POST { payee } → suggested category
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  // Suggest tolerates a missing DEK — history match against encrypted
  // payees simply won't fire (returns null suggestion). Legacy plaintext
  // rows keep working via the passthrough in decryptField.
  const dek = sessionId ? getDEK(sessionId) : null;
  try {
    const body = await req.json();

    const suggestSchema = z.object({
      payee: z.string().min(1, "Payee is required"),
    });
    const parsed = validateBody(body, suggestSchema);
    if (parsed.error) return parsed.error;

    const { payee } = parsed.data;

    // Get existing transactions with their payee and categoryId. Payee may be
    // encrypted — match against the decrypted plaintext in memory.
    const existing = await db
      .select({
        payee: transactions.payee,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          sql`${transactions.payee} IS NOT NULL AND ${transactions.payee} != '' AND ${transactions.categoryId} IS NOT NULL`
        )
      )
      .all();

    const decrypted = existing.map((r) => ({
      payee: dek ? tryDecryptField(dek, r.payee, "transactions.payee") : r.payee,
      categoryId: r.categoryId,
    }));

    const suggestedCategoryId = suggestCategory(payee, decrypted);

    if (!suggestedCategoryId) {
      return NextResponse.json({ suggestion: null });
    }

    // Get category details
    const category = await db
      .select({
        id: categories.id,
        name: categories.name,
        type: categories.type,
        group: categories.group,
      })
      .from(categories)
      .where(and(eq(categories.id, suggestedCategoryId), eq(categories.userId, userId)))
      .get();

    return NextResponse.json({ suggestion: category ?? null });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to suggest category");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
