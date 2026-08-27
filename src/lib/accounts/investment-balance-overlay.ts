/**
 * Investment-account market-value overlay — the ONE net-worth valuation
 * decision for the whole application (FINLYNQ-151, generalized 2026-08-27).
 *
 * The app follows the load-bearing invariant **"account with holdings =
 * `holdings.value`"** — an investment account's balance is its current MARKET
 * value (cash sleeve included), NOT `COALESCE(SUM(transactions.amount), 0)`.
 * For an investment account that ledger figure is *net contributions*: a
 * portfolio buy/sell writes a +stock / −cash pair that sums to zero, and even a
 * realized gain cancels (sell-stock −proceeds offsets +proceeds on the cash
 * leg). So a raw tx-sum systematically understates investment accounts.
 *
 * EVERY surface that turns per-account balances into assets / liabilities /
 * net worth goes through this function, so they cannot disagree about the same
 * question. Today that is: MCP `get_account_balances` + `get_net_worth`, the
 * dashboard, the Reports balance sheet, the reconcile balance summary, the
 * built-in AI chat, and the financial-health score. Reported 2026-08-27: the
 * health card said C$485,714 while the dashboard said C$589,864 on the same
 * data, because the health calculator was the last surface still summing
 * `transactions.amount` for investment accounts. Do NOT hand-roll the ternary
 * again — call this.
 *
 * It lives in `src/lib` (moved out of `mcp-server/` with that change) because
 * `src/lib` code now depends on it; `mcp-server` imports it by relative path.
 *
 * It is dependency-injected (`fetchHoldings`) so the production call site is
 * `() => getHoldingsValueByAccount(userId, dek)` — pass an `asOfDate` to value
 * a HISTORICAL point (both ends of a trend must use the same basis, or the
 * change is pure basis-shift, not movement) — while tests inject a spy and need
 * no module mocking.
 *
 * **Critical DEK gate.** When `dek == null` (a `pf_` API-key MCP connection —
 * OAuth/session connections carry a DEK), holdings symbols decrypt to `null`
 * and `getHoldingsValueByAccount` prices them at qty×1 (garbage —
 * holdings-value.ts:319-326). So the overlay NEVER calls `fetchHoldings` when
 * `dek == null`: API-key callers keep today's ledger numbers (byte-compatible
 * with v3.2) plus an explanatory `note`. (The guard also protects the
 * mcp-http-smoke test, which passes a non-null dek against a fake `DbLike`
 * while `getHoldingsValueByAccount` reads the global `@/db` singleton — but
 * the smoke fixtures have no investment rows, so the no-investment-rows guard
 * short-circuits there too.)
 *
 * **No rounding here.** Issue #210 parity needs raw (unrounded) amounts to
 * flow into `aggregateInReporting`; callers round at the response boundary.
 */

/** One account's pre-overlay row. `ledgerBalance` is the raw `SUM(t.amount)`. */
export type OverlayInputRow = {
  id: number;
  currency: string;
  isInvestment: boolean;
  ledgerBalance: number;
};

/** One account's post-overlay row. `balance` is market for investment rows
 * (when a DEK is present) else the unchanged ledger balance. `balanceBasis`
 * discloses which semantic was used; `costBasis` is present only for
 * market-valued investment rows. */
export type OverlayOutputRow = OverlayInputRow & {
  balance: number;
  balanceBasis: "market" | "ledger";
  costBasis?: number;
};

export type OverlayResult = {
  rows: OverlayOutputRow[];
  /** true iff the market overlay was actually applied (dek present AND >=1
   * investment row). When false, every row carries `balanceBasis:"ledger"`. */
  marketApplied: boolean;
  /** Set only when investment rows exist but the overlay could not run
   * (dek == null, or FINLYNQ-281 decrypt failure) — surfaced as a top-level
   * `note` by the caller. */
  note?: string;
  /** FINLYNQ-281 — set when the DEK is present but ≥1 holding ciphertext failed
   * to decrypt, so the overlay deliberately fell back to ledger rather than
   * returning a garbage `basis:"market"` total. */
  decryptionFailed?: boolean;
};

const DEK_NULL_NOTE =
  "Investment accounts are valued at ledger (net contributions), not market value, " +
  "because this connection has no decryption key (pf_ API key). Connect via OAuth " +
  "(or use the built-in AI chat) for market-valued investment balances.";

// FINLYNQ-281 — the DEK is present but at least one holding's ciphertext failed
// to authenticate (stale MCP session key after the demo DEK rotation, or a
// corrupt row). Pricing an undecryptable symbol yields qty×1 garbage, so we
// withhold market value entirely and fall back to ledger + this note instead of
// reporting silently-wrong money.
const DECRYPT_FAILED_NOTE =
  "Investment holdings could not be decrypted, so accounts are shown at ledger " +
  "(net contributions), NOT market value. This usually means this connection's " +
  "decryption key is stale — reconnect the MCP connection — or a holding row is " +
  "corrupt. Market totals were withheld to avoid reporting wrong numbers.";

/**
 * Apply the market-value overlay to a set of per-account ledger rows.
 *
 * - `dek == null` OR no investment rows → rows returned unchanged, every
 *   `balanceBasis: "ledger"`, `marketApplied: false`. **`fetchHoldings` is
 *   NEVER called** in this branch (guards the qty×1 hazard + the smoke test).
 *   A `note` is set only when investment rows exist but `dek == null`.
 * - else → `fetchHoldings()` is called exactly once; each investment row's
 *   `balance = map.get(id)?.value ?? 0` (issue #204: a zero-priced investment
 *   account reports 0, never the tx-sum) and `costBasis` is carried from the
 *   map. Non-investment rows keep their ledger balance and `"ledger"` basis.
 */
export async function applyInvestmentMarketOverlay(
  rows: OverlayInputRow[],
  dek: Buffer | null,
  fetchHoldings: () => Promise<Map<number, { value: number; costBasis: number }>>,
  verifyDecrypt?: () => Promise<{ failed: number; total: number }>,
): Promise<OverlayResult> {
  const hasInvestment = rows.some((r) => r.isInvestment);

  if (dek == null || !hasInvestment) {
    return {
      rows: rows.map((r) => ({
        ...r,
        balance: r.ledgerBalance,
        balanceBasis: "ledger" as const,
      })),
      marketApplied: false,
      note: dek == null && hasInvestment ? DEK_NULL_NOTE : undefined,
    };
  }

  // FINLYNQ-281 — the DEK is present, but verify it actually decrypts the
  // user's holdings BEFORE pricing. A stale/wrong DEK decrypts symbols to null,
  // and `fetchHoldings` (getHoldingsValueByAccount) then prices them at qty×1
  // (garbage) — which the caller would return as a wrong `basis:"market"`
  // total. On any decrypt failure, fall back to ledger + an explicit note and
  // NEVER call `fetchHoldings` (skip the qty×1 path entirely).
  if (verifyDecrypt) {
    const health = await verifyDecrypt();
    if (health.failed > 0) {
      return {
        rows: rows.map((r) => ({
          ...r,
          balance: r.ledgerBalance,
          balanceBasis: "ledger" as const,
        })),
        marketApplied: false,
        note: DECRYPT_FAILED_NOTE,
        decryptionFailed: true,
      };
    }
  }

  const map = await fetchHoldings();
  return {
    rows: rows.map((r) => {
      if (!r.isInvestment) {
        return { ...r, balance: r.ledgerBalance, balanceBasis: "ledger" as const };
      }
      const hv = map.get(r.id);
      // Issue #204 — an investment account with zero priced holdings reports
      // 0 (market), NEVER the tx-sum.
      return {
        ...r,
        balance: hv?.value ?? 0,
        balanceBasis: "market" as const,
        costBasis: hv?.costBasis ?? 0,
      };
    }),
    marketApplied: true,
  };
}
