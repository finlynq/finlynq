import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}

export async function importAccounts(csvText: string) {
  const rows = parseCSV(csvText);
  let imported = 0;
  for (const row of rows) {
    const existing = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.name, row["Account"]))
      .get();
    if (!existing) {
      db.insert(schema.accounts)
        .values({
          type: row["Type"],
          group: row["Group"] ?? "",
          name: row["Account"],
          currency: row["Currency"] ?? "CAD",
          note: row["Note"] ?? "",
        })
        .run();
      imported++;
    }
  }
  return { total: rows.length, imported };
}

export async function importCategories(csvText: string) {
  const rows = parseCSV(csvText);
  let imported = 0;
  for (const row of rows) {
    const existing = db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, row["Category"]))
      .get();
    if (!existing) {
      db.insert(schema.categories)
        .values({
          type: row["Type"],
          group: row["Group"] ?? "",
          name: row["Category"],
          note: row["Note"] ?? "",
        })
        .run();
      imported++;
    }
  }
  return { total: rows.length, imported };
}

export async function importPortfolio(csvText: string) {
  const rows = parseCSV(csvText);
  let imported = 0;
  for (const row of rows) {
    const account = db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.name, row["Portfolio account name"]))
      .get();
    if (!account) continue;

    const existing = db
      .select()
      .from(schema.portfolioHoldings)
      .where(eq(schema.portfolioHoldings.name, row["Portfolio holding name"]))
      .get();
    if (!existing) {
      db.insert(schema.portfolioHoldings)
        .values({
          accountId: account.id,
          name: row["Portfolio holding name"],
          symbol: row["Symbol"] || null,
          currency: row["Currency"] ?? "CAD",
          note: row["Note"] ?? "",
        })
        .run();
      imported++;
    }
  }
  return { total: rows.length, imported };
}

export async function importTransactions(csvText: string) {
  const rows = parseCSV(csvText);
  let imported = 0;
  const batchSize = 500;

  // Pre-load account and category lookups
  const allAccounts = db.select().from(schema.accounts).all();
  const accountMap = new Map(allAccounts.map((a) => [a.name, a.id]));

  const allCategories = db.select().from(schema.categories).all();
  const categoryMap = new Map(allCategories.map((c) => [c.name, c.id]));

  const insertStmt = db.insert(schema.transactions);

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values = [];

    for (const row of batch) {
      const accountId = accountMap.get(row["Account"]);
      const categoryId = categoryMap.get(row["Categorization"]);
      if (!accountId) continue;

      values.push({
        date: row["Date"],
        accountId,
        categoryId: categoryId ?? null,
        currency: row["Currency"] ?? "CAD",
        amount: parseFloat(row["Amount"]) || 0,
        quantity: row["Quantity"] ? parseFloat(row["Quantity"]) : null,
        portfolioHolding: row["Portfolio holding"] || null,
        note: row["Note"] ?? "",
        payee: row["Payee"] ?? "",
        tags: row["Tags"] ?? "",
      });
    }

    if (values.length > 0) {
      db.insert(schema.transactions).values(values).run();
      imported += values.length;
    }
  }

  return { total: rows.length, imported };
}
