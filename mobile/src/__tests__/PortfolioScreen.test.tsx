import React from "react";
import { ActivityIndicator } from "react-native";
import { render, waitFor } from "@testing-library/react-native";
import { useIsFocused } from "@react-navigation/native";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import PortfolioScreen from "../screens/PortfolioScreen";
import { endpoints } from "../api/client";
import type { PortfolioOverview, PortfolioHoldingSummary } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: { getPortfolioOverview: jest.fn() },
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

function renderWithTheme(el: React.ReactElement) {
  return render(withTheme(el));
}

const nvda: PortfolioHoldingSummary = {
  key: "eq:NVDA",
  symbol: "NVDA",
  name: "Nvidia",
  description: "NVIDIA Corporation",
  assetType: "stock",
  totalQty: 40,
  avgCostDisplay: 300,
  costBasisDisplay: 12000,
  marketValueDisplay: 14210,
  unrealizedGainDisplay: 2210,
  unrealizedGainPct: 18.4,
  realizedGainDisplay: 0,
  dividendsDisplay: 0,
  totalReturnDisplay: 2210,
  totalReturnPct: 18.4,
  pctOfPortfolio: 60,
  accountCount: 1,
};

const overview: PortfolioOverview = {
  displayCurrency: "CAD",
  holdings: [],
  byHolding: [nvda],
  summary: {
    totalHoldings: 1,
    totalAccounts: 1,
    totalValueDisplay: 248310,
    dayChangeDisplay: 642,
    dayChangePct: 0.3,
    hasQuantityData: true,
    totalCostBasisDisplay: 230106,
    totalUnrealizedGainDisplay: 18204,
    totalUnrealizedGainPct: 7.9,
    totalRealizedGainDisplay: 3940,
    totalDividendsDisplay: 1205,
    totalReturnDisplay: 23349,
    totalReturnPct: 10.1,
  },
  byType: {
    etf: { count: 2, value: 134000 },
    stock: { count: 3, value: 77000 },
    crypto: { count: 1, value: 22000 },
    cash: { count: 1, value: 15310 },
  },
  byAccount: { RRSP: { count: 4, value: 150000 }, TFSA: { count: 3, value: 98310 } },
  topGainers: [],
  topLosers: [],
};

describe("PortfolioScreen", () => {
  const nav = { navigate: jest.fn() };
  const props = {
    navigation: nav,
    route: { params: undefined },
  } as unknown as React.ComponentProps<typeof PortfolioScreen>;

  beforeEach(() => {
    jest.clearAllMocks();
    (useIsFocused as jest.Mock).mockReturnValue(true);
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({
      success: true,
      data: overview,
    });
  });

  it("renders the returns grid + a holding row from the overview fixture", async () => {
    const { findByText, getByText } = renderWithTheme(
      <PortfolioScreen {...props} />
    );
    // Async fetch resolves → the investment-returns section + holding appear.
    expect(await findByText("Investment returns")).toBeTruthy();
    expect(getByText("Market value")).toBeTruthy();
    // FINLYNQ-242: the holding row now leads with the description; the ticker
    // drops to the subtitle (combined with the units).
    expect(getByText("NVIDIA Corporation")).toBeTruthy();
    expect(getByText("NVDA · 40 units")).toBeTruthy();
  });

  it("shows an error state when the fetch fails", async () => {
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({
      success: false,
      error: "Unauthorized",
    });
    const { findByText } = renderWithTheme(
      <PortfolioScreen {...props} />
    );
    await waitFor(() => expect(endpoints.getPortfolioOverview).toHaveBeenCalled());
    expect(await findByText("Unauthorized")).toBeTruthy();
  });

  it("renders server Movers with the display-currency day change, sign-toned, null % omitted", async () => {
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        ...overview,
        displayCurrency: "USD",
        topGainers: [
          { key: "eq:NVDA", symbol: "NVDA", name: "NVDA", image: null, dayChangeDisplay: 1234.4, changePct: 2.5 },
        ],
        topLosers: [
          // changePct null (no prior-day value): tone still comes from the $ sign.
          { key: "metal:XAU", symbol: "XAU", name: "XAU", image: null, dayChangeDisplay: -56.2, changePct: null },
        ],
      },
    });
    const { findByText, getByText, queryByText } = renderWithTheme(<PortfolioScreen {...props} />);
    expect(await findByText("Top movers")).toBeTruthy();
    // Not "+$0" — the consolidated dayChangeDisplay, in the display currency.
    const gain = getByText("+$1,234");
    expect(gain.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: lightColors.pos })]));
    expect(getByText("+2.5%")).toBeTruthy();
    const loss = getByText("-$56");
    expect(loss.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: lightColors.neg })]));
    expect(queryByText(/NaN|null/)).toBeNull();
  });

  it("includes metals in the by-type allocation donut", async () => {
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({
      success: true,
      data: { ...overview, byType: { ...overview.byType, metal: { count: 1, value: 20000 } } },
    });
    const { findByText } = renderWithTheme(<PortfolioScreen {...props} />);
    expect(await findByText("Metals")).toBeTruthy();
  });

  it("does not emit duplicate React keys when two rows share a legacy key", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (endpoints.getPortfolioOverview as jest.Mock).mockResolvedValue({
      success: true,
      data: { ...overview, byHolding: [nvda, { ...nvda, totalQty: 5, description: "Nvidia (legacy)" }] },
    });
    const { findByText } = renderWithTheme(<PortfolioScreen {...props} />);
    expect(await findByText("Nvidia (legacy)")).toBeTruthy();
    const dupWarnings = errSpy.mock.calls.filter((c) => String(c[0]).includes("same key"));
    expect(dupWarnings).toHaveLength(0);
    errSpy.mockRestore();
  });

  it("refreshes in the background on refocus — content stays, no full-screen spinner", async () => {
    const { findByText, getByText, rerender, UNSAFE_queryAllByType } = renderWithTheme(
      <PortfolioScreen {...props} />
    );
    expect(await findByText("NVIDIA Corporation")).toBeTruthy();

    let resolveRefetch: (v: unknown) => void = () => {};
    (endpoints.getPortfolioOverview as jest.Mock).mockReturnValue(
      new Promise((r) => {
        resolveRefetch = r;
      })
    );
    (useIsFocused as jest.Mock).mockReturnValue(false);
    rerender(withTheme(<PortfolioScreen {...props} />));
    (useIsFocused as jest.Mock).mockReturnValue(true);
    rerender(withTheme(<PortfolioScreen {...props} />));

    await waitFor(() => expect(endpoints.getPortfolioOverview).toHaveBeenCalledTimes(2));
    // Refetch in flight: the list is still on screen, no spinner.
    expect(getByText("NVIDIA Corporation")).toBeTruthy();
    expect(UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);

    resolveRefetch({ success: false, error: "Server down" });
    // A failed background refresh keeps the content and says so.
    expect(await findByText("Could not refresh: Server down")).toBeTruthy();
    expect(getByText("NVIDIA Corporation")).toBeTruthy();
  });
});
