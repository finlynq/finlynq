// Theme tokens ported from web app's globals.css (OKLCH → hex approximations)
// Source: src/app/globals.css

export const lightColors = {
  background: "#f7f7fa",
  foreground: "#0f0f17",
  card: "#ffffff",
  cardForeground: "#0f0f17",
  primary: "#4f46e5",
  primaryForeground: "#ffffff",
  secondary: "#ededf2",
  secondaryForeground: "#1a1a24",
  muted: "#ededf2",
  mutedForeground: "#6b6b7a",
  accent: "#ededf2",
  accentForeground: "#1a1a24",
  destructive: "#e53e3e",
  destructiveForeground: "#ffffff",
  border: "#e2e2e8",
  input: "#e2e2e8",
  ring: "#4f46e5",
  // Chart palette
  chart1: "#4f46e5",
  chart2: "#0ea5e9",
  chart3: "#22c55e",
  chart4: "#eab308",
  chart5: "#d946ef",
};

export const darkColors = {
  background: "#0f0f17",
  foreground: "#f0f0f5",
  card: "#1a1a24",
  cardForeground: "#f0f0f5",
  primary: "#6366f1",
  primaryForeground: "#ffffff",
  secondary: "#27273a",
  secondaryForeground: "#f0f0f5",
  muted: "#27273a",
  mutedForeground: "#9ca3af",
  accent: "#27273a",
  accentForeground: "#f0f0f5",
  destructive: "#ef4444",
  destructiveForeground: "#ffffff",
  border: "#27273a",
  input: "#27273a",
  ring: "#6366f1",
  // Chart palette
  chart1: "#6366f1",
  chart2: "#38bdf8",
  chart3: "#4ade80",
  chart4: "#facc15",
  chart5: "#e879f9",
};

export type ThemeColors = typeof lightColors;
