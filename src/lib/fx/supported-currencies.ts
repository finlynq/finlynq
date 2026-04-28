/**
 * Default supported currencies — currencies with a working `<CCY>USD=X` Yahoo Finance
 * symbol that we route through the canonical-USD rate model. Users can add overrides
 * for any 3-letter ISO 4217 code outside this list (see fx_overrides table).
 *
 * Cryptos (BTC, ETH, USDC) route through CoinGecko (src/lib/crypto-service.ts) and
 * are listed separately because their rate source differs.
 */

export const SUPPORTED_FIAT_CURRENCIES = [
  "USD", "CAD", "EUR", "GBP", "JPY", "AUD", "CHF", "NZD", "CNY", "HKD", "SGD",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "TRY", "ILS", "ZAR",
  "INR", "KRW", "THB", "IDR", "MYR", "PHP", "MXN", "BRL", "ARS", "COP", "CLP",
] as const;

export const SUPPORTED_CRYPTO_CURRENCIES = ["BTC", "ETH", "USDC", "USDT"] as const;

// Precious metals (ISO 4217 troy-ounce codes). Not on Yahoo's `<CCY>USD=X`
// pattern — routed through stooq.com's spot CSV endpoint in fx-service.ts.
export const SUPPORTED_METAL_CURRENCIES = ["XAU", "XAG", "XPT", "XPD"] as const;

export const SUPPORTED_CURRENCIES = [
  ...SUPPORTED_FIAT_CURRENCIES,
  ...SUPPORTED_CRYPTO_CURRENCIES,
  ...SUPPORTED_METAL_CURRENCIES,
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const SUPPORTED_SET = new Set<string>(SUPPORTED_CURRENCIES);
const CRYPTO_SET = new Set<string>(SUPPORTED_CRYPTO_CURRENCIES);
const METAL_SET = new Set<string>(SUPPORTED_METAL_CURRENCIES);

export function isSupportedCurrency(code: string): boolean {
  return SUPPORTED_SET.has(code.trim().toUpperCase());
}

export function isCryptoCurrency(code: string): boolean {
  return CRYPTO_SET.has(code.trim().toUpperCase());
}

export function isMetalCurrency(code: string): boolean {
  return METAL_SET.has(code.trim().toUpperCase());
}

/**
 * Display labels for common currencies. Falls back to the bare code for anything
 * not listed — keeps the UI legible for the long tail without bundling a full
 * ISO 4217 metadata table.
 */
export const CURRENCY_LABELS: Record<string, string> = {
  USD: "US Dollar",
  CAD: "Canadian Dollar",
  EUR: "Euro",
  GBP: "British Pound",
  JPY: "Japanese Yen",
  AUD: "Australian Dollar",
  CHF: "Swiss Franc",
  NZD: "New Zealand Dollar",
  CNY: "Chinese Yuan",
  HKD: "Hong Kong Dollar",
  SGD: "Singapore Dollar",
  SEK: "Swedish Krona",
  NOK: "Norwegian Krone",
  DKK: "Danish Krone",
  PLN: "Polish Złoty",
  CZK: "Czech Koruna",
  HUF: "Hungarian Forint",
  RON: "Romanian Leu",
  TRY: "Turkish Lira",
  ILS: "Israeli Shekel",
  ZAR: "South African Rand",
  INR: "Indian Rupee",
  KRW: "South Korean Won",
  THB: "Thai Baht",
  IDR: "Indonesian Rupiah",
  MYR: "Malaysian Ringgit",
  PHP: "Philippine Peso",
  MXN: "Mexican Peso",
  BRL: "Brazilian Real",
  ARS: "Argentine Peso",
  COP: "Colombian Peso",
  CLP: "Chilean Peso",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  USDC: "USD Coin",
  USDT: "Tether",
  XAU: "Gold (oz)",
  XAG: "Silver (oz)",
  XPT: "Platinum (oz)",
  XPD: "Palladium (oz)",
};

export function currencyLabel(code: string): string {
  return CURRENCY_LABELS[code] ?? code;
}
