import { useColorScheme } from "react-native";
import { createContext, useContext } from "react";
import { lightColors, darkColors, type ThemeColors } from "./colors";

export { lightColors, darkColors, type ThemeColors };

export type ThemeMode = "light" | "dark";

export interface Theme {
  mode: ThemeMode;
  colors: ThemeColors;
  spacing: typeof spacing;
  borderRadius: typeof borderRadius;
  fontSize: typeof fontSize;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const borderRadius = {
  sm: 7,
  md: 10,
  lg: 12,
  xl: 17,
  full: 9999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  base: 15,
  lg: 17,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
} as const;

export function useAppTheme(): Theme {
  const colorScheme = useColorScheme();
  const mode: ThemeMode = colorScheme === "dark" ? "dark" : "light";
  return {
    mode,
    colors: mode === "dark" ? darkColors : lightColors,
    spacing,
    borderRadius,
    fontSize,
  };
}

export const ThemeContext = createContext<Theme>({
  mode: "light",
  colors: lightColors,
  spacing,
  borderRadius,
  fontSize,
});

export const useTheme = () => useContext(ThemeContext);
