import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, isNull } from "drizzle-orm";
import { generateImportHash } from "@/lib/import-hash";
import { requireUnlock } from "@/lib/require-unlock";

export async function POST() {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const transactions = db
      .select()
      .from(schema.transactions)
      .where(isNull(schema.transactions.importHash))
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
        db.update(schema.transactions)
          .set({ importHash: hash })
          .where(eq(schema.transactions.id, tx.id))
          .run();
        updated++;
      }
    }

    return NextResponse.json({ updated, total: transactions.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Backfill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
