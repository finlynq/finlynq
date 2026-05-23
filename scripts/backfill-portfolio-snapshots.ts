/**
 * Admin script — backfill historical portfolio snapshots for one user.
 *
 * Usage:
 *   cd pf-app && DATABASE_URL="postgresql://..." npx tsx scripts/backfill-portfolio-snapshots.ts <userId> [<fromDate>]
 *
 * Walks from the user's first transaction date (or <fromDate> if
 * provided) to today, building one snapshot per day. Uses the same
 * buildDailySnapshot helper as the nightly cron, so output shape is
 * identical.
 *
 * Idempotent — re-runs UPSERT via the unique index. `gaps_filled=true`
 * tracks days where price_cache or fx_rates fell back; the UI surfaces
 * that on the performance chart so users can interpret accordingly.
 *
 * Phase 3 of plan/portfolio-lots-and-performance.md.
 */

import { eq, sql } from "drizzle-orm";
import { PostgresAdapter } from "../src/db/adapters/postgres";
import { setAdapter, setDialect, db, schema } from "../src/db";
import { buildDailySnapshot } from "../src/lib/portfolio/snapshots/builder";

async function main(): Promise<number> {
  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: npx tsx scripts/backfill-portfolio-snapshots.ts <userId> [<fromDate>]");
    return 1;
  }
  const fromArg = process.argv[3] ?? null;

  const databaseUrl = process.env.DATABASE_URL || process.env.PF_DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL (or PF_DATABASE_URL) must be set");
    return 1;
  }

  setDialect("postgres");
  const adapter = new PostgresAdapter();
  await adapter.initialize({
    dialect: "postgres",
    postgres: { connectionString: databaseUrl, userId },
  });
  setAdapter(adapter);

  try {
    // Discover the user's earliest transaction date.
    let fromDate = fromArg;
    if (!fromDate) {
      const row = await db
        .select({ minDate: sql<string>`MIN(${schema.transactions.date})` })
        .from(schema.transactions)
        .where(eq(schema.transactions.userId, userId));
      fromDate = row[0]?.minDate ?? new Date().toISOString().slice(0, 10);
    }
    const toDate = new Date().toISOString().slice(0, 10);

    console.log(`Backfilling daily snapshots for user ${userId}`);
    console.log(`  Range: ${fromDate} → ${toDate}`);
    console.log("");

    let day = fromDate;
    let count = 0;
    let gapsFilledDays = 0;
    while (day <= toDate) {
      const result = await buildDailySnapshot({ userId, date: day, dek: null });
      if (result.gapsFilled) gapsFilledDays++;
      count++;
      if (count % 30 === 0) {
        console.log(`  …${day} (${count} snapshots written)`);
      }
      const next = new Date(`${day}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      day = next.toISOString().slice(0, 10);
    }
    console.log("");
    console.log("Summary");
    console.log("───────");
    console.log(`  Days processed:        ${count}`);
    console.log(`  Days with gap-fills:   ${gapsFilledDays}`);
    console.log("");
    console.log("Next step — visit /portfolio and click the Performance chart's All button.");
    return 0;
  } catch (err) {
    console.error("FATAL:", err);
    return 1;
  } finally {
    await adapter.close();
  }
}

main().then((code) => process.exit(code));
