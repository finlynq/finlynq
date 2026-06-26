"use client";

/**
 * FontProvider — user-selectable UI font preference (FINLYNQ-225).
 *
 * Persists the chosen font to localStorage (browser-specific — no server sync,
 * no cross-device; the Settings UI says so explicitly).
 *
 * FOUC prevention: the companion inline script in layout.tsx reads the same
 * storageKey and sets `data-font` on <html> before first paint. This provider
 * syncs React state with that attribute on the client after hydration.
 *
 * Usage:
 *   const { font, setFont } = useFont();
 *   setFont("inter"); // applies immediately + persists
 */

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";

export type FontKey = "geist" | "inter" | "ibm-plex-sans" | "atkinson" | "system";

export type FontOption = {
  key: FontKey;
  label: string;
};

export const FONT_OPTIONS: FontOption[] = [
  { key: "geist",         label: "Geist" },
  { key: "inter",         label: "Inter" },
  { key: "ibm-plex-sans", label: "IBM Plex Sans" },
  { key: "atkinson",      label: "Atkinson Hyperlegible" },
  { key: "system",        label: "System UI" },
];

export const FONT_STORAGE_KEY = "pf-font";
const DEFAULT_FONT: FontKey = "geist";

type FontContextValue = {
  font: FontKey;
  setFont: (key: FontKey) => void;
};

const FontContext = createContext<FontContextValue | null>(null);

function applyFont(key: FontKey): void {
  const el = document.documentElement;
  if (key === DEFAULT_FONT) {
    el.removeAttribute("data-font");
  } else {
    el.setAttribute("data-font", key);
  }
}

export function FontProvider({ children }: { children: ReactNode }) {
  const [font, setFontState] = useState<FontKey>(DEFAULT_FONT);

  // Read the persisted value (or the value already set by the FOUC script)
  // after hydration so we don't get a server/client mismatch.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(FONT_STORAGE_KEY) as FontKey | null;
      if (stored && FONT_OPTIONS.some((o) => o.key === stored)) {
        setFontState(stored);
        // The FOUC script already set data-font; just sync state.
      }
    } catch {
      // localStorage blocked — keep default.
    }
  }, []);

  const setFont = useCallback((key: FontKey) => {
    setFontState(key);
    applyFont(key);
    try {
      if (key === DEFAULT_FONT) {
        localStorage.removeItem(FONT_STORAGE_KEY);
      } else {
        localStorage.setItem(FONT_STORAGE_KEY, key);
      }
    } catch {
      // Storage blocked — preference applies for the session only.
    }
  }, []);

  return (
    <FontContext.Provider value={{ font, setFont }}>
      {children}
    </FontContext.Provider>
  );
}

export function useFont(): FontContextValue {
  const ctx = useContext(FontContext);
  if (!ctx) {
    // Outside provider — return a no-op stub.
    return {
      font: DEFAULT_FONT,
      setFont: () => {},
    };
  }
  return ctx;
}
