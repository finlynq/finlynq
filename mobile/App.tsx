import React from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeContext, useAppTheme } from "./src/theme";
import RootNavigator from "./src/navigation/RootNavigator";

export default function App() {
  const theme = useAppTheme();

  return (
    <ThemeContext.Provider value={theme}>
      <SafeAreaProvider>
        <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
        <RootNavigator />
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}
