/**
 * Stream D canonicalize-portfolio (issue #25 / Section F).
 *
 * Per-user lazy backfill that rewrites a portfolio_holdings row's display
 * name to the canonical key whenever the row represents a tickered position,
 * a cash sleeve, or a currency-code holding. Truly user-defined positions
 * (no symbol AND name != "Cash" AND symbol not in supported-currency list)
 * keep whatever the user typed.
 *
 * Why per-user (not pure SQL):
 *   - Stream D's `name_lookup` is HMAC-derived from the user's DEK, so the
 *     canonical name's lookup must be computed inside the user's session.
 *   - Stream D Phase 4 (2026-05-03) physically DROPPED the plaintext
 *     `name`/`symbol` columns; reading either requires decrypting
 *     `name_ct`/`symbol_ct` first.
 *
 * Why this is safe to re-run:
 *   - Step 1 short-circuits via `users.portfolio_names_canonicalized_at`.
 *   - The classifier is deterministic given the user's data, so a re-run
 *     after an admin reset of the flag produces the same canonical names.
 *
 * DEK-mismatch users (pathfinder cohort per CLAUDE.md "Known open issue:
 * pathfinder DEK mismatch") bail silently at the sample-decrypt precondition.
 * Post-Phase-4 there is no plaintext fallback — their rows render "—" until
 * the DEK mismatch is resolved; canonicalization is defense-in-depth and
 * skipping it is safe.
 *
 * Fire-and-forget on the login path — never blocks login, never throws to
 * caller. Failure modes log a single warn line and return without touching
 * data. Stragglers (users who never log in) keep their non-canonical names
 * indefinitely — acceptable since names are display-only.
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { decryptField } from "./envelope";
import { buildNameFields, decryptName } from "./encrypted-columns";
import {
  isSupportedCurrency,
  isMetalCurrency,
} from "@/lib/fx/supported-currencies";

export type CanonicalizeResult =
  | { canonicalized: true; rewrittenCount: number; total: number }
  | {
      canonicalized: false;
      reason: "already-done" | "dek-decrypt-failed" | "no-rows";
    };

/**
 * Classify a holding's plaintext name/symbol into one of:
 *   - tickered: stock / ETF / crypto with a non-currency-code symbol.
 *     Canonical name = uppercased symbol. Crypto preserves the FULL symbol
 *     (per issue #25 decision: "BTC-ETH is distinct from BTC, do NOT
 *     collapse on `-`").
 *   - cash-sleeve: name === "Cash" with no symbol. Canonical name stays
 *     "Cash"; this is the shape `getOrCreateCashHolding` writes.
 *   - currency-code: symbol IS a 3-4 letter ISO 4217 / metal code. Cash-as-
 *     currency position. Canonical name = "Cash <SYMBOL>". Metals (XAU/XAG/
 *     etc.) treated the same — they're tradeable units priced in the
 *     account's currency.
 *   - user-defined: anything else. Keep as-is.
 *
 * Returns the canonical (name, symbol) tuple to write, or null when the row
 * should be left alone. The (symbol, isCrypto) pair is preserved on writes —
 * we only rewrite `name` (and the `*_ct`/`*_lookup` companion columns).
 */
function classify(
  name: string | null,
  symbol: string | null,
): { canonicalName: string } | null {
  const sym = (symbol ?? "").trim().toUpperCase();
  const nm = (name ?? "").trim();

  // cash-sleeve: name === "Cash", no symbol. Canonical name stays "Cash" —
  // this is what getOrCreateCashHolding writes; nothing to rewrite if it's
  // already correct.
  if (!sym && nm.toLowerCase() === "cash") {
    if (nm === "Cash") return null; // already canonical
    return { canonicalName: "Cash" }; // capitalization fix
  }

  // currency-code symbol → cash-as-currency position. CAD/USD/EUR/XAU/etc.
  // Canonical name = "Cash <SYMBOL>" so it doesn't collide with the no-
  // symbol "Cash" sleeve row in the same account (the partial UNIQUE on
  // (user_id, account_id, name_lookup) would otherwise raise 23505 if we
  // tried to canonicalize both into "Cash").
  if (sym && /^[A-Z]{3,4}$/.test(sym) && (isSupportedCurrency(sym) || isMetalCurrency(sym))) {
    const canonical = `Cash ${sym}`;
    return nm === canonical ? null : { canonicalName: canonical };
  }

  // tickered: any non-empty symbol that isn't a currency code. Stocks /
  // ETFs / crypto. Canonical name = uppercased symbol (full symbol — does
  // NOT collapse `BTC-ETH` to `BTC` per issue #25 decision).
  if (sym) {
    return nm === sym ? null : { canonicalName: sym };
  }

  // user-defined: no symbol, name isn't "Cash". Leave the user's free-text
  // name alone — they typed it, they get to keep it.
  return null;
}

/**
 * Run the per-user canonicalization pass if not already done. Returns a
 * summary so callers can log or surface to admin tools.
 *
 * Operates inside one transaction so a partial failure rolls back. Each
 * row's UPDATE writes name_ct + name_lookup (via buildNameFields). Phase 4
 * dropped the plaintext name column; only ciphertext + lookup hash remain.
 */
export async function canonicalizePortfolioNamesIfReady(
  userId: string,
  dek: Buffer,
): Promise<CanonicalizeResult> {
  // Step 1: skip if already done.
  const flagRes = await db.execute<{ portfolio_names_canonicalized_at: string | null }>(
    sql`SELECT portfolio_names_canonicalized_at FROM users WHERE id = ${userId} LIMIT 1`,
  );
  if (flagRes.rows?.[0]?.portfolio_names_canonicalized_at) {
    return { canonicalized: false, reason: "already-done" };
  }

  // Step 2: load every holding for this user. Phase 4 dropped the plaintext
  // columns — we read ciphertext only and decrypt to feed the classifier.
  const rows = await db
    .select({
      id: schema.portfolioHoldings.id,
      nameCt: schema.portfolioHoldings.nameCt,
      symbolCt: schema.portfolioHoldings.symbolCt,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId));

  if (rows.length === 0) {
    // No rows yet — flip the flag so we don't keep checking on every login.
    await db.execute(
      sql`UPDATE users SET portfolio_names_canonicalized_at = ${new Date().toISOString()}
          WHERE id = ${userId}`,
    );
    return { canonicalized: false, reason: "no-rows" };
  }

  // Step 3: sample-decrypt precondition. Pick the first row whose name_ct
  // is populated and verify decryptField succeeds. Without this, a DEK-
  // mismatch user would get their canonical name encrypted under the cached
  // DEK while existing rows are encrypted under a different DEK, and the
  // newly-written rows would be unreadable. Bail silently.
  const sample = rows.find((r) => r.nameCt && r.nameCt !== "");
  if (sample?.nameCt) {
    try {
      decryptField(dek, sample.nameCt);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[canonicalize-portfolio] user=${userId} sample decrypt failed; ` +
          `keeping existing names. err=${err instanceof Error ? err.message : String(err)}`,
      );
      return { canonicalized: false, reason: "dek-decrypt-failed" };
    }
  }

  // Step 4: rewrite rows that classify as canonical. Each row's UPDATE sets
  // name_ct + name_lookup (via buildNameFields). Phase 4 dropped plaintext
  // `name`/`symbol`, so the partial UNIQUE on (user_id, account_id,
  // name_lookup) is the only collision check.
  let rewrittenCount = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      // Decrypt to plaintext so the classifier sees the actual user-visible
      // name + symbol. decryptName returns null on missing-DEK / decrypt
      // failure — the classifier treats null/empty as "no symbol".
      const decryptedName = decryptName(r.nameCt, dek, null) ?? "";
      const decryptedSymbol = decryptName(r.symbolCt, dek, null);

      const verdict = classify(decryptedName, decryptedSymbol);
      if (!verdict) continue;

      const enc = buildNameFields(dek, { name: verdict.canonicalName });
      await tx
        .update(schema.portfolioHoldings)
        .set({
          nameCt: (enc.nameCt as string | null) ?? null,
          nameLookup: (enc.nameLookup as string | null) ?? null,
        })
        .where(
          and(
            eq(schema.portfolioHoldings.id, r.id),
            eq(schema.portfolioHoldings.userId, userId),
          ),
        );
      rewrittenCount++;
    }

    await tx.execute(
      sql`UPDATE users SET portfolio_names_canonicalized_at = ${new Date().toISOString()}
          WHERE id = ${userId}`,
    );
  });

  return { canonicalized: true, rewrittenCount, total: rows.length };
}

/**
 * Fire-and-forget wrapper for login paths. Never blocks login, swallows all
 * errors. Logs a one-liner on success or unexpected error; expected failure
 * modes (already-done, no-rows, dek-decrypt-failed) are silent (the helper
 * warns on dek-decrypt-failed inside).
 */
export function enqueueCanonicalizePortfolioNames(userId: string, dek: Buffer): void {
  void (async () => {
    try {
      const r = await canonicalizePortfolioNamesIfReady(userId, dek);
      if (r.canonicalized && r.rewrittenCount > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[canonicalize-portfolio] user=${userId} rewrote ${r.rewrittenCount}/${r.total} ` +
            `portfolio_holdings names to canonical form`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[canonicalize-portfolio] user=${userId} unexpected error:`, err);
    }
  })();
}
