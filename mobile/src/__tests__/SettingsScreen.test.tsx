import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import SettingsScreen from "../screens/SettingsScreen";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { getServerUrl, setServerUrl } from "../api/client";

jest.mock("../api/client", () => ({
  getServerUrl: jest.fn(() => "http://localhost:3000"),
  setServerUrl: jest.fn(),
}));

const mockLock = jest.fn();
const mockSetBiometricEnabled = jest.fn();
const mockSetAutoLockMinutes = jest.fn();

jest.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    lock: mockLock,
    biometricAvailable: true,
    biometricEnabled: false,
    setBiometricEnabled: mockSetBiometricEnabled,
    autoLockMinutes: 5,
    setAutoLockMinutes: mockSetAutoLockMinutes,
  }),
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

describe("SettingsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders settings header", () => {
    const { getByText } = renderWithTheme(<SettingsScreen />);
    expect(getByText("Settings")).toBeTruthy();
  });

  it("shows CONNECTION section with server URL", () => {
    const { getByText, getByDisplayValue } = renderWithTheme(<SettingsScreen />);
    expect(getByText("CONNECTION")).toBeTruthy();
    expect(getByText("Server URL")).toBeTruthy();
    expect(getByDisplayValue("http://localhost:3000")).toBeTruthy();
  });

  it("shows SECURITY section", () => {
    const { getByText } = renderWithTheme(<SettingsScreen />);
    expect(getByText("SECURITY")).toBeTruthy();
    expect(getByText("Biometric Unlock")).toBeTruthy();
    expect(getByText("Auto-Lock After")).toBeTruthy();
  });

  it("shows ABOUT section", () => {
    const { getByText } = renderWithTheme(<SettingsScreen />);
    expect(getByText("ABOUT")).toBeTruthy();
    expect(getByText("PF Mobile")).toBeTruthy();
    expect(getByText("1.0.0")).toBeTruthy();
    expect(getByText("React Native + Expo")).toBeTruthy();
  });

  it("shows auto-lock options", () => {
    const { getByText } = renderWithTheme(<SettingsScreen />);
    expect(getByText("Disabled")).toBeTruthy();
    expect(getByText("1 min")).toBeTruthy();
    expect(getByText("5 min")).toBeTruthy();
    expect(getByText("15 min")).toBeTruthy();
    expect(getByText("30 min")).toBeTruthy();
  });

  it("shows Lock App Now button", () => {
    const { getByText } = renderWithTheme(<SettingsScreen />);
    expect(getByText("Lock App Now")).toBeTruthy();
  });

  it("calls setServerUrl on save", () => {
    const { getByText, getByDisplayValue } = renderWithTheme(<SettingsScreen />);

    const input = getByDisplayValue("http://localhost:3000");
    fireEvent.changeText(input, "http://myserver:3000");
    fireEvent.press(getByText("Save"));

    expect(setServerUrl).toHaveBeenCalledWith("http://myserver:3000");
  });

  it("shows footer text", () => {
    const { getByText } = renderWithTheme(<SettingsScreen />);
    expect(getByText("Privacy-first personal finance")).toBeTruthy();
  });
});
