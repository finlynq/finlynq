import { useColorScheme } from "react-native";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  createElement,
  type ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { lightColors, darkColors, type ThemeColors } from "./colors";

export { lightColors, darkColors, type ThemeColors };

export type ThemeMode = "light" | "dark";

/** User-chosen theme preference. "system" tracks the live OS color scheme. */
export type ThemePreference = "light" | "dark" | "system";

const THEME_PREF_KEY = "pf_theme_preference";

export interface Theme {
  mode: ThemeMode;
  colors: ThemeColors;
  spacing: typeof spacing;
  borderRadius: typeof borderRadius;
  fontSize: typeof fontSize;
}

/** What `useTheme()` returns — the resolved theme plus the preference controls. */
export interface ThemeContextValue extends Theme {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
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

function buildTheme(mode: ThemeMode): Theme {
  return {
    mode,
    colors: mode === "dark" ? darkColors : lightColors,
    spacing,
    borderRadius,
    fontSize,
  };
}

/** Legacy OS-only theme resolver. Kept for any non-provider consumer. */
export function useAppTheme(): Theme {
  const colorScheme = useColorScheme();
  const mode: ThemeMode = colorScheme === "dark" ? "dark" : "light";
  return buildTheme(mode);
}

export const ThemeContext = createContext<ThemeContextValue>({
  ...buildTheme("light"),
  preference: "system",
  setPreference: () => {},
});

/**
 * Stateful theme provider. Holds the user's Light/Dark/System preference
 * (hydrated from + persisted to AsyncStorage), watches the live OS scheme, and
 * resolves the effective mode. Making the context stateful flips the whole app
 * reactively — all `useTheme().colors`/`.mode` readers update on `setPreference`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const osScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>("system");

  // Hydrate the persisted preference on mount (default stays "system").
  useEffect(() => {
    AsyncStorage.getItem(THEME_PREF_KEY)
      .then((stored) => {
        if (stored === "light" || stored === "dark" || stored === "system") {
          setPreferenceState(stored);
        }
      })
      .catch(() => {});
  }, []);

  const setPreference = (p: ThemePreference) => {
    setPreferenceState(p);
    AsyncStorage.setItem(THEME_PREF_KEY, p).catch(() => {});
  };

  const mode: ThemeMode =
    preference === "system" ? (osScheme === "dark" ? "dark" : "light") : preference;

  const value: ThemeContextValue = {
    ...buildTheme(mode),
    preference,
    setPreference,
  };

  return createElement(ThemeContext.Provider, { value }, children);
}

export const useTheme = () => useContext(ThemeContext);
