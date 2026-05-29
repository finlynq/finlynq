import React from "react";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeContext, useAppTheme } from "./src/theme";
import { AuthProvider } from "./src/hooks/useAuth";
import RootNavigator from "./src/navigation/RootNavigator";

export default function App() {
  const theme = useAppTheme();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeContext.Provider value={theme}>
        <AuthProvider>
          <SafeAreaProvider>
            <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
            <RootNavigator />
          </SafeAreaProvider>
        </AuthProvider>
      </ThemeContext.Provider>
    </GestureHandlerRootView>
  );
}
