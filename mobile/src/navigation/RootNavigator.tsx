import React from "react";
import { NavigationContainer, DefaultTheme, DarkTheme } from "@react-navigation/native";
import { useTheme } from "../theme";
import TabNavigator from "./TabNavigator";
import UnlockScreen from "../screens/UnlockScreen";
import { useAuth } from "../hooks/useAuth";

export default function RootNavigator() {
  const theme = useTheme();
  const { isUnlocked, isLoading } = useAuth();

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

  return (
    <NavigationContainer theme={navTheme}>
      {isUnlocked ? <TabNavigator /> : <UnlockScreen isLoading={isLoading} />}
    </NavigationContainer>
  );
}
