/**
 * @vitest-environment jsdom
 *
 * Holdings by Account: Hide empty (2026-10-14, owner request). Rows with no
 * current position (no units, no value) can be hidden like on All Holdings,
 * and an account left with none drops out. The account header still totals
 * every holding, so realized gains on closed positions keep counting.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HoldingsByAccount, isEmptyHoldingRow } from "@/app/(app)/portfolio/_components/holdings-by-account";
import type { EnrichedHolding } from "@/app/(app)/portfolio/_types";

const holding = (over: Partial<EnrichedHolding>): EnrichedHolding =>
  ({
    id: 1,
    accountId: 1,
    accountName: "Brokerage",
    name: "Fund",
    symbol: "FND",
    securityName: null,
    quoteName: null,
    assetType: "stock",
    quantity: 10,
    marketValueDisplay: 1000,
    unrealizedGainDisplay: 100,
    realizedGainDisplay: 0,
    costBasisDisplay: 900,
    changePct: null,
    dayChangeDisplay: null,
    image: null,
    ...over,
  }) as EnrichedHolding;

const groups: [string, EnrichedHolding[]][] = [
  [
    "Brokerage",
    [
      holding({ id: 1, symbol: "VCN.TO" }),
      holding({ id: 2, symbol: "OLD", quantity: 0, marketValueDisplay: null, unrealizedGainDisplay: null, realizedGainDisplay: 250 }),
    ],
  ],
  [
    "CanadaLife",
    [holding({ id: 3, accountName: "CanadaLife", symbol: "LEIG", quantity: 0, marketValueDisplay: 0, unrealizedGainDisplay: null, realizedGainDisplay: 26 })],
  ],
];

afterEach(cleanup);

function renderCard(hideEmpty: boolean, setHideEmpty = vi.fn()) {
  render(
    <HoldingsByAccount
      accountGroups={groups}
      expandedAccounts={new Set()}
      toggleAccount={() => {}}
      displayCurrency="CAD"
      hideEmpty={hideEmpty}
      setHideEmpty={setHideEmpty}
    />,
  );
  return setHideEmpty;
}

describe("HoldingsByAccount — Hide empty", () => {
  it("counts a row empty only with no units and no value", () => {
    expect(isEmptyHoldingRow({ quantity: 0, marketValueDisplay: null })).toBe(true);
    expect(isEmptyHoldingRow({ quantity: null, marketValueDisplay: 0 })).toBe(true);
    expect(isEmptyHoldingRow({ quantity: 0, marketValueDisplay: 12 })).toBe(false);
    expect(isEmptyHoldingRow({ quantity: -3, marketValueDisplay: -150 })).toBe(false); // a real short stays
  });

  it("hides empty rows and accounts with nothing held, but keeps their realized gain in the totals", () => {
    renderCard(true);
    expect(screen.getByText("Brokerage")).toBeTruthy();
    expect(screen.getByText("1 holding")).toBeTruthy();
    expect(screen.getByText("1 empty hidden")).toBeTruthy();
    expect(screen.queryByText("CanadaLife")).toBeNull();
    expect(screen.getByText(/1 account with nothing held hidden/)).toBeTruthy();
    // Realized on the Brokerage header includes the hidden closed position.
    expect(screen.getByText(/\+C\$250\.00/)).toBeTruthy();
  });

  it("shows everything when switched to Showing all", () => {
    renderCard(false);
    expect(screen.getByText("CanadaLife")).toBeTruthy();
    expect(screen.getByText("2 holdings")).toBeTruthy();
    expect(screen.queryByText(/empty hidden/)).toBeNull();
  });

  it("the toggle flips the setting", () => {
    const set = renderCard(true);
    fireEvent.click(screen.getByText("Hiding empty"));
    expect(set).toHaveBeenCalledWith(false);
  });
});
