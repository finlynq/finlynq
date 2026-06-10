import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { RowCard } from "../components/inbox/RowCard";

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(el: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {el}
    </ThemeContext.Provider>,
  );
}

const bank = { id: "b1", date: "2026-05-02", amount: -25.5, currency: "CAD", payee: "Coffee Shop" };

describe("RowCard", () => {
  it("renders the payee and an Approve action when a suggestion exists", () => {
    const { getByText } = renderWithTheme(
      <RowCard
        bank={bank}
        suggestion={{ kind: "create", categoryId: 7, categoryName: "Dining" }}
        busy={false}
        onPrimary={() => {}}
        onChooseCategory={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(getByText("Coffee Shop")).toBeTruthy();
    expect(getByText("Approve")).toBeTruthy();
  });

  it("renders 'transfer to <name>' + an Approve action for a transfer suggestion", () => {
    const { getByText } = renderWithTheme(
      <RowCard
        bank={bank}
        suggestion={{ kind: "transfer", destAccountId: 2, destAccountName: "Savings" }}
        busy={false}
        onPrimary={() => {}}
        onChooseCategory={() => {}}
        onDelete={() => {}}
      />,
    );
    // "transfer to " and the bold account name render as separate text nodes.
    expect(getByText(/transfer to/)).toBeTruthy();
    expect(getByText("Savings")).toBeTruthy();
    expect(getByText("Approve")).toBeTruthy();
  });

  it("shows Categorize + the no-match line when there's no suggestion", () => {
    const { getByText } = renderWithTheme(
      <RowCard
        bank={bank}
        suggestion={null}
        busy={false}
        onPrimary={() => {}}
        onChooseCategory={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(getByText("Categorize")).toBeTruthy();
    expect(getByText("No match — choose a category")).toBeTruthy();
  });

  it("warns + offers Link to existing / Keep separate when a duplicate is flagged", () => {
    const onLinkExisting = jest.fn();
    const { getByText, queryByText } = renderWithTheme(
      <RowCard
        bank={bank}
        suggestion={{ kind: "create", categoryId: 7, categoryName: "Dining" }}
        duplicate={{
          transactionId: 42,
          txPayee: "Coffee Shop",
          txDate: "2026-05-01",
          txAmount: -25.5,
          txCurrency: "CAD",
        }}
        busy={false}
        onPrimary={() => {}}
        onChooseCategory={() => {}}
        onDelete={() => {}}
        onLinkExisting={onLinkExisting}
      />,
    );
    expect(getByText(/Possible duplicate of an existing transaction/)).toBeTruthy();
    expect(getByText("Link to existing")).toBeTruthy();
    expect(getByText("Keep separate")).toBeTruthy();
    // The plain one-tap Approve is replaced by the duplicate-resolution choice.
    expect(queryByText("Approve")).toBeNull();
    fireEvent.press(getByText("Link to existing"));
    expect(onLinkExisting).toHaveBeenCalledTimes(1);
  });
});
