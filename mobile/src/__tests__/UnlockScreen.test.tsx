import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import UnlockScreen from "../screens/UnlockScreen";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

// Mock useAuth hook
const mockUnlock = jest.fn();
const mockBiometricUnlock = jest.fn();
let mockAuthState = {
  unlock: mockUnlock,
  biometricUnlock: mockBiometricUnlock,
  error: null as string | null,
  needsSetup: false,
  isLoading: false,
  biometricAvailable: false,
  biometricEnabled: false,
};

jest.mock("../hooks/useAuth", () => ({
  useAuth: () => mockAuthState,
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

describe("UnlockScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthState = {
      unlock: mockUnlock,
      biometricUnlock: mockBiometricUnlock,
      error: null,
      needsSetup: false,
      isLoading: false,
      biometricAvailable: false,
      biometricEnabled: false,
    };
  });

  it("renders welcome back message for existing users", () => {
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("Welcome Back")).toBeTruthy();
    expect(getByText("Enter your passphrase to unlock")).toBeTruthy();
  });

  it("renders setup message for new users", () => {
    mockAuthState.needsSetup = true;
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("Welcome to PF")).toBeTruthy();
    expect(getByText("Set up your passphrase to get started")).toBeTruthy();
  });

  it("shows PF logo", () => {
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("PF")).toBeTruthy();
  });

  it("calls unlock with passphrase on submit", () => {
    const { getByPlaceholderText, getByText } = renderWithTheme(
      <UnlockScreen isLoading={false} />
    );

    const input = getByPlaceholderText("Passphrase");
    fireEvent.changeText(input, "mypassword");
    fireEvent.press(getByText("Unlock"));

    expect(mockUnlock).toHaveBeenCalledWith("mypassword");
  });

  it("does not call unlock with empty passphrase", () => {
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);

    fireEvent.press(getByText("Unlock"));
    expect(mockUnlock).not.toHaveBeenCalled();
  });

  it("shows error message when error state is set", () => {
    mockAuthState.error = "Invalid passphrase";
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("Invalid passphrase")).toBeTruthy();
  });

  it("shows Set Up button for new users", () => {
    mockAuthState.needsSetup = true;
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("Set Up")).toBeTruthy();
  });

  it("shows biometric button when biometric is available and enabled", () => {
    mockAuthState.biometricAvailable = true;
    mockAuthState.biometricEnabled = true;
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("Unlock with Biometrics")).toBeTruthy();
  });

  it("does not show biometric button when biometric is not available", () => {
    mockAuthState.biometricAvailable = false;
    mockAuthState.biometricEnabled = true;
    const { queryByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(queryByText("Unlock with Biometrics")).toBeNull();
  });

  it("triggers biometric unlock on button press", () => {
    mockAuthState.biometricAvailable = true;
    mockAuthState.biometricEnabled = true;
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    fireEvent.press(getByText("Unlock with Biometrics"));
    expect(mockBiometricUnlock).toHaveBeenCalled();
  });

  it("shows show/hide toggle for passphrase", () => {
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("Show")).toBeTruthy();

    fireEvent.press(getByText("Show"));
    expect(getByText("Hide")).toBeTruthy();
  });

  it("shows 'or' divider when biometrics available", () => {
    mockAuthState.biometricAvailable = true;
    mockAuthState.biometricEnabled = true;
    const { getByText } = renderWithTheme(<UnlockScreen isLoading={false} />);
    expect(getByText("or")).toBeTruthy();
  });
});
