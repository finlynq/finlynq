// Benchmark comparison library
// Compares portfolio performance against major market indices

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance";

export const BENCHMARK_INDICES = [
  { symbol: "^GSPC", name: "S&P 500", color: "#6366f1" },
  { symbol: "^GSPTSE", name: "S&P/TSX Composite", color: "#10b981" },
  { symbol: "^IXIC", name: "NASDAQ Composite", color: "#f59e0b" },
  { symbol: "AGG", name: "US Aggregate Bond", color: "#64748b" },
] as const;

export type BenchmarkReturn = {
  symbol: string;
  name: string;
  color: string;
  returnPct: number;
  series: { date: string; value: number }[];
};

function getPeriodDates(period: string): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();

  switch (period) {
    case "ytd":
      start.setMonth(0, 1);
      break;
    case "1y":
      start.setFullYear(start.getFullYear() - 1);
      break;
    case "3y":
      start.setFullYear(start.getFullYear() - 3);
      break;
    case "5y":
      start.setFullYear(start.getFullYear() - 5);
      break;
    default:
      start.setFullYear(start.getFullYear() - 1);
  }

  return { start, end };
}

export async function getBenchmarkReturns(
  symbol: string,
  start: Date,
  end: Date
): Promise<{ returnPct: number; series: { date: string; value: number }[] } | null> {
  try {
    const period1 = Math.floor(start.getTime() / 1000);
    const period2 = Math.floor(end.getTime() / 1000);
    const url = `${YAHOO_BASE}/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1wk`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];

    if (timestamps.length === 0 || closes.length === 0) return null;

    // Find first valid close price
    let basePrice: number | null = null;
    for (const c of closes) {
      if (c != null) {
        basePrice = c;
        break;
      }
    }
    if (basePrice === null) return null;

    const series: { date: string; value: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      // Normalize to percentage change from start (base = 100)
      series.push({ date, value: Math.round(((close / basePrice) * 100 - 100) * 100) / 100 });
    }

    const lastValue = series.length > 0 ? series[series.length - 1].value : 0;
    return { returnPct: lastValue, series };
  } catch {
    return null;
  }
}

export async function getAllBenchmarkReturns(
  period: string
): Promise<BenchmarkReturn[]> {
  const { start, end } = getPeriodDates(period);
  const results: BenchmarkReturn[] = [];

  for (const idx of BENCHMARK_INDICES) {
    const data = await getBenchmarkReturns(idx.symbol, start, end);
    if (data) {
      results.push({
        symbol: idx.symbol,
        name: idx.name,
        color: idx.color,
        returnPct: data.returnPct,
        series: data.series,
      });
    }
  }

  return results;
}

export function comparePortfolioToBenchmark(
  portfolioReturns: number[],
  benchmarkReturns: number[]
): { alpha: number; trackingError: number } {
  if (portfolioReturns.length === 0 || benchmarkReturns.length === 0) {
    return { alpha: 0, trackingError: 0 };
  }

  const minLen = Math.min(portfolioReturns.length, benchmarkReturns.length);
  const pReturns = portfolioReturns.slice(0, minLen);
  const bReturns = benchmarkReturns.slice(0, minLen);

  // Alpha = average excess return (portfolio - benchmark)
  const excessReturns = pReturns.map((p, i) => p - bReturns[i]);
  const alpha = excessReturns.reduce((s, v) => s + v, 0) / excessReturns.length;

  // Tracking error = standard deviation of excess returns
  const meanExcess = alpha;
  const variance =
    excessReturns.reduce((s, v) => s + Math.pow(v - meanExcess, 2), 0) /
    (excessReturns.length - 1 || 1);
  const trackingError = Math.sqrt(variance);

  return {
    alpha: Math.round(alpha * 100) / 100,
    trackingError: Math.round(trackingError * 100) / 100,
  };
}
