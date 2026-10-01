// Performance / Dividends / Realized gains / Holding detail screens — currency
// correctness, empty states and refresh behaviour.
import React from "react";
import { ActivityIndicator, ScrollView, Switch } from "react-native";
import { render, waitFor, act } from "@testing-library/react-native";
import { useIsFocused } from "@react-navigation/native";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import PerformanceScreen from "../screens/PerformanceScreen";
import DividendsScreen from "../screens/DividendsScreen";
import RealizedGainsScreen from "../screens/RealizedGainsScreen";
import HoldingDetailScreen from "../screens/HoldingDetailScreen";
import { PERFORMANCE_EMPTY_TEXT } from "../components/portfolio/PerformanceChart";
import { endpoints } from "../api/client";
import type {
  DividendIncomeResult,
  EnrichedHolding,
  PortfolioHoldingSummary,
  PortfolioOverview,
  PortfolioPerformance,
  RealizedGainRow,
  RealizedGainsResult,
} from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: {
    getPortfolioPerformance: jest.fn(),
    getDividends: jest.fn(),
    getRealizedGains: jest.fn(),
    getPortfolioOverview: jest.fn(),
    getPortfolioLots: jest.fn(),
    getTransactions: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function withTheme(el: React.ReactElement) {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {el}
    </ThemeContext.Provider>
  );
}

const nav = { navigate: jest.fn(), goBack: jest.fn() };
function props<T>(params: unknown): T {
  return { navigation: nav, route: { params } } as unknown as T;
}

/** Fire the ScrollView's pull-to-refresh handler. */
async function pullToRefresh(UNSAFE_getByType: (t: unknown) => { props: Record<string, any> }) {
  const sv = UNSAFE_getByType(ScrollView);
  expect(sv.props.refreshControl).toBeTruthy();
  await act(async () => {
    sv.props.refreshControl.props.onRefresh();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (useIsFocused as jest.Mock).mockReturnValue(true);
});

// ─── Performance ────────────────────────────────────────────────────────────
function perf(series: PortfolioPerformance["series"]): PortfolioPerformance {
  return {
    period: "1y",
    accountId: null,
    from: "2025-10-01",
    to: "2026-10-01",
    currency: "USD",
    series,
    twrr: { period: 0, annualized: 0, hadContributions: false },
    mwrr: { irr: 0, converged: false },
    gapsFilledDays: 3,
  };
}

describe("PerformanceScreen", () => {
  type P = React.ComponentProps<typeof PerformanceScreen>;

  it("hides the return metrics and explains snapshots when there are < 2 points", async () => {
    (endpoints.getPortfolioPerformance as jest.Mock).mockResolvedValue({
      success: true,
      data: perf([{ date: "2026-10-01", marketValue: 100, costBasis: 90, contribution: 0, gapsFilled: false }]),
    });
    const { findByText, queryByText } = render(withTheme(<PerformanceScreen {...props<P>(undefined)} />));
    expect(await findByText(PERFORMANCE_EMPTY_TEXT)).toBeTruthy();
    expect(PERFORMANCE_EMPTY_TEXT).not.toMatch(/nightly —|build nightly/);
    expect(queryByText(/TWRR/)).toBeNull();
    expect(queryByText("+0.0%")).toBeNull();
    expect(queryByText(/gap-filled/)).toBeNull();
  });

  it("shows metrics + a gap-filled hint (not 'shown dashed') with 2+ points, and pull-to-refresh refetches", async () => {
    (endpoints.getPortfolioPerformance as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        ...perf([
          { date: "2026-09-01", marketValue: 100, costBasis: 90, contribution: 0, gapsFilled: false },
          { date: "2026-10-01", marketValue: 120, costBasis: 95, contribution: 0, gapsFilled: true },
        ]),
        twrr: { period: 0.2, annualized: 0.5, hadContributions: false },
      },
    });
    const { findByText, getByText, queryByText, UNSAFE_getByType } = render(
      withTheme(<PerformanceScreen {...props<P>(undefined)} />)
    );
    expect(await findByText("TWRR (1Y)")).toBeTruthy();
    expect(getByText("+20.0%")).toBeTruthy();
    expect(getByText(/3 days gap-filled/)).toBeTruthy();
    expect(queryByText(/shown dashed/)).toBeNull();
    await pullToRefresh(UNSAFE_getByType as never);
    expect(endpoints.getPortfolioPerformance).toHaveBeenCalledTimes(2);
  });
});

// ─── Dividends ──────────────────────────────────────────────────────────────
describe("DividendsScreen", () => {
  type P = React.ComponentProps<typeof DividendsScreen>;
  const reporting: DividendIncomeResult = {
    mode: "reporting",
    reportingCurrency: "EUR",
    groups: [
      // `currency` names the first row's native currency (it was unrated) —
      // the amount is still in the reporting currency.
      { bucket: "2026", label: "2026", amount: 1500, currency: "USD", rowCount: 3, reinvestedCount: 1, withholdingCount: 0, unratedCount: 1 },
    ],
    totals: { amount: 1500, rowCount: 4, byCurrency: { EUR: 1500 }, unratedCount: 1 },
    filter: {},
  };

  it("requests reporting mode and formats totals + groups in the reporting currency", async () => {
    (endpoints.getDividends as jest.Mock).mockResolvedValue({ success: true, data: reporting });
    const { findByText, getAllByText, getByText, queryByText } = render(
      withTheme(<DividendsScreen {...props<P>({ displayCurrency: "USD" })} />)
    );
    expect(await findByText("Total dividends (EUR)")).toBeTruthy();
    expect(endpoints.getDividends).toHaveBeenCalledWith("groupBy=year&reportingCurrency=1");
    // Hero total + the group row, both in EUR (never the group's native USD).
    expect(getAllByText(/€1,500/).length).toBe(2);
    expect(queryByText(/\$1,500/)).toBeNull();
    expect(getByText(/1 payment not yet converted to EUR/)).toBeTruthy();
    expect(getByText(/1 pending re-rate/)).toBeTruthy();
  });

  it("falls back to per-currency totals when the server answers in native mode", async () => {
    (endpoints.getDividends as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        groups: [],
        totals: { amount: 300, rowCount: 2, byCurrency: { USD: 200, CAD: 100 } },
        filter: {},
      },
    });
    const { findByText, getByText } = render(withTheme(<DividendsScreen {...props<P>(undefined)} />));
    expect(await findByText("$200 USD")).toBeTruthy();
    expect(getByText("C$100 CAD")).toBeTruthy();
  });

  it("supports pull-to-refresh", async () => {
    (endpoints.getDividends as jest.Mock).mockResolvedValue({ success: true, data: reporting });
    const { findByText, UNSAFE_getByType } = render(withTheme(<DividendsScreen {...props<P>(undefined)} />));
    await findByText("Total dividends (EUR)");
    await pullToRefresh(UNSAFE_getByType as never);
    expect(endpoints.getDividends).toHaveBeenCalledTimes(2);
  });
});

// ─── Realized gains ─────────────────────────────────────────────────────────
function closure(p: Partial<RealizedGainRow>): RealizedGainRow {
  return {
    closureId: 1,
    closeDate: "2026-05-01",
    closeTxId: 1,
    lotId: 1,
    holdingId: 1,
    holdingName: "Apple",
    accountId: 1,
    accountName: "Brokerage",
    qtyClosed: 10,
    proceedsPerShare: 150.5,
    costPerShare: 120.1235,
    realizedGain: 303.77,
    currency: "USD",
    openDate: "2026-04-19",
    daysHeld: 12,
    term: "short",
    closeKind: "sell",
    source: "live",
    ...p,
  };
}

describe("RealizedGainsScreen", () => {
  type P = React.ComponentProps<typeof RealizedGainsScreen>;
  const native: RealizedGainsResult = {
    rows: [
      closure({ closureId: 1 }),
      closure({ closureId: 2, holdingId: 2, holdingName: "Shopify", currency: "CAD", realizedGain: -50, closeKind: "short_close" }),
    ],
    totals: {
      realizedGain: 253.77, // mixed-currency sum — must never be shown
      qtyClosed: 20,
      rowCount: 2,
      byCurrency: { USD: { realizedGain: 303.77, qtyClosed: 10 }, CAD: { realizedGain: -50, qtyClosed: 10 } },
    },
    filter: {},
  };

  it("shows native totals per currency, never the mixed sum, with formatted per-share prices", async () => {
    (endpoints.getRealizedGains as jest.Mock).mockResolvedValue({ success: true, data: native });
    const { findByText, getByText, queryByText, getAllByText } = render(
      withTheme(<RealizedGainsScreen {...props<P>({ displayCurrency: "USD" })} />)
    );
    expect(await findByText("+$304 USD")).toBeTruthy();
    expect(getByText("-C$50 CAD")).toBeTruthy();
    expect(queryByText(/254/)).toBeNull();
    // FINLYNQ-183 toggle wording + the unified request param, not currency=base.
    expect(getByText("Show in USD")).toBeTruthy();
    const firstCall = (endpoints.getRealizedGains as jest.Mock).mock.calls[0][0] as string;
    expect(firstCall).not.toContain("unified");
    expect(firstCall).not.toContain("currency=base");
    // Per-share prices go through formatCurrency (2–4 decimals), no raw floats.
    expect(getAllByText(/\$120\.1235 → \$150\.50/).length).toBe(1);
    // Short-position closure badge doesn't clash with the "Short · 12d" term badge.
    expect(getByText("Short sale")).toBeTruthy();
    expect(getAllByText("Short · 12d").length).toBe(2);
  });

  it("requests unified=1 and shows the single converted total when toggled", async () => {
    (endpoints.getRealizedGains as jest.Mock).mockResolvedValue({ success: true, data: native });
    const { findByText, UNSAFE_getByType } = render(
      withTheme(<RealizedGainsScreen {...props<P>({ displayCurrency: "USD" })} />)
    );
    await findByText("+$304 USD");
    (endpoints.getRealizedGains as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        ...native,
        rows: native.rows.map((r) => ({ ...r, realizedGainInBase: r.currency === "CAD" ? -36.5 : r.realizedGain, baseCurrency: "USD" })),
        totalRealizedGainInBase: 267.27,
      },
    });
    await act(async () => {
      UNSAFE_getByType(Switch).props.onValueChange(true);
    });
    expect(await findByText("+$267")).toBeTruthy();
    const lastCall = (endpoints.getRealizedGains as jest.Mock).mock.calls.at(-1)[0] as string;
    expect(lastCall).toContain("unified=1");
  });

  it("supports pull-to-refresh", async () => {
    (endpoints.getRealizedGains as jest.Mock).mockResolvedValue({ success: true, data: native });
    const { findByText, UNSAFE_getByType } = render(withTheme(<RealizedGainsScreen {...props<P>(undefined)} />));
    await findByText("+$304 USD");
    await pullToRefresh(UNSAFE_getByType as never);
    expect(endpoints.getRealizedGains).toHaveBeenCalledTimes(2);
  });
});

// ─── Holding detail ─────────────────────────────────────────────────────────
function enriched(p: Partial<EnrichedHolding>): EnrichedHolding {
  return {
    id: 7,
    accountId: 1,
    accountName: "Brokerage",
    name: "NVDA",
    symbol: "NVDA",
    currency: "USD",
    assetType: "stock",
    price: null,
    change: null,
    changePct: null,
    quoteCurrency: "USD",
    marketCap: null,
    image: null,
    quantity: 10,
    avgCostPerShare: null,
    totalCostBasis: null,
    lifetimeCostBasis: null,
    marketValue: null,
    marketValueDisplay: 1000,
    unrealizedGain: null,
    unrealizedGainPct: null,
    unrealizedGainDisplay: null,
    realizedGain: null,
    dividendsReceived: null,
    totalReturn: null,
    totalReturnDisplay: null,
    totalReturnPct: null,
    firstPurchaseDate: null,
    daysHeld: null,
    pctOfPortfolio: null,
    ...p,
  };
}

const summary: PortfolioHoldingSummary = {
  key: "eq:NVDA",
  symbol: "NVDA",
  name: "NVDA",
  description: "NVIDIA Corporation",
  assetType: "stock",
  totalQty: 10,
  avgCostDisplay: 90.5,
  costBasisDisplay: 905,
  marketValueDisplay: 1000,
  unrealizedGainDisplay: 95,
  unrealizedGainPct: 10.5,
  realizedGainDisplay: 0,
  dividendsDisplay: 0,
  totalReturnDisplay: 95,
  totalReturnPct: 10.5,
  pctOfPortfolio: 100,
  accountCount: 1,
};

describe("HoldingDetailScreen", () => {
  type P = React.ComponentProps<typeof HoldingDetailScreen>;
  const params = { summary, members: [enriched({})], displayCurrency: "USD" };

  beforeEach(() => {
    (endpoints.getPortfolioLots as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        lots: [
          { lotId: 1, holdingId: 7, accountId: 1, openTxId: 1, openDate: "2026-01-02", qtyOriginal: 10, qtyRemaining: 10, qty: 10, costPerShare: 90.123456, costBasis: 901.23, currency: "USD", origin: "buy", status: "open", parentLotId: null },
        ],
      },
    });
    (endpoints.getTransactions as jest.Mock).mockResolvedValue({ success: true, data: [] });
  });

  it("formats lot cost per share and re-reads the overview row on refocus (after a Buy)", async () => {
    const after: PortfolioOverview = {
      displayCurrency: "USD",
      holdings: [enriched({ quantity: 15, marketValueDisplay: 1500 })],
      byHolding: [{ ...summary, totalQty: 15, marketValueDisplay: 1500 }],
      summary: {} as PortfolioOverview["summary"],
      byType: {},
      byAccount: {},
      topGainers: [],
      topLosers: [],
    };
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({ success: true, data: after });

    const ui = () => withTheme(<HoldingDetailScreen {...props<P>(params)} />);
    const { findByText, findAllByText, getAllByText, getByText, rerender, UNSAFE_queryAllByType } = render(ui());
    expect(await findByText("@ $90.1235")).toBeTruthy();
    // Header card + the per-account row.
    expect(getAllByText("$1,000")).toHaveLength(2);
    // First focus uses the route params; no overview round-trip yet.
    expect(endpoints.getPortfolioOverview).not.toHaveBeenCalled();

    // Back from the Buy form → refocus → background re-read of the overview row.
    (useIsFocused as jest.Mock).mockReturnValue(false);
    rerender(ui());
    (useIsFocused as jest.Mock).mockReturnValue(true);
    rerender(ui());
    expect(UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
    expect(await findAllByText("$1,500")).toHaveLength(2);
    expect(getByText("15 units @ avg cost")).toBeTruthy();
    await waitFor(() => expect(endpoints.getPortfolioLots).toHaveBeenCalledTimes(2));
  });

  it("supports pull-to-refresh", async () => {
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({ success: false, error: "x" });
    const { findByText, UNSAFE_getByType } = render(
      withTheme(<HoldingDetailScreen {...props<P>(params)} />)
    );
    await findByText("@ $90.1235");
    await pullToRefresh(UNSAFE_getByType as never);
    expect(endpoints.getPortfolioOverview).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(endpoints.getTransactions).toHaveBeenCalledTimes(2));
  });
});
