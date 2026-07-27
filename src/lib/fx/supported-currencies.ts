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

/**
 * Additional fiat currencies that Yahoo quotes as `<CCY>USD=X` but that are
 * NOT in `SUPPORTED_CURRENCIES` (2026-07-27).
 *
 * ⚠️ THE SPLIT IS THE POINT — do not merge this into `SUPPORTED_CURRENCIES`.
 * That constant answers "is this TICKER a currency rather than a stock"
 * (`isCurrencyCodeSymbol`, `/api/portfolio/symbol-info`, `/api/securities/define`),
 * and several codes here are live Yahoo EQUITY/ETF tickers — `AED` is Aegon
 * N.V. PERP CAP SECS, `SAR` is Saratoga Investment Corp. Adding them there
 * would reclassify anyone HOLDING those tickers as holding foreign cash: the
 * documented "CAD -> Cadiz Inc" mispricing in reverse, a 100x-scale valuation
 * error. This list is only ever asked "can we get an FX rate for it", which is
 * safe.
 *
 * Nothing in the rate stack needed to change to support these: `getRateToUsd`
 * never consulted the supported list — it fetches `<CCY>USD=X` for any code
 * (fx-service.ts). The 32-currency list was gating the display-currency PICKER
 * and its PUT validation only, so a user wanting to report in AED had to add a
 * manual custom rate for a currency we could already price.
 *
 * Membership was MEASURED, not assumed: every code below returned a positive
 * close from Yahoo within the last 5 days on 2026-07-27. Six candidates were
 * deliberately excluded for having no recent quote — ANG (replaced by XCG),
 * BGN (Bulgaria adopted the euro 2026-01-01), BTN, KGS, SSP, ZWL. A retired or
 * thinly-quoted currency would fall through to the most-recent cached rate and
 * silently report at a months-old number; `fx_overrides` remains the escape
 * hatch for those. Re-measure before adding more.
 */
export const ADDITIONAL_REPORTABLE_CURRENCIES = [
  "AED", "AFN", "ALL", "AMD", "AOA", "AWG", "AZN", "BAM", "BBD", "BDT",
  "BHD", "BIF", "BMD", "BND", "BOB", "BSD", "BWP", "BYN", "BZD", "CDF",
  "CRC", "CUP", "CVE", "DJF", "DOP", "DZD", "EGP", "ERN", "ETB", "FJD",
  "FKP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HNL", "HTG",
  "IQD", "IRR", "ISK", "JMD", "JOD", "KES", "KHR", "KMF", "KWD", "KYD",
  "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA",
  "MKD", "MMK", "MNT", "MOP", "MUR", "MVR", "MWK", "MZN", "NAD", "NGN",
  "NIO", "NPR", "OMR", "PAB", "PEN", "PGK", "PKR", "PYG", "QAR", "RSD",
  "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SLE", "SOS", "SRD", "STN",
  "SVC", "SYP", "SZL", "TJS", "TMT", "TND", "TOP", "TTD", "TWD", "TZS",
  "UAH", "UGX", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD",
  "XOF", "XPF", "YER", "ZMW",
] as const;

/**
 * Every fiat currency offerable as the app-wide DISPLAY (reporting) currency.
 * Built-ins first (curated, most-used order), then the rest alphabetically —
 * the pickers are searchable, so ordering only has to serve the common case.
 *
 * This is the list for "what can totals be reported in". It is NOT the list for
 * "is this ticker cash" — see the warning above.
 */
export const REPORTABLE_FIAT_CURRENCIES = [
  ...SUPPORTED_FIAT_CURRENCIES,
  ...ADDITIONAL_REPORTABLE_CURRENCIES,
] as const;

const REPORTABLE_SET = new Set<string>(REPORTABLE_FIAT_CURRENCIES);

/** True if `code` can be selected as the display/reporting currency. */
export function isReportableCurrency(code: string): boolean {
  return REPORTABLE_SET.has(code.trim().toUpperCase());
}

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
 * Crypto ticker symbols recognized as CoinGecko-priced holdings.
 *
 * Distinct from `SUPPORTED_CRYPTO_CURRENCIES` / `isCryptoCurrency()`, which
 * gate the FX rate model (BTC/ETH/USDC/USDT route through CoinGecko as
 * *currencies*). This wider set classifies a portfolio HOLDING's symbol
 * (e.g. "SOL", "AVAX", "BTC-USD") as crypto for market-value pricing. It is
 * the single source of truth for the three portfolio aggregators
 * (holdings-value.ts, /api/portfolio/overview, /api/portfolio/crypto) that
 * previously each carried an identical hardcoded copy.
 *
 * Adding a coin here makes every aggregator price it consistently; a
 * divergence used to silently mis-price coins present in only one copy.
 */
export const CRYPTO_HOLDING_SYMBOLS = new Set<string>([
  "BTC", "ETH", "SOL", "ADA", "XRP", "DOGE", "AAVE", "ATOM", "AVAX",
  "CRV", "FTM", "HBAR", "LINK", "LTC", "MATIC", "POL", "DOT", "XLM",
  "UNI", "YFI", "SNX", "BNB", "SHIB", "ARB", "OP", "APT", "SUI",
  "NEAR", "FIL", "ICP", "ALGO", "XTZ", "EOS", "SAND", "MANA", "AXS", "S",
]);

/**
 * Classify a holding's symbol as a CoinGecko-priced crypto. Strips the
 * optional Yahoo-style quote-currency suffix first (e.g. "BTC-USD" -> "BTC").
 */
export function isCryptoSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return CRYPTO_HOLDING_SYMBOLS.has(symbol.toUpperCase().split("-")[0]);
}

/**
 * A holding whose symbol IS a currency code (CAD, USD, EUR, XAU, …)
 * represents a foreign-cash position, NOT a stock. Yahoo would otherwise
 * return data for unrelated tickers ("CAD" -> Cadiz Inc on NASDAQ) that
 * inflate market value by 100×+.
 *
 * `extraCodes` lets callers recognize user-defined active currency codes
 * (e.g. the portfolio overview's `active_currencies` setting) in addition to
 * the built-in supported set, preserving each call site's exact behavior.
 */
export function isCurrencyCodeSymbol(
  sym: string | null | undefined,
  extraCodes?: ReadonlySet<string> | readonly string[],
): boolean {
  if (!sym) return false;
  const s = sym.trim().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(s)) return false;
  if (isSupportedCurrency(s)) return true;
  if (!extraCodes) return false;
  return Array.isArray(extraCodes) ? extraCodes.includes(s) : (extraCodes as ReadonlySet<string>).has(s);
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

  // ADDITIONAL_REPORTABLE_CURRENCIES. Names matter more here than for the
  // built-ins: the display-currency pickers are type-ahead and filter on the
  // LABEL as well as the code, so without a name "dirham" or "riyal" finds
  // nothing and the user has to already know the ISO code.
  AED: "UAE Dirham",
  AFN: "Afghan Afghani",
  ALL: "Albanian Lek",
  AMD: "Armenian Dram",
  AOA: "Angolan Kwanza",
  AWG: "Aruban Florin",
  AZN: "Azerbaijani Manat",
  BAM: "Bosnia-Herzegovina Convertible Mark",
  BBD: "Barbadian Dollar",
  BDT: "Bangladeshi Taka",
  BHD: "Bahraini Dinar",
  BIF: "Burundian Franc",
  BMD: "Bermudan Dollar",
  BND: "Brunei Dollar",
  BOB: "Bolivian Boliviano",
  BSD: "Bahamian Dollar",
  BWP: "Botswanan Pula",
  BYN: "Belarusian Ruble",
  BZD: "Belize Dollar",
  CDF: "Congolese Franc",
  CRC: "Costa Rican Colón",
  CUP: "Cuban Peso",
  CVE: "Cape Verdean Escudo",
  DJF: "Djiboutian Franc",
  DOP: "Dominican Peso",
  DZD: "Algerian Dinar",
  EGP: "Egyptian Pound",
  ERN: "Eritrean Nakfa",
  ETB: "Ethiopian Birr",
  FJD: "Fijian Dollar",
  FKP: "Falkland Islands Pound",
  GEL: "Georgian Lari",
  GHS: "Ghanaian Cedi",
  GIP: "Gibraltar Pound",
  GMD: "Gambian Dalasi",
  GNF: "Guinean Franc",
  GTQ: "Guatemalan Quetzal",
  GYD: "Guyanaese Dollar",
  HNL: "Honduran Lempira",
  HTG: "Haitian Gourde",
  IQD: "Iraqi Dinar",
  IRR: "Iranian Rial",
  ISK: "Icelandic Króna",
  JMD: "Jamaican Dollar",
  JOD: "Jordanian Dinar",
  KES: "Kenyan Shilling",
  KHR: "Cambodian Riel",
  KMF: "Comorian Franc",
  KWD: "Kuwaiti Dinar",
  KYD: "Cayman Islands Dollar",
  KZT: "Kazakhstani Tenge",
  LAK: "Laotian Kip",
  LBP: "Lebanese Pound",
  LKR: "Sri Lankan Rupee",
  LRD: "Liberian Dollar",
  LSL: "Lesotho Loti",
  LYD: "Libyan Dinar",
  MAD: "Moroccan Dirham",
  MDL: "Moldovan Leu",
  MGA: "Malagasy Ariary",
  MKD: "Macedonian Denar",
  MMK: "Myanmar Kyat",
  MNT: "Mongolian Tugrik",
  MOP: "Macanese Pataca",
  MUR: "Mauritian Rupee",
  MVR: "Maldivian Rufiyaa",
  MWK: "Malawian Kwacha",
  MZN: "Mozambican Metical",
  NAD: "Namibian Dollar",
  NGN: "Nigerian Naira",
  NIO: "Nicaraguan Córdoba",
  NPR: "Nepalese Rupee",
  OMR: "Omani Rial",
  PAB: "Panamanian Balboa",
  PEN: "Peruvian Sol",
  PGK: "Papua New Guinean Kina",
  PKR: "Pakistani Rupee",
  PYG: "Paraguayan Guarani",
  QAR: "Qatari Riyal",
  RSD: "Serbian Dinar",
  RUB: "Russian Ruble",
  RWF: "Rwandan Franc",
  SAR: "Saudi Riyal",
  SBD: "Solomon Islands Dollar",
  SCR: "Seychellois Rupee",
  SDG: "Sudanese Pound",
  SLE: "Sierra Leonean Leone",
  SOS: "Somali Shilling",
  SRD: "Surinamese Dollar",
  STN: "São Tomé & Príncipe Dobra",
  SVC: "Salvadoran Colón",
  SYP: "Syrian Pound",
  SZL: "Swazi Lilangeni",
  TJS: "Tajikistani Somoni",
  TMT: "Turkmenistani Manat",
  TND: "Tunisian Dinar",
  TOP: "Tongan Paʻanga",
  TTD: "Trinidad & Tobago Dollar",
  TWD: "New Taiwan Dollar",
  TZS: "Tanzanian Shilling",
  UAH: "Ukrainian Hryvnia",
  UGX: "Ugandan Shilling",
  UYU: "Uruguayan Peso",
  UZS: "Uzbekistani Som",
  VES: "Venezuelan Bolívar",
  VND: "Vietnamese Dong",
  VUV: "Vanuatu Vatu",
  WST: "Samoan Tala",
  XAF: "Central African CFA Franc",
  XCD: "East Caribbean Dollar",
  XOF: "West African CFA Franc",
  XPF: "CFP Franc",
  YER: "Yemeni Rial",
  ZMW: "Zambian Kwacha",
};

export function currencyLabel(code: string): string {
  return CURRENCY_LABELS[code] ?? code;
}
