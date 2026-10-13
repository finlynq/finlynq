// Shared formatting helpers used across screens.

/**
 * Custom symbols for the "dollar family" so CAD renders as `C$` and USD as the
 * bare `$`. `Intl.NumberFormat` can only produce `$` / `CA$` / `CAD` for CAD —
 * never `C$` — so the dollar currencies are formatted as plain decimals with a
 * hand-picked symbol prefix. Every other currency keeps its native Intl symbol
 * (EUR → €, GBP → £, JPY → ¥, …). Kept in sync with web `src/lib/currency.ts`.
 */
const DOLLAR_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "C$",
  AUD: "A$",
  NZD: "NZ$",
  HKD: "HK$",
  SGD: "S$",
  MXN: "MX$",
};

/**
 * Currencies written with other than 2 decimals. Everything else, including
 * codes the user made up, has 2.
 *
 * This is what the web shows: it reads the figure from `Intl`
 * (`currencyDecimals` in `src/lib/currency.ts`), whose data writes a few
 * currencies without decimals that ISO 4217 lists with some (the Iraqi dinar,
 * the Lebanese pound). A table is used here instead of asking `Intl` because
 * the currency data behind it varies between Android versions, and a yen amount
 * must not depend on the phone. A test checks the table against `Intl`, so the
 * two cannot drift.
 */
const CURRENCY_DECIMALS: Record<string, number> = {
  AFN: 0, ALL: 0, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 0, IRR: 0, ISK: 0, JPY: 0,
  KMF: 0, KPW: 0, KRW: 0, LAK: 0, LBP: 0, MGA: 0, MMK: 0, PYG: 0, RSD: 0, RWF: 0,
  SLL: 0, SOS: 0, SYP: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0, YER: 0,
  BHD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** How many decimals a currency is written with: 0 for JPY, 3 for KWD, else 2. */
export function currencyDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency] ?? 2;
}

/**
 * Currency formatter. Amounts use the currency's own decimals (2 for most, 0
 * for JPY, 3 for KWD) unless the caller asks otherwise; summary tiles pass 0.
 * Falls back to a plain string if the runtime Intl data lacks the currency
 * (older Hermes builds), so a bad currency code never crashes a render.
 */
export function formatCurrency(
  amount: number,
  currency = "USD",
  opts?: { decimals?: number }
): string {
  const decimals = opts?.decimals ?? currencyDecimals(currency);
  const symbol = DOLLAR_SYMBOLS[currency];
  if (symbol) {
    const num = new Intl.NumberFormat("en-CA", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(Math.abs(amount));
    return `${amount < 0 ? "-" : ""}${symbol}${num}`;
  }
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    const sign = amount < 0 ? "-" : "";
    return `${sign}${currency} ${Math.abs(amount).toFixed(decimals)}`;
  }
}

/**
 * Decrypted display names can be `null` under a cold DEK (CLAUDE.md invariant).
 * Normalize at the boundary so `.charAt`/`.localeCompare`/render never crash.
 */
export function safeName(name: string | null | undefined, fallback = "—"): string {
  return name && name.trim().length > 0 ? name : fallback;
}

/** First character for an avatar/initial, null-safe. */
export function initial(name: string | null | undefined): string {
  return (name ?? "?").charAt(0).toUpperCase();
}

/**
 * Friendly display name for an account, preferring `alias` over `name` and
 * falling back to `Account #id` when both are null/"" (cold DEK). Mirrors the
 * web `safeAccountName` in src/lib/safe-name.ts.
 */
export function safeAccountName(a: {
  id?: number | string;
  name?: string | null;
  alias?: string | null;
}): string {
  const alias = a.alias?.trim();
  if (alias) return alias;
  const name = a.name?.trim();
  if (name) return name;
  return a.id != null ? `Account #${a.id}` : "Account";
}

/** Short month/day label from an ISO date string (null-safe). */
export function formatShortDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("en-CA", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}
