/**
 * Admin script — run the lot-tracking backfill for a single user.
 *
 * Usage:
 *   cd pf-app && DATABASE_URL="postgresql://..." npx tsx scripts/backfill-portfolio-lots.ts <userId>
 *
 * Reads the user's transaction history, reconstructs lots + closures via
 * src/lib/portfolio/lots/backfill.ts, then prints a summary. After
 * running, hand-verify by comparing the legacy aggregator output
 * (current `/api/portfolio/overview` numbers) vs the lot-derived
 * numbers. Realized-gain delta is EXPECTED for any user with partial
 * sells (FIFO ≠ avg-cost); qty + market value + cost basis should
 * match within FX rounding.
 *
 * Flag-flip is intentionally a separate manual step:
 *   psql $DATABASE_URL -c "UPDATE portfolio_lots_status SET enabled = TRUE WHERE user_id = '<userId>';"
 *
 * Does NOT take a DEK — the script assumes the operator runs it with
 * access to the DB but not the user's password. Dividend classification
 * degrades gracefully when the DEK is null (dividendsCategoryId returns
 * null → reinvested dividends get origin='backfill' rather than
 * 'reinvest_div'; metrics layer reads dividends from transactions, not
 * lots, so the user-visible totals are unaffected).
 */

import { PostgresAdapter } from "../src/db/adapters/postgres";
import { setAdapter, setDialect } from "../src/db";
import { buildLotsForUser } from "../src/lib/portfolio/lots/backfill";

async function main(): Promise<number> {
  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: npx tsx scripts/backfill-portfolio-lots.ts <userId>");
    return 1;
  }

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
    console.log(`Backfilling lots for user: ${userId}`);
    const result = await buildLotsForUser(userId, null);
    console.log("");
    console.log("Summary");
    console.log("───────");
    console.log(`  Transactions processed: ${result.txProcessed}`);
    console.log(`  Lots written:           ${result.lotsWritten}`);
    console.log(`  Closures written:       ${result.closuresWritten}`);
    console.log(`  Errors (non-fatal):     ${result.errors.length}`);
    if (result.errors.length > 0) {
      console.log("");
      console.log("First 20 errors:");
      for (const e of result.errors.slice(0, 20)) {
        console.log(`  - ${e}`);
      }
      if (result.errors.length > 20) {
        console.log(`  ...${result.errors.length - 20} more`);
      }
    }
    console.log("");
    console.log("Next step — verify and flip the rollout flag:");
    console.log("  1. Spot-check holdings on /portfolio (legacy avg-cost path still active)");
    console.log("  2. Manually run SQL to flip the flag:");
    console.log(`     UPDATE portfolio_lots_status SET enabled = TRUE WHERE user_id = '${userId}';`);
    console.log("  3. Refresh /portfolio — lot-derived numbers should show");
    return 0;
  } catch (err) {
    console.error("FATAL:", err);
    return 1;
  } finally {
    await adapter.close();
  }
}

main().then((code) => process.exit(code));
