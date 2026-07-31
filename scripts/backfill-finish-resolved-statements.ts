/**
 * One-time sweep: file every already-resolved pending statement into Processed.
 *
 * The resolution rule only runs inside a promote pass, so statements that got
 * stuck BEFORE the fix stay stuck — nothing re-triggers them. This walks every
 * (user, bound account) with pending statements and applies the same rule via
 * the same two functions the runtime uses. No second implementation.
 *
 * Re-runnable and idempotent: `finishStatement` no-ops on a statement that
 * already has a batch and an `approved` status, and the rule is all-or-nothing,
 * so a statement with real work left is never touched.
 *
 *   npx tsx scripts/backfill-finish-resolved-statements.ts [--apply]
 *
 * Defaults to a DRY RUN — it reports what it would close and changes nothing.
 * Pass --apply to write.
 *
 * DEK: statements are filed with a batch whose filename is re-encrypted under
 * the user tier, which needs that user's DEK. This script has none, so
 * `finishStatement` receives null and the batch filename lands NULL. That is
 * the same degradation the panel already tolerates (it renders the account name
 * for a batch with no filename) and is preferable to leaving the statement
 * invisible in both lists.
 */

import { PostgresAdapter } from "../src/db/adapters/postgres";
import { setAdapter, setDialect, db, schema } from "../src/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  statementsFullyInLedger,
  finishStatement,
} from "../src/lib/import/statement-resolution";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY (writing)" : "MODE: DRY RUN (no writes) — pass --apply to write");

  // Standalone script: `instrumentation.ts` bootstraps the adapter inside the
  // app, so a script driving the `@/db` proxy must do it itself or the first
  // property access throws "Database adapter not initialized".
  const databaseUrl = process.env.DATABASE_URL || process.env.PF_DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL (or PF_DATABASE_URL) must be set");
    process.exit(1);
  }
  setDialect("postgres");
  const adapter = new PostgresAdapter();
  // userId is connection metadata only — every query below is scoped by the
  // explicit per-user id read from staged_imports.
  await adapter.initialize({
    dialect: "postgres",
    postgres: { connectionString: databaseUrl, userId: "" },
  });
  setAdapter(adapter);

  // Every (user, account) pair that still has pending statements.
  const pairs = await db
    .select({
      userId: schema.stagedImports.userId,
      accountId: schema.stagedImports.boundAccountId,
      n: sql<number>`COUNT(*)`,
    })
    .from(schema.stagedImports)
    .where(
      and(
        eq(schema.stagedImports.status, "pending"),
        isNotNull(schema.stagedImports.boundAccountId),
      ),
    )
    .groupBy(schema.stagedImports.userId, schema.stagedImports.boundAccountId)
    .all();

  console.log(`Scanning ${pairs.length} (user, account) pair(s) with pending statements.`);

  let scanned = 0;
  let finished = 0;
  const perUser = new Map<string, number>();

  for (const pair of pairs) {
    if (pair.accountId == null) continue;

    const pending = await db
      .select({ id: schema.stagedImports.id })
      .from(schema.stagedImports)
      .where(
        and(
          eq(schema.stagedImports.userId, pair.userId),
          eq(schema.stagedImports.boundAccountId, pair.accountId),
          eq(schema.stagedImports.status, "pending"),
        ),
      )
      .all();
    if (pending.length === 0) continue;
    scanned += pending.length;

    const resolved = await statementsFullyInLedger(
      pair.userId,
      pending.map((p) => p.id),
    );
    if (resolved.size === 0) continue;

    for (const id of resolved) {
      if (apply) {
        const ok = await finishStatement(pair.userId, id, null);
        if (!ok) continue;
      }
      finished += 1;
      perUser.set(pair.userId, (perUser.get(pair.userId) ?? 0) + 1);
    }
  }

  console.log(`\nScanned  : ${scanned} pending statement(s)`);
  console.log(`${apply ? "Finished" : "Would finish"} : ${finished}`);
  for (const [userId, n] of [...perUser].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${userId}  ${n}`);
  }
  if (!apply && finished > 0) {
    console.log(`\nRe-run with --apply to write.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
