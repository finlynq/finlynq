// Feature 2: Live Portfolio Prices
// Feature 3: ETF Holdings Decomposition
// Uses Yahoo Finance v8 API (no API key needed)

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  getEtfInfoBySymbol,
  getEtfInfoAll,
  getEtfConstituentsBySymbol,
  getEtfRegionsBySymbol,
  getEtfSectorsBySymbol,
  seedEtfFromData,
} from "@/db/etf-db";

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance";

type QuoteResult = {
  symbol: string;
  price: number;
  currency: string;
  name: string;
  change: number;
  changePct: number;
  marketCap?: number;
};

export async function fetchQuote(symbol: string): Promise<QuoteResult | null> {
  try {
    const res = await fetch(
      `${YAHOO_BASE}/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta) return null;

    return {
      symbol,
      price: meta.regularMarketPrice ?? 0,
      currency: meta.currency ?? "USD",
      name: meta.shortName ?? symbol,
      change: (meta.regularMarketPrice ?? 0) - (meta.previousClose ?? 0),
      changePct: meta.previousClose
        ? (((meta.regularMarketPrice ?? 0) - meta.previousClose) / meta.previousClose) * 100
        : 0,
    };
  } catch {
    return null;
  }
}

export async function fetchMultipleQuotes(symbols: string[]): Promise<Map<string, QuoteResult>> {
  const results = new Map<string, QuoteResult>();
  const unique = [...new Set(symbols.filter(Boolean))];

  // Fetch in batches of 5 to avoid rate limiting
  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    const promises = batch.map((s) => fetchQuote(s));
    const quotes = await Promise.all(promises);
    quotes.forEach((q) => {
      if (q) results.set(q.symbol, q);
    });
  }

  return results;
}

// Cache prices in DB
export async function cachePrice(symbol: string, price: number, currency: string) {
  const today = new Date().toISOString().split("T")[0];
  const existing = db
    .select()
    .from(schema.priceCache)
    .where(and(eq(schema.priceCache.symbol, symbol), eq(schema.priceCache.date, today)))
    .get();

  if (existing) {
    db.update(schema.priceCache)
      .set({ price, currency })
      .where(eq(schema.priceCache.id, existing.id))
      .run();
  } else {
    db.insert(schema.priceCache).values({ symbol, date: today, price, currency }).run();
  }
}

export function getCachedPrice(symbol: string): { price: number; currency: string; date: string } | null {
  const row = db
    .select()
    .from(schema.priceCache)
    .where(eq(schema.priceCache.symbol, symbol))
    .orderBy(schema.priceCache.date)
    .limit(1)
    .get();

  return row ? { price: row.price, currency: row.currency, date: row.date } : null;
}

// Feature 3: ETF Holdings Decomposition (simplified)
// In production, you'd use Morningstar API. Here we use known ETF compositions.
const ETF_REGIONS: Record<string, Record<string, number>> = {
  "VCN.TO": { Canada: 100 },
  "VUN.TO": { US: 100 },
  "VIU.TO": { Europe: 45, Japan: 25, Asia: 20, Other: 10 },
  "VWRA.L": { US: 60, Europe: 15, Japan: 7, Asia: 8, Canada: 3, Other: 7 },
  "VWRD.L": { US: 60, Europe: 15, Japan: 7, Asia: 8, Canada: 3, Other: 7 },
  "VUAA.L": { US: 100 },
  "VUSD.L": { US: 100 },
  "VHYD.L": { US: 35, Europe: 30, Asia: 20, Other: 15 },
  "VHYA.L": { US: 35, Europe: 30, Asia: 20, Other: 15 },
  "VHVE.L": { US: 65, Europe: 18, Japan: 8, Other: 9 },
  "VFEA.L": { Asia: 40, Other: 60 },
  "VJPA.L": { Japan: 100 },
  "VJPU.L": { Japan: 100 },
  "VNRA.L": { US: 85, Canada: 15 },
  "V3AA.L": { US: 55, Europe: 18, Japan: 8, Asia: 9, Other: 10 },
  "VAPU.L": { Asia: 60, Other: 40 },
  VTI: { US: 100 },
  "TPE.TO": { Europe: 40, Japan: 25, Asia: 20, Other: 15 },
  "TPU.TO": { US: 100 },
};

const ETF_SECTORS: Record<string, Record<string, number>> = {
  "VCN.TO": { Financials: 35, Energy: 15, Tech: 10, Materials: 10, Industrials: 10, Other: 20 },
  "VUN.TO": { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
  "VIU.TO": { Financials: 20, Industrials: 16, Healthcare: 10, Consumer: 14, Tech: 10, Materials: 6, Energy: 5, Other: 19 },
  "VWRA.L": { Tech: 24, Financials: 16, Healthcare: 11, Consumer: 12, Industrials: 10, Energy: 5, Materials: 4, Other: 18 },
  "VWRD.L": { Tech: 24, Financials: 16, Healthcare: 11, Consumer: 12, Industrials: 10, Energy: 5, Materials: 4, Other: 18 },
  "VUAA.L": { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
  "VUSD.L": { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
  "VHYD.L": { Financials: 25, Consumer: 15, Industrials: 12, Energy: 12, Healthcare: 10, Tech: 6, Other: 20 },
  "VHYA.L": { Financials: 25, Consumer: 15, Industrials: 12, Energy: 12, Healthcare: 10, Tech: 6, Other: 20 },
  "VHVE.L": { Tech: 24, Financials: 16, Healthcare: 12, Consumer: 12, Industrials: 11, Energy: 5, Materials: 4, Other: 16 },
  "VFEA.L": { Financials: 22, Tech: 20, Consumer: 12, Industrials: 8, Materials: 8, Energy: 6, Healthcare: 5, Other: 19 },
  "VJPA.L": { Industrials: 22, Consumer: 18, Tech: 15, Financials: 10, Healthcare: 8, Materials: 6, Other: 21 },
  "VJPU.L": { Industrials: 22, Consumer: 18, Tech: 15, Financials: 10, Healthcare: 8, Materials: 6, Other: 21 },
  "VNRA.L": { Energy: 30, Materials: 20, Industrials: 15, Tech: 10, Financials: 10, Other: 15 },
  "V3AA.L": { Tech: 22, Financials: 16, Healthcare: 10, Consumer: 12, Industrials: 10, Energy: 5, Materials: 5, Other: 20 },
  "VAPU.L": { Tech: 22, Financials: 18, Consumer: 14, Industrials: 12, Materials: 8, Healthcare: 6, Other: 20 },
  VTI: { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
  "TPE.TO": { Financials: 20, Industrials: 16, Healthcare: 10, Consumer: 14, Tech: 10, Materials: 6, Energy: 5, Other: 19 },
  "TPU.TO": { Tech: 30, Healthcare: 13, Financials: 13, Consumer: 12, Industrials: 10, Other: 22 },
};

// ETF Top Holdings — stock-level look-through
// Source: Vanguard/iShares fund fact sheets (approximate weights)
export type EtfConstituent = {
  ticker: string;
  name: string;
  weight: number; // percentage
  sector: string;
  country: string;
};

// ── US Total Market / S&P 500 top ~150 constituents (~75% coverage) ──
const US_STOCKS: EtfConstituent[] = [
  // Mega-cap (top 15, ~38%)
  { ticker: "AAPL", name: "Apple Inc.", weight: 6.8, sector: "Tech", country: "US" },
  { ticker: "MSFT", name: "Microsoft Corp.", weight: 6.3, sector: "Tech", country: "US" },
  { ticker: "NVDA", name: "NVIDIA Corp.", weight: 5.2, sector: "Tech", country: "US" },
  { ticker: "AMZN", name: "Amazon.com Inc.", weight: 3.6, sector: "Consumer", country: "US" },
  { ticker: "META", name: "Meta Platforms Inc.", weight: 2.6, sector: "Tech", country: "US" },
  { ticker: "GOOGL", name: "Alphabet Inc. Class A", weight: 2.0, sector: "Tech", country: "US" },
  { ticker: "GOOG", name: "Alphabet Inc. Class C", weight: 1.7, sector: "Tech", country: "US" },
  { ticker: "BRK.B", name: "Berkshire Hathaway Inc.", weight: 1.7, sector: "Financials", country: "US" },
  { ticker: "AVGO", name: "Broadcom Inc.", weight: 1.5, sector: "Tech", country: "US" },
  { ticker: "LLY", name: "Eli Lilly & Co.", weight: 1.4, sector: "Healthcare", country: "US" },
  { ticker: "JPM", name: "JPMorgan Chase & Co.", weight: 1.3, sector: "Financials", country: "US" },
  { ticker: "TSLA", name: "Tesla Inc.", weight: 1.2, sector: "Consumer", country: "US" },
  { ticker: "XOM", name: "Exxon Mobil Corp.", weight: 1.1, sector: "Energy", country: "US" },
  { ticker: "UNH", name: "UnitedHealth Group Inc.", weight: 1.1, sector: "Healthcare", country: "US" },
  { ticker: "V", name: "Visa Inc.", weight: 0.9, sector: "Financials", country: "US" },
  // Large-cap #16-50 (~17%)
  { ticker: "MA", name: "Mastercard Inc.", weight: 0.8, sector: "Financials", country: "US" },
  { ticker: "COST", name: "Costco Wholesale Corp.", weight: 0.8, sector: "Consumer", country: "US" },
  { ticker: "PG", name: "Procter & Gamble Co.", weight: 0.8, sector: "Consumer", country: "US" },
  { ticker: "JNJ", name: "Johnson & Johnson", weight: 0.8, sector: "Healthcare", country: "US" },
  { ticker: "HD", name: "Home Depot Inc.", weight: 0.8, sector: "Consumer", country: "US" },
  { ticker: "NFLX", name: "Netflix Inc.", weight: 0.7, sector: "Consumer", country: "US" },
  { ticker: "ABBV", name: "AbbVie Inc.", weight: 0.7, sector: "Healthcare", country: "US" },
  { ticker: "CRM", name: "Salesforce Inc.", weight: 0.6, sector: "Tech", country: "US" },
  { ticker: "BAC", name: "Bank of America Corp.", weight: 0.6, sector: "Financials", country: "US" },
  { ticker: "CVX", name: "Chevron Corp.", weight: 0.6, sector: "Energy", country: "US" },
  { ticker: "MRK", name: "Merck & Co. Inc.", weight: 0.6, sector: "Healthcare", country: "US" },
  { ticker: "AMD", name: "Advanced Micro Devices", weight: 0.5, sector: "Tech", country: "US" },
  { ticker: "KO", name: "Coca-Cola Co.", weight: 0.5, sector: "Consumer", country: "US" },
  { ticker: "PEP", name: "PepsiCo Inc.", weight: 0.5, sector: "Consumer", country: "US" },
  { ticker: "TMO", name: "Thermo Fisher Scientific", weight: 0.5, sector: "Healthcare", country: "US" },
  { ticker: "LIN", name: "Linde PLC", weight: 0.5, sector: "Materials", country: "US" },
  { ticker: "WMT", name: "Walmart Inc.", weight: 0.5, sector: "Consumer", country: "US" },
  { ticker: "ADBE", name: "Adobe Inc.", weight: 0.5, sector: "Tech", country: "US" },
  { ticker: "CSCO", name: "Cisco Systems Inc.", weight: 0.5, sector: "Tech", country: "US" },
  { ticker: "ACN", name: "Accenture PLC", weight: 0.4, sector: "Tech", country: "US" },
  { ticker: "ABT", name: "Abbott Laboratories", weight: 0.4, sector: "Healthcare", country: "US" },
  { ticker: "WFC", name: "Wells Fargo & Co.", weight: 0.4, sector: "Financials", country: "US" },
  { ticker: "DHR", name: "Danaher Corp.", weight: 0.4, sector: "Healthcare", country: "US" },
  { ticker: "TXN", name: "Texas Instruments Inc.", weight: 0.4, sector: "Tech", country: "US" },
  { ticker: "ORCL", name: "Oracle Corp.", weight: 0.4, sector: "Tech", country: "US" },
  { ticker: "PM", name: "Philip Morris International", weight: 0.4, sector: "Consumer", country: "US" },
  { ticker: "QCOM", name: "Qualcomm Inc.", weight: 0.4, sector: "Tech", country: "US" },
  { ticker: "MS", name: "Morgan Stanley", weight: 0.3, sector: "Financials", country: "US" },
  { ticker: "INTC", name: "Intel Corp.", weight: 0.3, sector: "Tech", country: "US" },
  { ticker: "NEE", name: "NextEra Energy Inc.", weight: 0.3, sector: "Industrials", country: "US" },
  { ticker: "RTX", name: "RTX Corp.", weight: 0.3, sector: "Industrials", country: "US" },
  { ticker: "UPS", name: "United Parcel Service", weight: 0.3, sector: "Industrials", country: "US" },
  { ticker: "LOW", name: "Lowe's Companies Inc.", weight: 0.3, sector: "Consumer", country: "US" },
  { ticker: "AMAT", name: "Applied Materials Inc.", weight: 0.3, sector: "Tech", country: "US" },
  { ticker: "GS", name: "Goldman Sachs Group", weight: 0.3, sector: "Financials", country: "US" },
  // Mid/large-cap #51-100 (~11%)
  { ticker: "INTU", name: "Intuit Inc.", weight: 0.3, sector: "Tech", country: "US" },
  { ticker: "BKNG", name: "Booking Holdings Inc.", weight: 0.3, sector: "Consumer", country: "US" },
  { ticker: "BLK", name: "BlackRock Inc.", weight: 0.3, sector: "Financials", country: "US" },
  { ticker: "ISRG", name: "Intuitive Surgical Inc.", weight: 0.3, sector: "Healthcare", country: "US" },
  { ticker: "MDLZ", name: "Mondelez International", weight: 0.25, sector: "Consumer", country: "US" },
  { ticker: "ADP", name: "Automatic Data Processing", weight: 0.25, sector: "Tech", country: "US" },
  { ticker: "SYK", name: "Stryker Corp.", weight: 0.25, sector: "Healthcare", country: "US" },
  { ticker: "ADI", name: "Analog Devices Inc.", weight: 0.25, sector: "Tech", country: "US" },
  { ticker: "GILD", name: "Gilead Sciences Inc.", weight: 0.25, sector: "Healthcare", country: "US" },
  { ticker: "VRTX", name: "Vertex Pharmaceuticals", weight: 0.25, sector: "Healthcare", country: "US" },
  { ticker: "REGN", name: "Regeneron Pharmaceuticals", weight: 0.25, sector: "Healthcare", country: "US" },
  { ticker: "PANW", name: "Palo Alto Networks Inc.", weight: 0.25, sector: "Tech", country: "US" },
  { ticker: "LRCX", name: "Lam Research Corp.", weight: 0.25, sector: "Tech", country: "US" },
  { ticker: "SNPS", name: "Synopsys Inc.", weight: 0.22, sector: "Tech", country: "US" },
  { ticker: "CDNS", name: "Cadence Design Systems", weight: 0.22, sector: "Tech", country: "US" },
  { ticker: "CME", name: "CME Group Inc.", weight: 0.22, sector: "Financials", country: "US" },
  { ticker: "CB", name: "Chubb Ltd.", weight: 0.22, sector: "Financials", country: "US" },
  { ticker: "MMC", name: "Marsh & McLennan Cos.", weight: 0.22, sector: "Financials", country: "US" },
  { ticker: "KLAC", name: "KLA Corp.", weight: 0.22, sector: "Tech", country: "US" },
  { ticker: "PLD", name: "Prologis Inc.", weight: 0.22, sector: "Financials", country: "US" },
  { ticker: "SCHW", name: "Charles Schwab Corp.", weight: 0.22, sector: "Financials", country: "US" },
  { ticker: "MCD", name: "McDonald's Corp.", weight: 0.22, sector: "Consumer", country: "US" },
  { ticker: "BMY", name: "Bristol-Myers Squibb Co.", weight: 0.2, sector: "Healthcare", country: "US" },
  { ticker: "CI", name: "Cigna Group", weight: 0.2, sector: "Healthcare", country: "US" },
  { ticker: "EOG", name: "EOG Resources Inc.", weight: 0.2, sector: "Energy", country: "US" },
  { ticker: "SO", name: "Southern Company", weight: 0.2, sector: "Industrials", country: "US" },
  { ticker: "DUK", name: "Duke Energy Corp.", weight: 0.2, sector: "Industrials", country: "US" },
  { ticker: "ZTS", name: "Zoetis Inc.", weight: 0.2, sector: "Healthcare", country: "US" },
  { ticker: "USB", name: "U.S. Bancorp", weight: 0.2, sector: "Financials", country: "US" },
  { ticker: "PNC", name: "PNC Financial Services", weight: 0.2, sector: "Financials", country: "US" },
  { ticker: "EQIX", name: "Equinix Inc.", weight: 0.2, sector: "Tech", country: "US" },
  { ticker: "CL", name: "Colgate-Palmolive Co.", weight: 0.2, sector: "Consumer", country: "US" },
  { ticker: "ITW", name: "Illinois Tool Works Inc.", weight: 0.2, sector: "Industrials", country: "US" },
  { ticker: "APH", name: "Amphenol Corp.", weight: 0.2, sector: "Tech", country: "US" },
  { ticker: "MRVL", name: "Marvell Technology Inc.", weight: 0.2, sector: "Tech", country: "US" },
  { ticker: "FDX", name: "FedEx Corp.", weight: 0.18, sector: "Industrials", country: "US" },
  { ticker: "TGT", name: "Target Corp.", weight: 0.18, sector: "Consumer", country: "US" },
  { ticker: "EMR", name: "Emerson Electric Co.", weight: 0.18, sector: "Industrials", country: "US" },
  { ticker: "SLB", name: "Schlumberger Ltd.", weight: 0.18, sector: "Energy", country: "US" },
  { ticker: "PSX", name: "Phillips 66", weight: 0.18, sector: "Energy", country: "US" },
  { ticker: "MPC", name: "Marathon Petroleum Corp.", weight: 0.18, sector: "Energy", country: "US" },
  { ticker: "VLO", name: "Valero Energy Corp.", weight: 0.18, sector: "Energy", country: "US" },
  { ticker: "OXY", name: "Occidental Petroleum", weight: 0.15, sector: "Energy", country: "US" },
  { ticker: "COP", name: "ConocoPhillips", weight: 0.22, sector: "Energy", country: "US" },
  { ticker: "AIG", name: "American International Group", weight: 0.15, sector: "Financials", country: "US" },
  { ticker: "GM", name: "General Motors Co.", weight: 0.15, sector: "Consumer", country: "US" },
  { ticker: "F", name: "Ford Motor Co.", weight: 0.12, sector: "Consumer", country: "US" },
  // Mid-cap #101-150 (~8%)
  { ticker: "MCK", name: "McKesson Corp.", weight: 0.18, sector: "Healthcare", country: "US" },
  { ticker: "NXPI", name: "NXP Semiconductors NV", weight: 0.15, sector: "Tech", country: "US" },
  { ticker: "FTNT", name: "Fortinet Inc.", weight: 0.15, sector: "Tech", country: "US" },
  { ticker: "MCHP", name: "Microchip Technology", weight: 0.15, sector: "Tech", country: "US" },
  { ticker: "CRWD", name: "CrowdStrike Holdings", weight: 0.15, sector: "Tech", country: "US" },
  { ticker: "DXCM", name: "DexCom Inc.", weight: 0.12, sector: "Healthcare", country: "US" },
  { ticker: "ON", name: "ON Semiconductor Corp.", weight: 0.12, sector: "Tech", country: "US" },
  { ticker: "ROP", name: "Roper Technologies Inc.", weight: 0.15, sector: "Industrials", country: "US" },
  { ticker: "CTAS", name: "Cintas Corp.", weight: 0.15, sector: "Industrials", country: "US" },
  { ticker: "IDXX", name: "IDEXX Laboratories Inc.", weight: 0.12, sector: "Healthcare", country: "US" },
  { ticker: "ODFL", name: "Old Dominion Freight Line", weight: 0.12, sector: "Industrials", country: "US" },
  { ticker: "MNST", name: "Monster Beverage Corp.", weight: 0.12, sector: "Consumer", country: "US" },
  { ticker: "FAST", name: "Fastenal Co.", weight: 0.12, sector: "Industrials", country: "US" },
  { ticker: "AZO", name: "AutoZone Inc.", weight: 0.12, sector: "Consumer", country: "US" },
  { ticker: "CPRT", name: "Copart Inc.", weight: 0.12, sector: "Industrials", country: "US" },
  { ticker: "GWW", name: "W.W. Grainger Inc.", weight: 0.12, sector: "Industrials", country: "US" },
  { ticker: "ROST", name: "Ross Stores Inc.", weight: 0.12, sector: "Consumer", country: "US" },
  { ticker: "PAYX", name: "Paychex Inc.", weight: 0.1, sector: "Tech", country: "US" },
  { ticker: "EA", name: "Electronic Arts Inc.", weight: 0.1, sector: "Tech", country: "US" },
  { ticker: "MSCI", name: "MSCI Inc.", weight: 0.12, sector: "Financials", country: "US" },
  { ticker: "HLT", name: "Hilton Worldwide Holdings", weight: 0.12, sector: "Consumer", country: "US" },
  { ticker: "MAR", name: "Marriott International", weight: 0.12, sector: "Consumer", country: "US" },
  { ticker: "WELL", name: "Welltower Inc.", weight: 0.12, sector: "Financials", country: "US" },
  { ticker: "PSA", name: "Public Storage", weight: 0.1, sector: "Financials", country: "US" },
  { ticker: "AEP", name: "American Electric Power", weight: 0.1, sector: "Industrials", country: "US" },
  { ticker: "D", name: "Dominion Energy Inc.", weight: 0.1, sector: "Industrials", country: "US" },
  { ticker: "SRE", name: "Sempra Energy", weight: 0.1, sector: "Industrials", country: "US" },
  { ticker: "ALL", name: "Allstate Corp.", weight: 0.1, sector: "Financials", country: "US" },
  { ticker: "TRV", name: "Travelers Companies Inc.", weight: 0.1, sector: "Financials", country: "US" },
  { ticker: "ECL", name: "Ecolab Inc.", weight: 0.1, sector: "Materials", country: "US" },
  { ticker: "NEM", name: "Newmont Corp.", weight: 0.1, sector: "Materials", country: "US" },
  { ticker: "FCX", name: "Freeport-McMoRan Inc.", weight: 0.1, sector: "Materials", country: "US" },
  { ticker: "DOW", name: "Dow Inc.", weight: 0.1, sector: "Materials", country: "US" },
  { ticker: "DD", name: "DuPont de Nemours Inc.", weight: 0.1, sector: "Materials", country: "US" },
  { ticker: "WBA", name: "Walgreens Boots Alliance", weight: 0.08, sector: "Consumer", country: "US" },
  { ticker: "KHC", name: "Kraft Heinz Co.", weight: 0.08, sector: "Consumer", country: "US" },
  { ticker: "STZ", name: "Constellation Brands Inc.", weight: 0.1, sector: "Consumer", country: "US" },
  { ticker: "YUM", name: "Yum! Brands Inc.", weight: 0.1, sector: "Consumer", country: "US" },
  { ticker: "SBUX", name: "Starbucks Corp.", weight: 0.15, sector: "Consumer", country: "US" },
  { ticker: "NKE", name: "Nike Inc.", weight: 0.12, sector: "Consumer", country: "US" },
  { ticker: "DIS", name: "Walt Disney Co.", weight: 0.2, sector: "Consumer", country: "US" },
  { ticker: "CMCSA", name: "Comcast Corp.", weight: 0.2, sector: "Consumer", country: "US" },
  { ticker: "T", name: "AT&T Inc.", weight: 0.18, sector: "Tech", country: "US" },
  { ticker: "VZ", name: "Verizon Communications", weight: 0.18, sector: "Tech", country: "US" },
  { ticker: "TMUS", name: "T-Mobile US Inc.", weight: 0.22, sector: "Tech", country: "US" },
  { ticker: "NOW", name: "ServiceNow Inc.", weight: 0.22, sector: "Tech", country: "US" },
  { ticker: "UBER", name: "Uber Technologies Inc.", weight: 0.2, sector: "Tech", country: "US" },
  { ticker: "ABNB", name: "Airbnb Inc.", weight: 0.12, sector: "Consumer", country: "US" },
  { ticker: "SQ", name: "Block Inc.", weight: 0.1, sector: "Financials", country: "US" },
  { ticker: "PYPL", name: "PayPal Holdings Inc.", weight: 0.12, sector: "Financials", country: "US" },
  { ticker: "SNOW", name: "Snowflake Inc.", weight: 0.08, sector: "Tech", country: "US" },
  { ticker: "PLTR", name: "Palantir Technologies", weight: 0.15, sector: "Tech", country: "US" },
  { ticker: "COIN", name: "Coinbase Global Inc.", weight: 0.08, sector: "Financials", country: "US" },
  { ticker: "CAT", name: "Caterpillar Inc.", weight: 0.22, sector: "Industrials", country: "US" },
  { ticker: "DE", name: "Deere & Co.", weight: 0.2, sector: "Industrials", country: "US" },
  { ticker: "GE", name: "GE Aerospace", weight: 0.22, sector: "Industrials", country: "US" },
  { ticker: "HON", name: "Honeywell International", weight: 0.2, sector: "Industrials", country: "US" },
  { ticker: "BA", name: "Boeing Co.", weight: 0.15, sector: "Industrials", country: "US" },
  { ticker: "LMT", name: "Lockheed Martin Corp.", weight: 0.18, sector: "Industrials", country: "US" },
  { ticker: "GD", name: "General Dynamics Corp.", weight: 0.12, sector: "Industrials", country: "US" },
  { ticker: "NOC", name: "Northrop Grumman Corp.", weight: 0.1, sector: "Industrials", country: "US" },
  { ticker: "MMM", name: "3M Co.", weight: 0.1, sector: "Industrials", country: "US" },
  { ticker: "SPGI", name: "S&P Global Inc.", weight: 0.22, sector: "Financials", country: "US" },
  { ticker: "ICE", name: "Intercontinental Exchange", weight: 0.15, sector: "Financials", country: "US" },
  { ticker: "AON", name: "Aon PLC", weight: 0.12, sector: "Financials", country: "US" },
  { ticker: "MET", name: "MetLife Inc.", weight: 0.1, sector: "Financials", country: "US" },
  { ticker: "PRU", name: "Prudential Financial Inc.", weight: 0.1, sector: "Financials", country: "US" },
  { ticker: "AXP", name: "American Express Co.", weight: 0.18, sector: "Financials", country: "US" },
  { ticker: "COF", name: "Capital One Financial", weight: 0.1, sector: "Financials", country: "US" },
  { ticker: "ELV", name: "Elevance Health Inc.", weight: 0.15, sector: "Healthcare", country: "US" },
  { ticker: "HCA", name: "HCA Healthcare Inc.", weight: 0.12, sector: "Healthcare", country: "US" },
  { ticker: "MDT", name: "Medtronic PLC", weight: 0.15, sector: "Healthcare", country: "US" },
  { ticker: "BSX", name: "Boston Scientific Corp.", weight: 0.15, sector: "Healthcare", country: "US" },
  { ticker: "EW", name: "Edwards Lifesciences", weight: 0.1, sector: "Healthcare", country: "US" },
  { ticker: "AMGN", name: "Amgen Inc.", weight: 0.25, sector: "Healthcare", country: "US" },
  { ticker: "PFE", name: "Pfizer Inc.", weight: 0.15, sector: "Healthcare", country: "US" },
]; // sum ≈ 76%

// S&P 500 variant: slightly more concentrated (no small caps)
const SP500_STOCKS: EtfConstituent[] = US_STOCKS.map(s => ({
  ...s,
  weight: Math.round((s.weight * 1.05) * 100) / 100,
}));

// ── International developed markets top ~100 constituents (~55% coverage) ──
const INTL_STOCKS: EtfConstituent[] = [
  // Mega-cap international (top 25, ~25%)
  { ticker: "NOVO-B.CO", name: "Novo Nordisk A/S", weight: 2.4, sector: "Healthcare", country: "Denmark" },
  { ticker: "ASML.AS", name: "ASML Holding NV", weight: 2.1, sector: "Tech", country: "Netherlands" },
  { ticker: "NESN.SW", name: "Nestlé S.A.", weight: 1.5, sector: "Consumer", country: "Switzerland" },
  { ticker: "7203.T", name: "Toyota Motor Corp.", weight: 1.4, sector: "Consumer", country: "Japan" },
  { ticker: "AZN.L", name: "AstraZeneca PLC", weight: 1.3, sector: "Healthcare", country: "UK" },
  { ticker: "ROG.SW", name: "Roche Holding AG", weight: 1.2, sector: "Healthcare", country: "Switzerland" },
  { ticker: "SHEL.L", name: "Shell PLC", weight: 1.1, sector: "Energy", country: "UK" },
  { ticker: "MC.PA", name: "LVMH Moët Hennessy", weight: 1.0, sector: "Consumer", country: "France" },
  { ticker: "SAP.DE", name: "SAP SE", weight: 1.0, sector: "Tech", country: "Germany" },
  { ticker: "6758.T", name: "Sony Group Corp.", weight: 0.9, sector: "Tech", country: "Japan" },
  { ticker: "NOVN.SW", name: "Novartis AG", weight: 0.9, sector: "Healthcare", country: "Switzerland" },
  { ticker: "HSBA.L", name: "HSBC Holdings PLC", weight: 0.8, sector: "Financials", country: "UK" },
  { ticker: "SIE.DE", name: "Siemens AG", weight: 0.7, sector: "Industrials", country: "Germany" },
  { ticker: "8306.T", name: "Mitsubishi UFJ Financial", weight: 0.7, sector: "Financials", country: "Japan" },
  { ticker: "TTE.PA", name: "TotalEnergies SE", weight: 0.7, sector: "Energy", country: "France" },
  { ticker: "ULVR.L", name: "Unilever PLC", weight: 0.7, sector: "Consumer", country: "UK" },
  { ticker: "SNY", name: "Sanofi S.A.", weight: 0.6, sector: "Healthcare", country: "France" },
  { ticker: "OR.PA", name: "L'Oréal S.A.", weight: 0.6, sector: "Consumer", country: "France" },
  { ticker: "ALV.DE", name: "Allianz SE", weight: 0.6, sector: "Financials", country: "Germany" },
  { ticker: "ABI.BR", name: "Anheuser-Busch InBev", weight: 0.5, sector: "Consumer", country: "Belgium" },
  { ticker: "8035.T", name: "Tokyo Electron Ltd.", weight: 0.5, sector: "Tech", country: "Japan" },
  { ticker: "DTE.DE", name: "Deutsche Telekom AG", weight: 0.5, sector: "Tech", country: "Germany" },
  { ticker: "RIO.L", name: "Rio Tinto PLC", weight: 0.5, sector: "Materials", country: "UK" },
  { ticker: "AIR.PA", name: "Airbus SE", weight: 0.5, sector: "Industrials", country: "France" },
  { ticker: "RELX.L", name: "RELX PLC", weight: 0.5, sector: "Industrials", country: "UK" },
  // Large-cap #26-60 (~16%)
  { ticker: "6861.T", name: "Keyence Corp.", weight: 0.4, sector: "Tech", country: "Japan" },
  { ticker: "BHP.AX", name: "BHP Group Ltd.", weight: 0.4, sector: "Materials", country: "Australia" },
  { ticker: "IBE.MC", name: "Iberdrola S.A.", weight: 0.4, sector: "Industrials", country: "Spain" },
  { ticker: "9984.T", name: "SoftBank Group Corp.", weight: 0.4, sector: "Tech", country: "Japan" },
  { ticker: "BARC.L", name: "Barclays PLC", weight: 0.4, sector: "Financials", country: "UK" },
  { ticker: "VOW3.DE", name: "Volkswagen AG", weight: 0.3, sector: "Consumer", country: "Germany" },
  { ticker: "BAS.DE", name: "BASF SE", weight: 0.3, sector: "Materials", country: "Germany" },
  { ticker: "BP.L", name: "BP PLC", weight: 0.3, sector: "Energy", country: "UK" },
  { ticker: "9432.T", name: "Nippon Telegraph & Tel", weight: 0.3, sector: "Tech", country: "Japan" },
  { ticker: "GLEN.L", name: "Glencore PLC", weight: 0.3, sector: "Materials", country: "UK" },
  { ticker: "7741.T", name: "HOYA Corp.", weight: 0.3, sector: "Healthcare", country: "Japan" },
  { ticker: "IFX.DE", name: "Infineon Technologies", weight: 0.3, sector: "Tech", country: "Germany" },
  { ticker: "ADS.DE", name: "Adidas AG", weight: 0.3, sector: "Consumer", country: "Germany" },
  { ticker: "BATS.L", name: "British American Tobacco", weight: 0.3, sector: "Consumer", country: "UK" },
  { ticker: "6501.T", name: "Hitachi Ltd.", weight: 0.3, sector: "Industrials", country: "Japan" },
  { ticker: "8766.T", name: "Tokio Marine Holdings", weight: 0.3, sector: "Financials", country: "Japan" },
  { ticker: "6902.T", name: "Denso Corp.", weight: 0.25, sector: "Consumer", country: "Japan" },
  { ticker: "GSK.L", name: "GSK PLC", weight: 0.25, sector: "Healthcare", country: "UK" },
  { ticker: "BN.PA", name: "Danone S.A.", weight: 0.25, sector: "Consumer", country: "France" },
  { ticker: "ENI.MI", name: "Eni S.p.A.", weight: 0.25, sector: "Energy", country: "Italy" },
  { ticker: "PHIA.AS", name: "Koninklijke Philips NV", weight: 0.25, sector: "Healthcare", country: "Netherlands" },
  { ticker: "CFR.SW", name: "Compagnie Financière Richemont", weight: 0.25, sector: "Consumer", country: "Switzerland" },
  { ticker: "9433.T", name: "KDDI Corp.", weight: 0.25, sector: "Tech", country: "Japan" },
  { ticker: "RI.PA", name: "Pernod Ricard S.A.", weight: 0.2, sector: "Consumer", country: "France" },
  { ticker: "ENEL.MI", name: "Enel S.p.A.", weight: 0.2, sector: "Industrials", country: "Italy" },
  { ticker: "TEL.OL", name: "Telenor ASA", weight: 0.2, sector: "Tech", country: "Norway" },
  { ticker: "RACE.MI", name: "Ferrari N.V.", weight: 0.2, sector: "Consumer", country: "Italy" },
  { ticker: "KER.PA", name: "Kering S.A.", weight: 0.2, sector: "Consumer", country: "France" },
  { ticker: "MBG.DE", name: "Mercedes-Benz Group AG", weight: 0.2, sector: "Consumer", country: "Germany" },
  { ticker: "BMW.DE", name: "BMW AG", weight: 0.2, sector: "Consumer", country: "Germany" },
  { ticker: "LLOY.L", name: "Lloyds Banking Group PLC", weight: 0.2, sector: "Financials", country: "UK" },
  { ticker: "SAN.MC", name: "Banco Santander S.A.", weight: 0.2, sector: "Financials", country: "Spain" },
  { ticker: "ING.AS", name: "ING Groep NV", weight: 0.2, sector: "Financials", country: "Netherlands" },
  { ticker: "BNP.PA", name: "BNP Paribas S.A.", weight: 0.2, sector: "Financials", country: "France" },
  { ticker: "UBS.SW", name: "UBS Group AG", weight: 0.2, sector: "Financials", country: "Switzerland" },
  // Mid-cap international #61-100 (~12%)
  { ticker: "8058.T", name: "Mitsubishi Corp.", weight: 0.2, sector: "Industrials", country: "Japan" },
  { ticker: "4063.T", name: "Shin-Etsu Chemical Co.", weight: 0.2, sector: "Materials", country: "Japan" },
  { ticker: "8316.T", name: "Sumitomo Mitsui Financial", weight: 0.2, sector: "Financials", country: "Japan" },
  { ticker: "9983.T", name: "Fast Retailing Co.", weight: 0.2, sector: "Consumer", country: "Japan" },
  { ticker: "6367.T", name: "Daikin Industries Ltd.", weight: 0.15, sector: "Industrials", country: "Japan" },
  { ticker: "8031.T", name: "Mitsui & Co. Ltd.", weight: 0.15, sector: "Industrials", country: "Japan" },
  { ticker: "6098.T", name: "Recruit Holdings Co.", weight: 0.15, sector: "Industrials", country: "Japan" },
  { ticker: "CBA.AX", name: "Commonwealth Bank of Australia", weight: 0.3, sector: "Financials", country: "Australia" },
  { ticker: "CSL.AX", name: "CSL Ltd.", weight: 0.25, sector: "Healthcare", country: "Australia" },
  { ticker: "NAB.AX", name: "National Australia Bank", weight: 0.15, sector: "Financials", country: "Australia" },
  { ticker: "WBC.AX", name: "Westpac Banking Corp.", weight: 0.12, sector: "Financials", country: "Australia" },
  { ticker: "ANZ.AX", name: "ANZ Group Holdings", weight: 0.12, sector: "Financials", country: "Australia" },
  { ticker: "WDS.AX", name: "Woodside Energy Group", weight: 0.1, sector: "Energy", country: "Australia" },
  { ticker: "EXPN.L", name: "Experian PLC", weight: 0.15, sector: "Industrials", country: "UK" },
  { ticker: "NG.L", name: "National Grid PLC", weight: 0.15, sector: "Industrials", country: "UK" },
  { ticker: "DGE.L", name: "Diageo PLC", weight: 0.2, sector: "Consumer", country: "UK" },
  { ticker: "LSEG.L", name: "London Stock Exchange Group", weight: 0.15, sector: "Financials", country: "UK" },
  { ticker: "ARM.L", name: "ARM Holdings PLC", weight: 0.15, sector: "Tech", country: "UK" },
  { ticker: "CPG.L", name: "Compass Group PLC", weight: 0.15, sector: "Consumer", country: "UK" },
  { ticker: "FLTR.L", name: "Flutter Entertainment PLC", weight: 0.12, sector: "Consumer", country: "UK" },
  { ticker: "EL.PA", name: "EssilorLuxottica S.A.", weight: 0.15, sector: "Healthcare", country: "France" },
  { ticker: "SU.PA", name: "Schneider Electric SE", weight: 0.2, sector: "Industrials", country: "France" },
  { ticker: "AI.PA", name: "Air Liquide S.A.", weight: 0.2, sector: "Materials", country: "France" },
  { ticker: "VIV.PA", name: "Vivendi SE", weight: 0.1, sector: "Consumer", country: "France" },
  { ticker: "CS.PA", name: "AXA S.A.", weight: 0.15, sector: "Financials", country: "France" },
  { ticker: "ZURN.SW", name: "Zurich Insurance Group", weight: 0.15, sector: "Financials", country: "Switzerland" },
  { ticker: "ABBN.SW", name: "ABB Ltd.", weight: 0.2, sector: "Industrials", country: "Switzerland" },
  { ticker: "LONN.SW", name: "Lonza Group AG", weight: 0.1, sector: "Healthcare", country: "Switzerland" },
  { ticker: "SGRE.MC", name: "Siemens Gamesa Renewable", weight: 0.1, sector: "Industrials", country: "Spain" },
  { ticker: "NESTE.HE", name: "Neste Oyj", weight: 0.1, sector: "Energy", country: "Finland" },
  { ticker: "NOVO.ST", name: "Novo Nordisk A/S (SEK)", weight: 0.1, sector: "Healthcare", country: "Sweden" },
  { ticker: "VOLV-B.ST", name: "Volvo Group", weight: 0.12, sector: "Industrials", country: "Sweden" },
  { ticker: "ATCO-A.ST", name: "Atlas Copco AB", weight: 0.15, sector: "Industrials", country: "Sweden" },
  { ticker: "SAND.ST", name: "Sandvik AB", weight: 0.1, sector: "Industrials", country: "Sweden" },
  { ticker: "SPOT.ST", name: "Spotify Technology S.A.", weight: 0.1, sector: "Tech", country: "Sweden" },
]; // sum ≈ 55%

// ── Canadian market top 40 (~70% of TSX coverage) ──
const CA_STOCKS: EtfConstituent[] = [
  { ticker: "RY.TO", name: "Royal Bank of Canada", weight: 8.2, sector: "Financials", country: "Canada" },
  { ticker: "TD.TO", name: "Toronto-Dominion Bank", weight: 5.8, sector: "Financials", country: "Canada" },
  { ticker: "SHOP.TO", name: "Shopify Inc.", weight: 4.9, sector: "Tech", country: "Canada" },
  { ticker: "ENB.TO", name: "Enbridge Inc.", weight: 4.1, sector: "Energy", country: "Canada" },
  { ticker: "BN.TO", name: "Brookfield Corp.", weight: 3.8, sector: "Financials", country: "Canada" },
  { ticker: "CNR.TO", name: "Canadian National Railway", weight: 3.5, sector: "Industrials", country: "Canada" },
  { ticker: "BMO.TO", name: "Bank of Montreal", weight: 3.2, sector: "Financials", country: "Canada" },
  { ticker: "BNS.TO", name: "Bank of Nova Scotia", weight: 2.8, sector: "Financials", country: "Canada" },
  { ticker: "CP.TO", name: "Canadian Pacific Kansas City", weight: 2.6, sector: "Industrials", country: "Canada" },
  { ticker: "ATD.TO", name: "Alimentation Couche-Tard", weight: 2.3, sector: "Consumer", country: "Canada" },
  { ticker: "SU.TO", name: "Suncor Energy Inc.", weight: 2.1, sector: "Energy", country: "Canada" },
  { ticker: "CNQ.TO", name: "Canadian Natural Resources", weight: 2.0, sector: "Energy", country: "Canada" },
  { ticker: "MFC.TO", name: "Manulife Financial Corp.", weight: 1.9, sector: "Financials", country: "Canada" },
  { ticker: "CSU.TO", name: "Constellation Software Inc.", weight: 1.8, sector: "Tech", country: "Canada" },
  { ticker: "TRI.TO", name: "Thomson Reuters Corp.", weight: 1.6, sector: "Industrials", country: "Canada" },
  { ticker: "CM.TO", name: "CIBC", weight: 1.5, sector: "Financials", country: "Canada" },
  { ticker: "ABX.TO", name: "Barrick Gold Corp.", weight: 1.4, sector: "Materials", country: "Canada" },
  { ticker: "NTR.TO", name: "Nutrien Ltd.", weight: 1.3, sector: "Materials", country: "Canada" },
  { ticker: "WCN.TO", name: "Waste Connections Inc.", weight: 1.2, sector: "Industrials", country: "Canada" },
  { ticker: "IFC.TO", name: "Intact Financial Corp.", weight: 1.1, sector: "Financials", country: "Canada" },
  { ticker: "TRP.TO", name: "TC Energy Corp.", weight: 1.0, sector: "Energy", country: "Canada" },
  { ticker: "FNV.TO", name: "Franco-Nevada Corp.", weight: 0.9, sector: "Materials", country: "Canada" },
  { ticker: "QSR.TO", name: "Restaurant Brands Intl.", weight: 0.9, sector: "Consumer", country: "Canada" },
  { ticker: "SLF.TO", name: "Sun Life Financial Inc.", weight: 0.8, sector: "Financials", country: "Canada" },
  { ticker: "GWO.TO", name: "Great-West Lifeco Inc.", weight: 0.7, sector: "Financials", country: "Canada" },
  { ticker: "L.TO", name: "Loblaw Companies Ltd.", weight: 0.7, sector: "Consumer", country: "Canada" },
  { ticker: "FTS.TO", name: "Fortis Inc.", weight: 0.7, sector: "Industrials", country: "Canada" },
  { ticker: "WPM.TO", name: "Wheaton Precious Metals", weight: 0.6, sector: "Materials", country: "Canada" },
  { ticker: "IMO.TO", name: "Imperial Oil Ltd.", weight: 0.6, sector: "Energy", country: "Canada" },
  { ticker: "DOL.TO", name: "Dollarama Inc.", weight: 0.6, sector: "Consumer", country: "Canada" },
  { ticker: "FFH.TO", name: "Fairfax Financial Holdings", weight: 0.5, sector: "Financials", country: "Canada" },
  { ticker: "SAP.TO", name: "Saputo Inc.", weight: 0.5, sector: "Consumer", country: "Canada" },
  { ticker: "EMA.TO", name: "Emera Inc.", weight: 0.5, sector: "Industrials", country: "Canada" },
  { ticker: "AEM.TO", name: "Agnico Eagle Mines Ltd.", weight: 0.5, sector: "Materials", country: "Canada" },
  { ticker: "CCO.TO", name: "Cameco Corp.", weight: 0.4, sector: "Energy", country: "Canada" },
  { ticker: "MG.TO", name: "Magna International Inc.", weight: 0.4, sector: "Consumer", country: "Canada" },
  { ticker: "GIB-A.TO", name: "CGI Inc.", weight: 0.4, sector: "Tech", country: "Canada" },
  { ticker: "CAR-UN.TO", name: "Canadian Apartment REIT", weight: 0.3, sector: "Financials", country: "Canada" },
  { ticker: "RCI-B.TO", name: "Rogers Communications", weight: 0.3, sector: "Tech", country: "Canada" },
  { ticker: "BCE.TO", name: "BCE Inc.", weight: 0.3, sector: "Tech", country: "Canada" },
]; // sum ≈ 70%

const ETF_TOP_HOLDINGS: Record<string, { fullName: string; totalHoldings: number; constituents: EtfConstituent[] }> = {
  "VUN.TO": { fullName: "Vanguard US Total Market Index ETF (CAD-Hedged)", totalHoldings: 3700, constituents: US_STOCKS },
  VTI: { fullName: "Vanguard Total Stock Market ETF", totalHoldings: 3700, constituents: US_STOCKS },
  "TPU.TO": { fullName: "TD US Equity Index ETF", totalHoldings: 500, constituents: SP500_STOCKS },
  "VUAA.L": { fullName: "Vanguard S&P 500 UCITS ETF (Acc)", totalHoldings: 500, constituents: SP500_STOCKS },
  "VCN.TO": { fullName: "Vanguard FTSE Canada All Cap Index ETF", totalHoldings: 180, constituents: CA_STOCKS },
  "VIU.TO": { fullName: "Vanguard FTSE Developed All Cap ex NA Index ETF", totalHoldings: 3900, constituents: INTL_STOCKS },
  "TPE.TO": { fullName: "TD International Equity Index ETF", totalHoldings: 900, constituents: INTL_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 1.05 * 100) / 100 })) },
  "VWRA.L": {
    fullName: "Vanguard FTSE All-World UCITS ETF (Acc)", totalHoldings: 3700,
    constituents: [
      ...US_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.60 * 100) / 100 })),
      ...INTL_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.35 * 100) / 100 })),
    ],
  },
  "VWRD.L": {
    fullName: "Vanguard FTSE All-World UCITS ETF (Dist)", totalHoldings: 3700,
    constituents: [
      ...US_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.60 * 100) / 100 })),
      ...INTL_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.35 * 100) / 100 })),
    ],
  },
  "VHVE.L": {
    fullName: "Vanguard FTSE Developed World UCITS ETF", totalHoldings: 2100,
    constituents: [
      ...US_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.68 * 100) / 100 })),
      ...INTL_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.28 * 100) / 100 })),
    ],
  },
  "V3AA.L": {
    fullName: "Vanguard ESG Global All Cap UCITS ETF", totalHoldings: 5800,
    constituents: [
      ...US_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.55 * 100) / 100 })),
      ...INTL_STOCKS.map(s => ({ ...s, weight: Math.round(s.weight * 0.30 * 100) / 100 })),
    ],
  },
};

// ── Hardcoded accessors (used for seeding DB) ──────────────────────
export function getHardcodedEtfTopHoldings(symbol: string) {
  return ETF_TOP_HOLDINGS[symbol] ?? null;
}
export function getHardcodedEtfSymbols(): string[] {
  return [...new Set([...Object.keys(ETF_REGIONS), ...Object.keys(ETF_SECTORS), ...Object.keys(ETF_TOP_HOLDINGS)])];
}
export function getHardcodedEtfRegions(symbol: string) {
  return ETF_REGIONS[symbol] ?? null;
}
export function getHardcodedEtfSectors(symbol: string) {
  return ETF_SECTORS[symbol] ?? null;
}

// ── DB-backed accessors (fall back to hardcoded if ETF DB empty) ────────

export function getEtfTopHoldings(symbol: string): { fullName: string; totalHoldings: number; constituents: EtfConstituent[] } | null {
  try {
    const info = getEtfInfoBySymbol(symbol);
    if (info) {
      const rows = getEtfConstituentsBySymbol(symbol);
      if (rows.length > 0) {
        return {
          fullName: info.full_name,
          totalHoldings: info.total_holdings,
          constituents: rows,
        };
      }
    }
  } catch { /* ETF DB not ready, fall through */ }
  return ETF_TOP_HOLDINGS[symbol] ?? null;
}

export function getAvailableEtfSymbols(): string[] {
  try {
    const all = getEtfInfoAll();
    if (all.length > 0) return all.map(r => r.symbol);
  } catch { /* fall through */ }
  return [...new Set([...Object.keys(ETF_REGIONS), ...Object.keys(ETF_SECTORS), ...Object.keys(ETF_TOP_HOLDINGS)])];
}

export function getEtfRegionBreakdown(symbol: string): Record<string, number> | null {
  try {
    const rows = getEtfRegionsBySymbol(symbol);
    if (rows.length > 0) {
      const result: Record<string, number> = {};
      for (const r of rows) result[r.region] = r.weight;
      return result;
    }
  } catch { /* fall through */ }
  return ETF_REGIONS[symbol] ?? null;
}

export function getEtfSectorBreakdown(symbol: string): Record<string, number> | null {
  try {
    const rows = getEtfSectorsBySymbol(symbol);
    if (rows.length > 0) {
      const result: Record<string, number> = {};
      for (const r of rows) result[r.sector] = r.weight;
      return result;
    }
  } catch { /* fall through */ }
  return ETF_SECTORS[symbol] ?? null;
}

/**
 * Auto-seed an ETF into the shared ETF DB if it has hardcoded data but
 * isn't in the database yet. Called automatically when the portfolio API
 * encounters an ETF symbol not in the DB.
 */
export function autoSeedEtfIfMissing(symbol: string): boolean {
  try {
    const existing = getEtfInfoBySymbol(symbol);
    if (existing) return false; // already in DB

    const regions = ETF_REGIONS[symbol] ?? null;
    const sectors = ETF_SECTORS[symbol] ?? null;
    const holdings = ETF_TOP_HOLDINGS[symbol] ?? null;

    if (!regions && !sectors && !holdings) return false; // no hardcoded data

    seedEtfFromData(
      symbol,
      holdings?.fullName ?? symbol,
      holdings?.totalHoldings ?? 0,
      regions,
      sectors,
      holdings?.constituents ?? null,
    );
    return true;
  } catch {
    return false;
  }
}

export function aggregatePortfolioExposure(
  holdings: { symbol: string; value: number }[]
): { regions: Record<string, number>; sectors: Record<string, number>; totalValue: number } {
  const regions: Record<string, number> = {};
  const sectors: Record<string, number> = {};
  let totalValue = 0;

  for (const h of holdings) {
    if (!h.symbol) continue;
    totalValue += h.value;

    const regionBreakdown = getEtfRegionBreakdown(h.symbol);
    if (regionBreakdown) {
      for (const [region, pct] of Object.entries(regionBreakdown)) {
        regions[region] = (regions[region] ?? 0) + (h.value * pct) / 100;
      }
    }

    const sectorBreakdown = getEtfSectorBreakdown(h.symbol);
    if (sectorBreakdown) {
      for (const [sector, pct] of Object.entries(sectorBreakdown)) {
        sectors[sector] = (sectors[sector] ?? 0) + (h.value * pct) / 100;
      }
    }
  }

  if (totalValue > 0) {
    for (const k of Object.keys(regions)) regions[k] = Math.round((regions[k] / totalValue) * 1000) / 10;
    for (const k of Object.keys(sectors)) sectors[k] = Math.round((sectors[k] / totalValue) * 1000) / 10;
  }

  return { regions, sectors, totalValue };
}
