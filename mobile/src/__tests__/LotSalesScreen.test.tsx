import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import LotSalesScreen from "../screens/LotSalesScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { HoldingLot, LotClosure, LotReassignPreview } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: { getHoldingLots: jest.fn(), getLotAllocation: jest.fn(), reassignLots: jest.fn() },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

const lot = (over: Partial<HoldingLot>): HoldingLot => ({
  id: 1,
  accountId: 5,
  openTxId: 100,
  openDate: "2026-01-10",
  side: "long",
  origin: "buy",
  status: "open",
  qtyOriginal: 100,
  qtyRemaining: 100,
  costPerShare: 10,
  currency: "USD",
  ...over,
});

const closure = (over: Partial<LotClosure> = {}): LotClosure => ({
  id: 1,
  lotId: 1,
  closeTxId: 500,
  closeDate: "2026-06-01",
  qtyClosed: 100,
  proceedsPerShare: 25,
  costPerShare: 10,
  realizedGain: 1500,
  currency: "USD",
  closeKind: "sell",
  ...over,
});

// Bought 100 at 10, then 100 at 20; sold 100 (first in, first out used the
// first purchase up); then bought 100 at 30 after the sale.
const lots = [
  lot({ id: 1, openDate: "2026-01-10", costPerShare: 10, qtyRemaining: 0, status: "closed" }),
  lot({ id: 2, openDate: "2026-02-10", costPerShare: 20 }),
  lot({ id: 3, openDate: "2026-07-10", costPerShare: 30 }),
];

const getLots = endpoints.getHoldingLots as jest.Mock;
const getMethod = endpoints.getLotAllocation as jest.Mock;
const reassign = endpoints.reassignLots as jest.Mock;
const goBack = jest.fn();
const navigate = jest.fn();

const previewOf = (delta: Record<string, number>, short: { qty: number; currency: string }[] = []) => ({
  success: true,
  data: {
    preview: { proposedClosures: [], openedShortLots: short, realizedGainDeltaByYear: delta } as LotReassignPreview,
    committed: false,
  },
});

function screen() {
  const props = {
    navigation: { goBack, navigate },
    route: { params: { holdingId: 7, accountId: 5, title: "VTI", accountName: "Brokerage" } },
  } as unknown as React.ComponentProps<typeof LotSalesScreen>;
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <LotSalesScreen {...props} />
    </ThemeContext.Provider>
  );
}

const FROM_JAN = "Units from the purchase on 2026-01-10";
const FROM_FEB = "Units from the purchase on 2026-02-10";

beforeEach(() => {
  jest.clearAllMocks();
  getLots.mockResolvedValue({ success: true, data: { lots, closures: [closure()] } });
  getMethod.mockResolvedValue({ success: true, data: { enabled: true } });
  reassign.mockResolvedValue(previewOf({ "2026": -1000 }));
});

describe("LotSalesScreen", () => {
  it("lists each sale with its gain and the purchases it was matched to", async () => {
    const { findByText, getByText } = render(screen());
    expect(await findByText("2026-06-01")).toBeTruthy();
    expect(getByText("+$1,500")).toBeTruthy();
    expect(getByText(/Sold 100 units @ \$25\.00/)).toBeTruthy();
    expect(getByText("100 from 2026-01-10 @ $10.00")).toBeTruthy();
    expect(getByText("VTI · Brokerage")).toBeTruthy();
    expect(getLots).toHaveBeenCalledWith(7, 5);
  });

  it("says so when nothing has been sold", async () => {
    getLots.mockResolvedValue({ success: true, data: { lots, closures: [] } });
    const { findByText } = render(screen());
    expect(await findByText("Nothing has been sold from this position yet.")).toBeTruthy();
  });

  it("shows the server's message when the lots cannot be loaded", async () => {
    getLots.mockResolvedValue({ success: false, error: "Session locked. Sign in again." });
    const { findByText } = render(screen());
    expect(await findByText("Session locked. Sign in again.")).toBeTruthy();
  });

  // On the simple method, lots do not drive the figures; the user is told and
  // shown where to change that.
  it("says when the simple method is in use, and leads to the setting", async () => {
    getMethod.mockResolvedValue({ success: true, data: { enabled: false } });
    const { findByLabelText } = render(screen());
    fireEvent.press(await findByLabelText("Cost basis method"));
    expect(navigate).toHaveBeenCalledWith("CostBasis");
  });

  it("says nothing about the method when lots are in use", async () => {
    const { findByText, queryByLabelText } = render(screen());
    await findByText("2026-06-01");
    expect(queryByLabelText("Cost basis method")).toBeNull();
  });

  // The server tolerates this (records entered out of order) and flags it.
  it("points out a sale matched to a purchase made after it", async () => {
    getLots.mockResolvedValue({
      success: true,
      data: { lots, closures: [closure({ lotId: 3, costPerShare: 30, realizedGain: -500, openAfterClose: true })] },
    });
    const { findByText } = render(screen());
    expect(await findByText(/matched to a purchase made after it\. Change its lots/)).toBeTruthy();
  });

  it("says nothing of the kind for an ordinary sale", async () => {
    const { findByText, queryByText } = render(screen());
    await findByText("2026-06-01");
    expect(queryByText(/purchase made after it/)).toBeNull();
  });

  // A transfer out moves lots along with the shares; there is nothing to choose.
  it("offers to change the lots of a sale only", async () => {
    getLots.mockResolvedValue({ success: true, data: { lots, closures: [closure({ closeKind: "transfer_out" })] } });
    const { findByText, queryByText } = render(screen());
    expect(await findByText(/transfer out 100 units/)).toBeTruthy();
    expect(queryByText("Change lots")).toBeNull();
  });
});

describe("LotSalesScreen: changing which lots a sale used", () => {
  const open = async () => {
    const utils = render(screen());
    fireEvent.press(await utils.findByLabelText("Change the lots of the sale on 2026-06-01"));
    return utils;
  };

  it("starts from the sale's current lots and offers the purchases made by then", async () => {
    const { getByLabelText, queryByLabelText, getByText } = await open();
    // The purchase the sale used up is listed, with what the sale takes from it.
    expect(getByLabelText(FROM_JAN).props.value).toBe("100");
    expect(getByLabelText(FROM_FEB).props.value).toBe("");
    // A purchase made after the sale cannot have been sold in it.
    expect(queryByLabelText("Units from the purchase on 2026-07-10")).toBeNull();
    expect(getByText("100 of 100 units chosen")).toBeTruthy();
  });

  it("does not ask the server until something has changed and the units add up", async () => {
    const { getByLabelText, getByText } = await open();
    // Nothing changed yet.
    fireEvent.press(getByLabelText("Preview the change"));
    expect(reassign).not.toHaveBeenCalled();
    // Changed, but 60 + 30 is not the 100 that were sold.
    fireEvent.changeText(getByLabelText(FROM_JAN), "60");
    fireEvent.changeText(getByLabelText(FROM_FEB), "30");
    expect(getByText("90 of 100 units chosen")).toBeTruthy();
    fireEvent.press(getByLabelText("Preview the change"));
    expect(reassign).not.toHaveBeenCalled();
  });

  it("shows what the change does before saving it, then saves it", async () => {
    const { getByLabelText, findByText, queryByLabelText } = await open();
    fireEvent.changeText(getByLabelText(FROM_JAN), "0");
    fireEvent.changeText(getByLabelText(FROM_FEB), "100");
    fireEvent.press(getByLabelText("Preview the change"));
    await waitFor(() =>
      expect(reassign).toHaveBeenCalledWith(7, {
        closeTxId: 500,
        perLotQty: [{ lotId: 2, qty: 100 }],
        preview: true,
      }),
    );
    // Selling the shares bought at 20 instead of 10 lowers the gain by 1,000.
    expect(await findByText("Realized gain in 2026: -$1,000")).toBeTruthy();

    reassign.mockResolvedValue({ success: true, data: { preview: previewOf({}).data.preview, committed: true } });
    fireEvent.press(getByLabelText("Save the new lots"));
    await waitFor(() =>
      expect(reassign).toHaveBeenLastCalledWith(7, {
        closeTxId: 500,
        perLotQty: [{ lotId: 2, qty: 100 }],
        preview: false,
      }),
    );
    expect(await findByText("The sale now uses the lots you chose.")).toBeTruthy();
    // Back on the list, read again from the server.
    expect(queryByLabelText(FROM_JAN)).toBeNull();
    expect(getLots).toHaveBeenCalledTimes(2);
  });

  // A preview describes one exact choice; a different choice needs a new one.
  it("drops the preview when the choice changes, so it cannot be saved unseen", async () => {
    const { getByLabelText, findByLabelText, queryByLabelText } = await open();
    fireEvent.changeText(getByLabelText(FROM_JAN), "0");
    fireEvent.changeText(getByLabelText(FROM_FEB), "100");
    fireEvent.press(getByLabelText("Preview the change"));
    await findByLabelText("Save the new lots");
    fireEvent.changeText(getByLabelText(FROM_JAN), "40");
    expect(queryByLabelText("Save the new lots")).toBeNull();
    expect(getByLabelText("Preview the change")).toBeTruthy();
  });

  it("warns when a choice would record a short sale", async () => {
    reassign.mockResolvedValue(previewOf({ "2026": -500 }, [{ qty: 20, currency: "USD" }]));
    const { getByLabelText, findByText } = await open();
    fireEvent.changeText(getByLabelText(FROM_JAN), "0");
    fireEvent.changeText(getByLabelText(FROM_FEB), "100");
    fireEvent.press(getByLabelText("Preview the change"));
    expect(await findByText(/20 units would be recorded as sold\s+short/)).toBeTruthy();
  });

  it("keeps the choice on screen with the server's reason when it is refused", async () => {
    reassign.mockResolvedValue({ success: false, error: "That purchase does not hold enough units." });
    const { getByLabelText, findByText } = await open();
    fireEvent.changeText(getByLabelText(FROM_JAN), "0");
    fireEvent.changeText(getByLabelText(FROM_FEB), "100");
    fireEvent.press(getByLabelText("Preview the change"));
    expect(await findByText("That purchase does not hold enough units.")).toBeTruthy();
    expect(getByLabelText(FROM_FEB).props.value).toBe("100");
  });

  it("goes back to the list without changing anything on Cancel", async () => {
    const { getByText, getByLabelText, queryByLabelText } = await open();
    fireEvent.changeText(getByLabelText(FROM_JAN), "0");
    fireEvent.press(getByText("Cancel"));
    expect(queryByLabelText(FROM_JAN)).toBeNull();
    expect(getByText("Change lots")).toBeTruthy();
    expect(reassign).not.toHaveBeenCalled();
  });
});

// Server rules from 2026-10-14: a sale that sold more than was held carries
// that part as "Sold short" (sent as lot 0, counted in the total), a sale whose
// short a later purchase closed can't be changed, and a purchase made after
// the sale can keep only what the sale already takes from it.
describe("LotSalesScreen: shorts and purchases made after a sale", () => {
  // Bought 100 in January (used up by the sale) and 100 in February (entered
  // later, still held); sold 150 on 2026-06-01, the last 50 short (lot 9).
  const shortLot = (qtyRemaining: number) =>
    lot({ id: 9, openTxId: 500, openDate: "2026-06-01", side: "short", costPerShare: 25, qtyOriginal: 50, qtyRemaining });
  const withShort = (qtyRemaining: number) => ({
    success: true,
    data: {
      lots: [lots[0], lots[1], shortLot(qtyRemaining)],
      closures: [closure({}), ...(qtyRemaining < 50 ? [closure({ id: 2, lotId: 9, closeTxId: 600, closeDate: "2026-07-01", qtyClosed: 50 - qtyRemaining, closeKind: "short_close", realizedGain: 300 })] : [])],
    },
  });

  it("counts the short in the sale and in the form, and sends it as lot 0", async () => {
    getLots.mockResolvedValue(withShort(50));
    const { findByText, getByLabelText, getByText } = render(screen());
    expect(await findByText(/Sold 150 units @ \$25\.00 · 50 of them sold short/)).toBeTruthy();

    fireEvent.press(getByLabelText("Change the lots of the sale on 2026-06-01"));
    expect(getByLabelText("Units sold short").props.value).toBe("50");
    expect(getByText("150 of 150 units chosen")).toBeTruthy();

    // Match the short part to the February purchase instead.
    fireEvent.changeText(getByLabelText("Units sold short"), "0");
    fireEvent.changeText(getByLabelText(FROM_FEB), "50");
    fireEvent.press(getByLabelText("Preview the change"));
    await waitFor(() =>
      expect(reassign).toHaveBeenCalledWith(7, {
        closeTxId: 500,
        perLotQty: [
          { lotId: 1, qty: 100 },
          { lotId: 2, qty: 50 },
        ],
        preview: true,
      }),
    );
  });

  it("explains, and offers no change, once a later purchase closed part of the short", async () => {
    getLots.mockResolvedValue(withShort(20));
    const { findByText, queryByLabelText } = render(screen());
    expect(await findByText(/A later purchase already closed 30 of the units this sale sold short/)).toBeTruthy();
    expect(queryByLabelText("Change the lots of the sale on 2026-06-01")).toBeNull();
  });

  it("won't ask a purchase made after the sale for more than the sale already takes from it", async () => {
    // Entered out of order: the sale took 40 from the July purchase.
    getLots.mockResolvedValue({
      success: true,
      data: {
        lots: [lots[0], lots[1], lot({ id: 3, openDate: "2026-07-10", costPerShare: 30, qtyRemaining: 60 })],
        closures: [closure({ qtyClosed: 60 }), closure({ id: 2, lotId: 3, qtyClosed: 40, costPerShare: 30, openAfterClose: true })],
      },
    });
    const { findByLabelText, getByLabelText, getByText } = render(screen());
    fireEvent.press(await findByLabelText("Change the lots of the sale on 2026-06-01"));
    const FROM_JUL = "Units from the purchase on 2026-07-10";
    expect(getByLabelText(FROM_JUL).props.value).toBe("40");
    expect(getByText(/Bought after this sale: it can keep up to 40 units, not more\./)).toBeTruthy();

    // 50 + 50 adds up, but asks the July purchase for more than it keeps.
    fireEvent.changeText(getByLabelText(FROM_JAN), "50");
    fireEvent.changeText(getByLabelText(FROM_JUL), "50");
    expect(getByText("100 of 100 units chosen")).toBeTruthy();
    fireEvent.press(getByLabelText("Preview the change"));
    expect(reassign).not.toHaveBeenCalled();

    // Moving shares OFF it is fine.
    fireEvent.changeText(getByLabelText(FROM_JUL), "0");
    fireEvent.changeText(getByLabelText(FROM_FEB), "50");
    fireEvent.press(getByLabelText("Preview the change"));
    await waitFor(() => expect(reassign).toHaveBeenCalled());
  });
});
