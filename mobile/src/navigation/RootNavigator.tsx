import React from "react";
import { View, ActivityIndicator } from "react-native";
import { NavigationContainer, DefaultTheme, DarkTheme } from "@react-navigation/native";
import { useTheme } from "../theme";
import TabNavigator from "./TabNavigator";
import LockScreen from "../screens/LockScreen";
import LoginScreen from "../screens/LoginScreen";
import { OnboardingPrompt } from "../components/onboarding-prompt";
import { useAuth } from "../hooks/useAuth";

export default function RootNavigator() {
  const theme = useTheme();
  const auth = useAuth();

  const navTheme = theme.mode === "dark"
    ? {
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          primary: theme.colors.primary,
          background: theme.colors.background,
          card: theme.colors.card,
          text: theme.colors.foreground,
          border: theme.colors.border,
        },
      }
    : {
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          primary: theme.colors.primary,
          background: theme.colors.background,
          card: theme.colors.card,
          text: theme.colors.foreground,
          border: theme.colors.border,
        },
      };

  const renderContent = () => {
    // Bootstrapping — restoring the stored session + validating it.
    if (auth.isLoading) {
      return (
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.background,
          }}
        >
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      );
    }

    if (!auth.isUnlocked) {
      // We hold a validated token but it's locked behind biometrics.
      if (auth.hasSession && auth.biometricAvailable && auth.biometricEnabled) {
        return (
          <LockScreen
            onBiometricUnlock={auth.biometricUnlock}
            onSignOut={auth.signOut}
          />
        );
      }
      // No session (or no biometric gate) — sign in with an account.
      return (
        <LoginScreen
          onLogin={auth.signIn}
          onRegister={auth.register}
          onServerUrlChange={auth.saveServerUrl}
          error={auth.error}
          isLoading={auth.isLoading}
          biometricAvailable={auth.biometricAvailable}
        />
      );
    }

    // Authenticated + unlocked — show the main app, with the first-run
    // sample-data prompt overlaid when this is a fresh register / first sign-in.
    return (
      <>
        <TabNavigator />
        <OnboardingPrompt
          visible={auth.pendingOnboarding}
          onDismiss={auth.dismissOnboarding}
        />
      </>
    );
  };

  return (
    <NavigationContainer theme={navTheme}>
      {renderContent()}
    </NavigationContainer>
  );
}
