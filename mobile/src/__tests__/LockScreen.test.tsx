import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import LockScreen from "../screens/LockScreen";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderWithTheme(component: React.ReactElement) {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      {component}
    </ThemeContext.Provider>
  );
}

describe("LockScreen", () => {
  it("renders welcome + Finlynq unlock copy", () => {
    const { getByText } = renderWithTheme(
      <LockScreen onBiometricUnlock={jest.fn()} onSignOut={jest.fn()} />
    );
    expect(getByText("Welcome back")).toBeTruthy();
    expect(getByText("Unlock Finlynq to continue")).toBeTruthy();
  });

  it("shows the Finlynq logo badge", () => {
    const { getByText } = renderWithTheme(
      <LockScreen onBiometricUnlock={jest.fn()} onSignOut={jest.fn()} />
    );
    expect(getByText("F")).toBeTruthy();
  });

  it("auto-prompts biometric unlock on mount", () => {
    const onBiometricUnlock = jest.fn().mockResolvedValue(true);
    renderWithTheme(
      <LockScreen onBiometricUnlock={onBiometricUnlock} onSignOut={jest.fn()} />
    );
    expect(onBiometricUnlock).toHaveBeenCalled();
  });

  it("triggers biometric unlock on button press", () => {
    const onBiometricUnlock = jest.fn().mockResolvedValue(true);
    const { getByText } = renderWithTheme(
      <LockScreen onBiometricUnlock={onBiometricUnlock} onSignOut={jest.fn()} />
    );
    fireEvent.press(getByText("Unlock with Biometrics"));
    // Once on mount + once on press.
    expect(onBiometricUnlock).toHaveBeenCalledTimes(2);
  });

  it("signs out on the sign-out fallback", () => {
    const onSignOut = jest.fn();
    const { getByText } = renderWithTheme(
      <LockScreen onBiometricUnlock={jest.fn()} onSignOut={onSignOut} />
    );
    fireEvent.press(getByText("Sign out"));
    expect(onSignOut).toHaveBeenCalled();
  });
});
