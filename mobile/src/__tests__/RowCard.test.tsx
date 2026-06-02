import React from "react";
import { render } from "@testing-library/react-native";
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
});
