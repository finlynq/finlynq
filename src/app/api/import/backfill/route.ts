import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, isNull } from "drizzle-orm";
import { generateImportHash } from "@/lib/import-hash";
import { requireAuth } from "@/lib/auth/require-auth";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const transactions = db
      .select()
      .from(schema.transactions)
      .where(and(isNull(schema.transactions.importHash), eq(schema.transactions.userId, userId)))
      .all();

    let updated = 0;
    const batchSize = 500;

    for (let i = 0; i < transactions.length; i += batchSize) {
      const batch = transactions.slice(i, i + batchSize);
      for (const tx of batch) {
        const hash = generateImportHash(
          tx.date,
          tx.accountId ?? 0,
          tx.amount,
          tx.payee ?? "",
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db.update(schema.transactions)
          .set({ importHash: hash } as any)
          .where(and(eq(schema.transactions.id, tx.id), eq(schema.transactions.userId, userId)))
          ;
        updated++;
      }
    }

    return NextResponse.json({ updated, total: transactions.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Backfill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
