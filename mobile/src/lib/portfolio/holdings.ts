// Pure portfolio selectors — replicate the web op-forms' client-side account /
// holding / cash-sleeve detection so the mobile OperationFormScreen can gate
// fields + the cash-sleeve prerequisite without a server round-trip. JSX-free
// and unit-testable.
import type {
  AccountBalance,
  PortfolioHoldingRow,
  EnrichedHolding,
  PortfolioOverview,
  PortfolioHoldingSummary,
} from "../../../../shared/types";

const METALS = new Set(["XAU", "XAG", "XPT", "XPD"]);

/**
 * Pure resolver for a holding's human-readable description (FINLYNQ-242,
 * mirrors web pf-app .../holding-description.ts). Prefers the quote-layer
 * long name (`description`/`quoteName` = Yahoo `meta.shortName`), falls back
 * to the stored `name`, and returns null when neither is a meaningful
 * description distinct from the ticker code (cash sleeves, metals, custom
 * holdings, or a stored name that just echoes the symbol). NEVER throws —
 * every input is treated as nullable (cold-DEK null defense).
 */
export function holdingDescription(input: {
  description?: string | null;
  name?: string | null;
  symbol?: string | null;
}): string | null {
  const sym = (input.symbol ?? "").trim().toUpperCase();
  const meaningful = (candidate: string | null | undefined): string | null => {
    const trimmed = (candidate ?? "").trim();
    if (!trimmed) return null;
    if (sym && trimmed.toUpperCase() === sym) return null;
    return trimmed;
  };
  return meaningful(input.description) ?? meaningful(input.name);
}

/**
 * Canonical key for an enriched per-account holding — mirrors the web
 * /api/portfolio/overview `canonicalKey()` (which delegates to
 * pf-app src/lib/securities/canonical.ts `clusterFromAssetType`) so the
 * overview list can pool the per-account rows into the same `byHolding` rows
 * the server returns, and the holding-detail screen can recover a byHolding
 * row's member accounts.
 *
 * The server's display `assetType` has a 5th value, "metal" (XAU/XAG/XPT/XPD);
 * it feeds that to the cluster rule as "cash", which re-derives `metal:<SYM>`
 * from the symbol. Without this branch a metal fell through to `custom:` and
 * its detail screen found no member accounts.
 */
export function canonicalKeyOf(h: EnrichedHolding): string {
  const sym = (h.symbol ?? "").toUpperCase();
  if (h.assetType === "crypto" && sym) return `crypto:${sym}`;
  if ((h.assetType === "stock" || h.assetType === "etf") && sym) return `eq:${sym}`;
  if (h.assetType === "cash" || h.assetType === "metal") {
    if (sym) return METALS.has(sym) ? `metal:${sym}` : `cash:${sym}`;
    return `cash:${(h.currency ?? "").toUpperCase()}`;
  }
  // Server uses `(name || "?")`, so an empty-string name keys as "?" too.
  return `custom:${(h.name || "?").trim().toLowerCase()}`;
}

/**
 * Resolve one consolidated holding (and its per-account member positions)
 * out of an overview payload by its canonical `key`. Shared by the overview
 * list (to open the detail screen) and the detail screen (to re-read itself
 * after a Buy/Sell). The first byHolding row with the key wins — during a
 * partial securities backfill two rows can share a legacy key; members are
 * every position whose canonical key matches. Null when the key is gone.
 */
export function findHoldingInOverview(
  overview: Pick<PortfolioOverview, "byHolding" | "holdings">,
  key: string
): { summary: PortfolioHoldingSummary; members: EnrichedHolding[] } | null {
  const summary = (overview.byHolding ?? []).find((s) => s.key === key);
  if (!summary) return null;
  const members = (overview.holdings ?? []).filter((h) => canonicalKeyOf(h) === key);
  return { summary, members };
}

/** Investment accounts (the only ones that can hold portfolio operations). */
export function investmentAccounts(balances: AccountBalance[]): AccountBalance[] {
  return balances.filter((b) => b.isInvestment === true);
}

/** Non-investment accounts — the bank side of a Brokerage Deposit/Withdrawal. */
export function nonInvestmentAccounts(balances: AccountBalance[]): AccountBalance[] {
  return balances.filter((b) => b.isInvestment !== true);
}

/** Non-cash holdings in an account (the "holding to buy/sell" picker source). */
export function accountHoldings(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined
): PortfolioHoldingRow[] {
  if (accountId == null) return [];
  return holdings.filter((h) => h.accountId === accountId && !h.isCash);
}

/** Cash sleeves (is_cash=true) provisioned in an account. */
export function cashSleeves(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined
): PortfolioHoldingRow[] {
  if (accountId == null) return [];
  return holdings.filter((h) => h.accountId === accountId && h.isCash === true);
}

/** Find the cash sleeve for (account, currency); null if not yet provisioned. */
export function findCashSleeve(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined,
  currency: string | null | undefined
): PortfolioHoldingRow | null {
  if (accountId == null || !currency) return null;
  const ccy = currency.toUpperCase();
  return (
    holdings.find(
      (h) =>
        h.accountId === accountId &&
        h.isCash === true &&
        (h.currency ?? "").toUpperCase() === ccy
    ) ?? null
  );
}

/** Distinct sleeve currencies in an account (powers FX From/To currency pickers). */
export function sleeveCurrencies(
  holdings: PortfolioHoldingRow[],
  accountId: number | null | undefined
): string[] {
  const seen = new Set<string>();
  for (const h of cashSleeves(holdings, accountId)) {
    const c = (h.currency ?? "").toUpperCase();
    if (c) seen.add(c);
  }
  return Array.from(seen).sort();
}
