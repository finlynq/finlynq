/**
 * The currency a NEW record is stored in.
 *
 * A record's currency is never a hardcoded default (feedback #7). The rule is
 * always the same three-step precedence:
 *
 *   explicit > owning account's currency > the user's display currency
 *
 * It has been re-derived inline at every write site, and every time one of
 * them skipped a step it persisted the wrong currency rather than merely
 * rendering it wrong: `POST /api/subscriptions` and both MCP subscription
 * create paths stamped CAD onto users holding only MXN/USD, and MCP
 * `manage_loans(op:add)` omitted the column entirely so the DB default filled
 * in. Only the PRECEDENCE lives here — each caller still fetches the account
 * row and the display currency itself, because the web routes read through
 * Drizzle and the MCP tools read through raw `sql`/pg-compat.
 *
 * Pure and dependency-free so both surfaces (and their tests) can share it.
 */

/** Normalize to an ISO-ish uppercase code, or null when there's nothing usable. */
function normalize(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  return c ? c : null;
}

export function pickRecordCurrency(opts: {
  /** Currency the caller passed explicitly (form field, tool argument). */
  explicit?: string | null;
  /** Currency of the account the record hangs off, when there is one. */
  accountCurrency?: string | null;
  /** The user's resolved display currency — the terminal fallback. */
  displayCurrency: string;
}): string {
  return (
    normalize(opts.explicit) ??
    normalize(opts.accountCurrency) ??
    // `displayCurrency` is itself resolved (getDisplayCurrency / the MCP
    // resolveReportingCurrency), both of which already terminate at USD
    // (FINLYNQ-183/284). USD here is belt-and-braces for an empty string.
    normalize(opts.displayCurrency) ??
    "USD"
  );
}
