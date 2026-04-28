import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import ImportScreen from "../screens/ImportScreen";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

jest.mock("../api/client", () => ({
  getServerUrl: jest.fn(() => "http://localhost:3000"),
}));

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: jest.fn(),
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(component: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={theme}>{component}</ThemeContext.Provider>
  );
}

describe("ImportScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders import header", () => {
    const { getByText } = renderWithTheme(<ImportScreen />);
    expect(getByText("Import")).toBeTruthy();
  });

  it("shows file picker UI in initial state", () => {
    const { getByText } = renderWithTheme(<ImportScreen />);
    expect(getByText("Import Transactions")).toBeTruthy();
    expect(getByText("Supports CSV, Excel, OFX, and PDF files")).toBeTruthy();
    expect(getByText("Choose File")).toBeTruthy();
  });

  it("shows drop zone icon", () => {
    const { getByText } = renderWithTheme(<ImportScreen />);
    expect(getByText("↓")).toBeTruthy();
  });

  it("handles cancelled file picker", async () => {
    const DocumentPicker = require("expo-document-picker");
    DocumentPicker.getDocumentAsync.mockResolvedValue({ canceled: true });

    const { getByText } = renderWithTheme(<ImportScreen />);
    fireEvent.press(getByText("Choose File"));

    // Should remain on the pick step
    await waitFor(() => {
      expect(getByText("Choose File")).toBeTruthy();
    });
  });
});
