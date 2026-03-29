import React from "react";
import { NavigationContainer, DefaultTheme, DarkTheme } from "@react-navigation/native";
import { useTheme } from "../theme";
import TabNavigator from "./TabNavigator";
import UnlockScreen from "../screens/UnlockScreen";
import ModeSelectScreen from "../screens/ModeSelectScreen";
import LoginScreen from "../screens/LoginScreen";
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
    // Step 1: Mode not selected yet — show mode selector
    if (auth.serverMode === null) {
      return <ModeSelectScreen onSelect={auth.selectMode} />;
    }

    // Step 2: Cloud mode — need login
    if (auth.serverMode === "cloud" && !auth.isUnlocked) {
      return (
        <LoginScreen
          onLogin={auth.login}
          onRegister={auth.register}
          onBack={auth.resetMode}
          error={auth.error}
          isLoading={auth.isLoading}
        />
      );
    }

    // Step 3: Self-hosted mode — need passphrase unlock
    if (auth.serverMode === "self-hosted" && !auth.isUnlocked) {
      return <UnlockScreen isLoading={auth.isLoading} onBack={auth.resetMode} />;
    }

    // Step 4: Authenticated — show main app
    return <TabNavigator />;
  };

  return (
    <NavigationContainer theme={navTheme}>
      {renderContent()}
    </NavigationContainer>
  );
}
