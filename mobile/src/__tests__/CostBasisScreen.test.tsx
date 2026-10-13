import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import CostBasisScreen from "../screens/CostBasisScreen";
import {
  COST_BASIS_METHODS,
  costBasisMismatchNote,
  costBasisNoteLabel,
  costBasisSavedNote,
} from "../lib/portfolio/cost-basis";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { LotAllocationStatus } from "../../../shared/types";

jest.mock("../api/client", () => ({
  endpoints: { getLotAllocation: jest.fn(), setLotAllocation: jest.fn() },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function screen() {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <CostBasisScreen />
    </ThemeContext.Provider>
  );
}

const getMethod = endpoints.getLotAllocation as jest.Mock;
const setMethod = endpoints.setLotAllocation as jest.Mock;
const status = (over: Partial<LotAllocationStatus> = {}): LotAllocationStatus => ({
  enabled: false,
  positions: 7,
  withoutLots: 0,
  mismatched: 0,
  ...over,
});
const ok = (data: LotAllocationStatus) => ({ success: true, data });

beforeEach(() => jest.clearAllMocks());

describe("cost-basis wording", () => {
  it("offers the two methods, simple first", () => {
    expect(COST_BASIS_METHODS.map((m) => [m.enabled, m.name])).toEqual([
      [false, "Simple"],
      [true, "Advanced lot allocation"],
    ]);
  });

  it("names the method in use", () => {
    expect(costBasisNoteLabel(false)).toBe("simple average");
    expect(costBasisNoteLabel(true)).toBe("advanced lot allocation");
  });

  it("says what a switch did, including lots built on the way in", () => {
    expect(costBasisSavedNote(false)).toBe("Back to the simple method. Your lots are kept.");
    expect(costBasisSavedNote(true)).toBe("Advanced lot allocation is on.");
    expect(costBasisSavedNote(true, 1)).toBe(
      "Advanced lot allocation is on. Lots were built for 1 position that had none.",
    );
    expect(costBasisSavedNote(true, 3)).toMatch(/for 3 positions that had none/);
  });

  // Lots that do not add up only matter while lots are the method in use.
  it("warns about positions whose lots do not add up, only on lot allocation", () => {
    expect(costBasisMismatchNote(true, 0)).toBeNull();
    expect(costBasisMismatchNote(false, 2)).toBeNull();
    expect(costBasisMismatchNote(true, 1)).toMatch(/^1 position has lots .* so its cost basis may be off\. Open it /);
    expect(costBasisMismatchNote(true, 2)).toMatch(/^2 positions have lots .* so their cost basis may be off\. Open them /);
  });
});

describe("CostBasisScreen", () => {
  it("marks the method in use and explains both", async () => {
    getMethod.mockResolvedValue(ok(status()));
    const { getByText, getAllByText } = render(screen());
    await waitFor(() => expect(getByText("In use")).toBeTruthy());
    // Each name appears on its option and again in the worked example.
    expect(getAllByText("Simple").length).toBeGreaterThan(0);
    expect(getAllByText("Advanced lot allocation").length).toBeGreaterThan(0);
    expect(getByText("Example")).toBeTruthy();
    expect(getByText("4,000")).toBeTruthy();
    expect(getByText("5,000")).toBeTruthy();
  });

  it("switches to lot allocation and says what happened", async () => {
    getMethod.mockResolvedValue(ok(status()));
    setMethod.mockResolvedValue(ok(status({ enabled: true, rebuilt: 2 })));
    const { getByText, findByText } = render(screen());
    await waitFor(() => expect(getByText("In use")).toBeTruthy());
    fireEvent.press(getByText(/Each sale is matched to specific purchases/));
    expect(await findByText(/Lots were built for 2 positions that had none/)).toBeTruthy();
    expect(setMethod).toHaveBeenCalledWith(true);
    expect(setMethod).toHaveBeenCalledTimes(1);
  });

  it("switches back to simple", async () => {
    getMethod.mockResolvedValue(ok(status({ enabled: true })));
    setMethod.mockResolvedValue(ok(status({ enabled: false })));
    const { getByText, findByText } = render(screen());
    await waitFor(() => expect(getByText("In use")).toBeTruthy());
    fireEvent.press(getByText(/The average price of every purchase/));
    expect(await findByText("Back to the simple method. Your lots are kept.")).toBeTruthy();
    expect(setMethod).toHaveBeenCalledWith(false);
  });

  it("tapping the method already in use saves nothing", async () => {
    getMethod.mockResolvedValue(ok(status()));
    const { getByText } = render(screen());
    await waitFor(() => expect(getByText("In use")).toBeTruthy());
    fireEvent.press(getByText(/The average price of every purchase/));
    expect(setMethod).not.toHaveBeenCalled();
  });

  // A second tap while the first is still saving must not send a second switch.
  it("does not send a second switch while one is in flight", async () => {
    getMethod.mockResolvedValue(ok(status()));
    let finish: (v: unknown) => void = () => {};
    setMethod.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { getByText, findByText } = render(screen());
    await waitFor(() => expect(getByText("In use")).toBeTruthy());
    fireEvent.press(getByText(/Each sale is matched to specific purchases/));
    fireEvent.press(getByText(/Each sale is matched to specific purchases/));
    expect(await findByText("Saving…")).toBeTruthy();
    expect(setMethod).toHaveBeenCalledTimes(1);
    finish(ok(status({ enabled: true })));
    expect(await findByText("Advanced lot allocation is on.")).toBeTruthy();
  });

  it("keeps the method and shows the server's message when a switch fails", async () => {
    getMethod.mockResolvedValue(ok(status()));
    setMethod.mockResolvedValue({ success: false, error: "Session locked. Sign in again." });
    const { getByText, findByText, queryByText } = render(screen());
    await waitFor(() => expect(getByText("In use")).toBeTruthy());
    fireEvent.press(getByText(/Each sale is matched to specific purchases/));
    expect(await findByText("Session locked. Sign in again.")).toBeTruthy();
    expect(queryByText(/Advanced lot allocation is on/)).toBeNull();
  });

  it("warns when lots do not add up while lot allocation is in use", async () => {
    getMethod.mockResolvedValue(ok(status({ enabled: true, mismatched: 1 })));
    const { findByText } = render(screen());
    expect(await findByText(/1 position has lots that do not add up/)).toBeTruthy();
  });

  // A server from before the setting existed: say so, offer a retry, and still
  // explain the two methods.
  it("says a current server is needed when the setting cannot be read", async () => {
    getMethod.mockResolvedValue({ success: false, error: "HTTP 404" });
    const { findByText, getByText, queryByText } = render(screen());
    expect(await findByText("HTTP 404")).toBeTruthy();
    expect(getByText(/needs a current Finlynq server/)).toBeTruthy();
    expect(queryByText("In use")).toBeNull();
    expect(getByText("Example")).toBeTruthy();

    getMethod.mockResolvedValue(ok(status()));
    fireEvent.press(getByText("Try again"));
    expect(await findByText("In use")).toBeTruthy();
  });
});
