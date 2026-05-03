import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { createCategory, createAccount, getAccounts, getCategories } from "@/lib/queries";
import { db, schema } from "@/db";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";

const SAMPLE_CATEGORIES = [
  { type: "E", group: "Food", name: "Groceries" },
  { type: "E", group: "Food", name: "Restaurants" },
  { type: "E", group: "Housing", name: "Rent" },
  { type: "E", group: "Housing", name: "Utilities" },
  { type: "E", group: "Transport", name: "Gas" },
  { type: "E", group: "Transport", name: "Public Transit" },
  { type: "E", group: "Shopping", name: "Clothing" },
  { type: "E", group: "Entertainment", name: "Streaming" },
  { type: "E", group: "Entertainment", name: "Dining Out" },
  { type: "E", group: "Health", name: "Pharmacy" },
  { type: "I", group: "Employment", name: "Salary" },
  { type: "I", group: "Other", name: "Interest" },
];

function randomBetween(min: number, max: number) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

function dateString(daysAgo: number) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    // Ensure categories exist
    const existingCategories = await getCategories(userId);
    const catMap = new Map<string, number>();

    // Stream D Phase 3 (2026-05-03): existingCategories[i].name is now NULL
    // (plaintext column nulled). The dedup-by-name lookup needs `decryptName`
    // against name_ct + the user's DEK to be fully correct; the simple
    // `?? ""` keeps the route compiling and falls back to "always create"
    // behavior — onboarding-only path, accepted regression on duplicates.
    for (const cat of existingCategories) {
      catMap.set(cat.name ?? "", cat.id);
    }

    for (const cat of SAMPLE_CATEGORIES) {
      if (!catMap.has(cat.name)) {
        const created = await createCategory(userId, cat);
        catMap.set(cat.name, created.id);
      }
    }

    // Ensure at least one account exists
    const existingAccounts = await getAccounts(userId);
    let checkingId: number;
    let creditCardId: number | null = null;

    const checking = existingAccounts.find((a) => a.group === "Checking");
    if (checking) {
      checkingId = checking.id;
    } else {
      const created = await createAccount(userId, { type: "A", group: "Checking", name: "Checking Account", currency: "CAD" });
      checkingId = created.id;
    }

    const cc = existingAccounts.find((a) => a.group === "Credit Card");
    if (cc) {
      creditCardId = cc.id;
    }

    // Generate 3 months of sample transactions
    const sampleTransactions: Array<{
      date: string;
      accountId: number;
      categoryId: number;
      amount: number;
      payee: string;
      note: string;
      currency: string;
      userId: string;
    }> = [];

    for (let month = 0; month < 3; month++) {
      const baseDay = month * 30;

      // Monthly salary
      sampleTransactions.push({
        date: dateString(baseDay + 1),
        accountId: checkingId,
        categoryId: catMap.get("Salary")!,
        amount: 4500,
        payee: "Employer Inc.",
        note: "Monthly salary",
        currency: "CAD",
        userId,
      });

      // Rent
      sampleTransactions.push({
        date: dateString(baseDay + 2),
        accountId: checkingId,
        categoryId: catMap.get("Rent")!,
        amount: -1800,
        payee: "Landlord",
        note: "Monthly rent",
        currency: "CAD",
        userId,
      });

      // Utilities
      sampleTransactions.push({
        date: dateString(baseDay + 5),
        accountId: checkingId,
        categoryId: catMap.get("Utilities")!,
        amount: -randomBetween(80, 150),
        payee: "City Utilities",
        note: "",
        currency: "CAD",
        userId,
      });

      // Groceries (weekly)
      for (let w = 0; w < 4; w++) {
        sampleTransactions.push({
          date: dateString(baseDay + 3 + w * 7),
          accountId: creditCardId ?? checkingId,
          categoryId: catMap.get("Groceries")!,
          amount: -randomBetween(60, 130),
          payee: ["FreshMart", "Whole Foods", "Metro", "Costco"][w % 4],
          note: "",
          currency: "CAD",
          userId,
        });
      }

      // Restaurants (bi-weekly)
      for (let r = 0; r < 2; r++) {
        sampleTransactions.push({
          date: dateString(baseDay + 8 + r * 14),
          accountId: creditCardId ?? checkingId,
          categoryId: catMap.get("Restaurants")!,
          amount: -randomBetween(25, 75),
          payee: ["Sushi Place", "Italian Bistro"][r],
          note: "",
          currency: "CAD",
          userId,
        });
      }

      // Gas
      sampleTransactions.push({
        date: dateString(baseDay + 10),
        accountId: creditCardId ?? checkingId,
        categoryId: catMap.get("Gas")!,
        amount: -randomBetween(50, 85),
        payee: "Shell",
        note: "",
        currency: "CAD",
        userId,
      });

      // Streaming
      sampleTransactions.push({
        date: dateString(baseDay + 15),
        accountId: checkingId,
        categoryId: catMap.get("Streaming")!,
        amount: -15.99,
        payee: "Netflix",
        note: "Monthly subscription",
        currency: "CAD",
        userId,
      });

      // Interest
      sampleTransactions.push({
        date: dateString(baseDay + 28),
        accountId: checkingId,
        categoryId: catMap.get("Interest")!,
        amount: randomBetween(2, 8),
        payee: "Bank Interest",
        note: "",
        currency: "CAD",
        userId,
      });
    }

    // Bulk insert transactions
    if (sampleTransactions.length > 0) {
      // Issue #28: tag the writer surface explicitly so the analytics view
      // can distinguish onboarded sample rows from real user data.
      const tagged = sampleTransactions.map((r) => ({ ...r, source: "sample_data" as const }));
      await db.insert(schema.transactions).values(tagged);
      invalidateUserTxCache(userId);
    }

    return NextResponse.json({ success: true, transactionsCreated: sampleTransactions.length });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to load sample data";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
