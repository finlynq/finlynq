/**
 * Stream D Phase 3 — per-user lazy plaintext NULL cutover.
 *
 * Companion to stream-d-backfill.ts. Where backfill writes ciphertext into
 * `name_ct` from the legacy plaintext `name`, this module is the "delete the
 * plaintext" step — but done per-user, on each successful login, gated on:
 *
 *   1. users.plaintext_nulled_at IS NULL (not already done for this user).
 *   2. Backfill is complete for this user — no row has plaintext-but-no-ct
 *      across the six Stream D tables.
 *   3. A sample row's name_ct actually decrypts with the cached DEK. This is
 *      the critical safety check: it guards against the documented
 *      "DEK in cache doesn't match write-time DEK" hypothesis (CLAUDE.md
 *      "Known open issue: pathfinder DEK mismatch"). If the sample fails,
 *      we keep the plaintext fallback — the soft-fallback layer in
 *      decryptName() is currently load-bearing for those users.
 *
 * On success: NULLs `name` (+ `alias` on accounts, + `symbol` on
 * portfolio_holdings) on every encrypted row, then sets
 * users.plaintext_nulled_at. Atomic in a single transaction.
 *
 * Implementation note — uses raw SQL for UPDATEs and the
 * `users.plaintext_nulled_at` flag because src/db/schema-pg.ts intentionally
 * does NOT track `plaintext_nulled_at` and still marks the six name columns
 * as `.notNull()`. The DB-level state (column added, NOT NULL relaxed) is
 * set by scripts/migrate-stream-d-phase3-per-user.sql.
 *
 * Fire-and-forget on the login path — never blocks login, never throws to
 * caller. Failure modes log a single warn line and return without changing
 * data. Stragglers (users who never log in) keep their plaintext indefinitely
 * — acceptable since encryption-of-display-names is defense-in-depth.
 *
 * Replaces the all-or-nothing eager variant in
 * scripts/migrate-stream-d-phase3-null.sql.
 */

import { db, schema } from "@/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { decryptField } from "./envelope";

export type Phase3NullResult =
  | { nulled: true; counts: Record<string, number> }
  | {
      nulled: false;
      reason:
        | "already-done"
        | "backfill-incomplete"
        | "dek-decrypt-failed"
        | "no-encrypted-rows";
    };

/**
 * Run the per-user Phase 3 plaintext NULL if all preconditions are met.
 * Returns a summary so callers can log or surface to admin tools.
 *
 * Edge case: stdio MCP writes plaintext into `name` (it has no DEK). If a
 * user's flag is set and stdio later writes a new row, this function on the
 * next web login finds plaintext-but-no-ct → returns "backfill-incomplete".
 * The login *after* that runs Stream D backfill on the new row, then the
 * next-next login sees backfill complete + flag already set, returns
 * "already-done". Net effect: small plaintext window for stdio-only writes
 * between web logins. Not a regression — same exposure stdio already has.
 */
export async function nullPlaintextIfReady(
  userId: string,
  dek: Buffer,
): Promise<Phase3NullResult> {
  // Step 1: skip if already done. Single-row read, runs every login.
  const flagRes = await db.execute<{ plaintext_nulled_at: string | null }>(
    sql`SELECT plaintext_nulled_at FROM users WHERE id = ${userId} LIMIT 1`,
  );
  if (flagRes.rows?.[0]?.plaintext_nulled_at) {
    return { nulled: false, reason: "already-done" };
  }

  // Step 2: backfill must be complete for this user. Any plaintext-but-no-ct
  // row across the six tables is a blocker — NULLing it would lose data.
  // Six explicit queries (Drizzle SELECT works on .notNull() columns since
  // we're reading, not writing).
  const cInt = sql<number>`count(*)::int`;

  const acctBlock = await db
    .select({ c: cInt })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        isNotNull(schema.accounts.name),
        isNull(schema.accounts.nameCt),
      ),
    );
  const catBlock = await db
    .select({ c: cInt })
    .from(schema.categories)
    .where(
      and(
        eq(schema.categories.userId, userId),
        isNotNull(schema.categories.name),
        isNull(schema.categories.nameCt),
      ),
    );
  const goalBlock = await db
    .select({ c: cInt })
    .from(schema.goals)
    .where(
      and(
        eq(schema.goals.userId, userId),
        isNotNull(schema.goals.name),
        isNull(schema.goals.nameCt),
      ),
    );
  const loanBlock = await db
    .select({ c: cInt })
    .from(schema.loans)
    .where(
      and(
        eq(schema.loans.userId, userId),
        isNotNull(schema.loans.name),
        isNull(schema.loans.nameCt),
      ),
    );
  const subBlock = await db
    .select({ c: cInt })
    .from(schema.subscriptions)
    .where(
      and(
        eq(schema.subscriptions.userId, userId),
        isNotNull(schema.subscriptions.name),
        isNull(schema.subscriptions.nameCt),
      ),
    );
  const phBlock = await db
    .select({ c: cInt })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.userId, userId),
        isNotNull(schema.portfolioHoldings.name),
        isNull(schema.portfolioHoldings.nameCt),
      ),
    );
  const totalBlocking =
    (acctBlock[0]?.c ?? 0) +
    (catBlock[0]?.c ?? 0) +
    (goalBlock[0]?.c ?? 0) +
    (loanBlock[0]?.c ?? 0) +
    (subBlock[0]?.c ?? 0) +
    (phBlock[0]?.c ?? 0);
  if (totalBlocking > 0) return { nulled: false, reason: "backfill-incomplete" };

  // Step 3: verify the DEK actually decrypts at least one sample per table.
  // decryptField throws on auth-tag failure — exactly the signal we want.
  // If any sample fails, bail with a warn line that names the user + table.
  // This warn line is the diagnostic for the unresolved pathfinder DEK
  // mismatch — without needing the planned PF_CRYPTO_DEBUG=1 deploy.
  const samples: { table: string; ct: string | null }[] = [];
  const acctSample = await db
    .select({ ct: schema.accounts.nameCt })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), isNotNull(schema.accounts.nameCt)))
    .limit(1);
  samples.push({ table: "accounts", ct: acctSample[0]?.ct ?? null });
  const catSample = await db
    .select({ ct: schema.categories.nameCt })
    .from(schema.categories)
    .where(and(eq(schema.categories.userId, userId), isNotNull(schema.categories.nameCt)))
    .limit(1);
  samples.push({ table: "categories", ct: catSample[0]?.ct ?? null });
  const goalSample = await db
    .select({ ct: schema.goals.nameCt })
    .from(schema.goals)
    .where(and(eq(schema.goals.userId, userId), isNotNull(schema.goals.nameCt)))
    .limit(1);
  samples.push({ table: "goals", ct: goalSample[0]?.ct ?? null });
  const loanSample = await db
    .select({ ct: schema.loans.nameCt })
    .from(schema.loans)
    .where(and(eq(schema.loans.userId, userId), isNotNull(schema.loans.nameCt)))
    .limit(1);
  samples.push({ table: "loans", ct: loanSample[0]?.ct ?? null });
  const subSample = await db
    .select({ ct: schema.subscriptions.nameCt })
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.userId, userId), isNotNull(schema.subscriptions.nameCt)))
    .limit(1);
  samples.push({ table: "subscriptions", ct: subSample[0]?.ct ?? null });
  const phSample = await db
    .select({ ct: schema.portfolioHoldings.nameCt })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.userId, userId),
        isNotNull(schema.portfolioHoldings.nameCt),
      ),
    )
    .limit(1);
  samples.push({ table: "portfolio_holdings", ct: phSample[0]?.ct ?? null });

  let anyCt = false;
  for (const { table, ct } of samples) {
    if (!ct) continue;
    anyCt = true;
    try {
      decryptField(dek, ct);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[phase3-null] user=${userId} table=${table} sample decrypt failed; ` +
          `keeping plaintext fallback. err=${err instanceof Error ? err.message : String(err)}`,
      );
      return { nulled: false, reason: "dek-decrypt-failed" };
    }
  }
  if (!anyCt) return { nulled: false, reason: "no-encrypted-rows" };

  // Step 4: atomic NULL + flag set. Single transaction so partial failure
  // rolls back. Raw SQL because schema.ts still marks `name` as NOT NULL;
  // the DB-level NOT NULL was relaxed by the migration. The flag at the end
  // gates re-runs (step 1).
  const counts: Record<string, number> = {};
  await db.transaction(async (tx) => {
    const a = await tx.execute(
      sql`UPDATE accounts SET name = NULL, alias = NULL
          WHERE user_id = ${userId} AND name_ct IS NOT NULL`,
    );
    counts.accounts = (a as { rowCount?: number }).rowCount ?? 0;

    const c = await tx.execute(
      sql`UPDATE categories SET name = NULL
          WHERE user_id = ${userId} AND name_ct IS NOT NULL`,
    );
    counts.categories = (c as { rowCount?: number }).rowCount ?? 0;

    const g = await tx.execute(
      sql`UPDATE goals SET name = NULL
          WHERE user_id = ${userId} AND name_ct IS NOT NULL`,
    );
    counts.goals = (g as { rowCount?: number }).rowCount ?? 0;

    const l = await tx.execute(
      sql`UPDATE loans SET name = NULL
          WHERE user_id = ${userId} AND name_ct IS NOT NULL`,
    );
    counts.loans = (l as { rowCount?: number }).rowCount ?? 0;

    const s = await tx.execute(
      sql`UPDATE subscriptions SET name = NULL
          WHERE user_id = ${userId} AND name_ct IS NOT NULL`,
    );
    counts.subscriptions = (s as { rowCount?: number }).rowCount ?? 0;

    const p = await tx.execute(
      sql`UPDATE portfolio_holdings SET name = NULL, symbol = NULL
          WHERE user_id = ${userId} AND name_ct IS NOT NULL`,
    );
    counts.portfolioHoldings = (p as { rowCount?: number }).rowCount ?? 0;

    await tx.execute(
      sql`UPDATE users SET plaintext_nulled_at = ${new Date().toISOString()}
          WHERE id = ${userId}`,
    );
  });

  return { nulled: true, counts };
}

/**
 * Fire-and-forget wrapper for login paths. Mirrors enqueueStreamDBackfill —
 * never blocks login, swallows all errors. Logs a one-liner on success or
 * unexpected error; expected failure modes (already-done, backfill-incomplete,
 * no-encrypted-rows) are silent. dek-decrypt-failed warns inside the helper.
 */
export function enqueuePhase3NullIfReady(userId: string, dek: Buffer): void {
  void (async () => {
    try {
      const r = await nullPlaintextIfReady(userId, dek);
      if (r.nulled) {
        const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
        if (total > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[phase3-null] user=${userId} nulled ${total} plaintext name cols ` +
              `(accounts=${r.counts.accounts} categories=${r.counts.categories} ` +
              `goals=${r.counts.goals} loans=${r.counts.loans} ` +
              `subscriptions=${r.counts.subscriptions} portfolioHoldings=${r.counts.portfolioHoldings})`,
          );
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[phase3-null] user=${userId} unexpected error:`, err);
    }
  })();
}
