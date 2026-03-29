import { NextResponse } from "next/server";
import { db, schema } from "@/db";
import { requireUnlock } from "@/lib/require-unlock";
import { safeErrorMessage } from "@/lib/validate";

export async function DELETE() {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    // Delete in order respecting foreign key constraints
    db.delete(schema.notifications).run();
    db.delete(schema.subscriptions).run();
    db.delete(schema.recurringTransactions).run();
    db.delete(schema.contributionRoom).run();
    db.delete(schema.priceCache).run();
    db.delete(schema.fxRates).run();
    db.delete(schema.targetAllocations).run();
    db.delete(schema.snapshots).run();
    db.delete(schema.goals).run();
    db.delete(schema.loans).run();
    db.delete(schema.budgets).run();
    db.delete(schema.transactions).run();
    db.delete(schema.portfolioHoldings).run();
    db.delete(schema.categories).run();
    db.delete(schema.accounts).run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to clear data");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
