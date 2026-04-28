"use client";

/**
 * CurrencyProvider — single source of truth for the user's display currency.
 *
 * Reads the value from `/api/auth/session` on mount (the session payload includes
 * displayCurrency since 2026-04-27 — saves a round-trip vs hitting
 * /api/settings/display-currency separately). Optimistic updates persist via PUT.
 *
 * Use the `useDisplayCurrency` hook to read or update the value:
 *
 *   const { displayCurrency, setDisplayCurrency } = useDisplayCurrency();
 *
 * Pages that fetch from APIs accepting `?currency=` should pass `displayCurrency`
 * so server-side aggregation converts to the chosen currency:
 *
 *   fetch(`/api/dashboard?currency=${displayCurrency}`)
 *
 * APIs also fall back to the user's settings.display_currency when the param is
 * absent, so older callers keep working.
 */

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";

type CurrencyContextValue = {
  displayCurrency: string;
  setDisplayCurrency: (code: string) => Promise<void>;
  isLoading: boolean;
};

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

const DEFAULT_CURRENCY = "CAD";

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [displayCurrency, setDisplayCurrencyState] = useState(DEFAULT_CURRENCY);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (typeof data.displayCurrency === "string" && data.displayCurrency.length === 3) {
          setDisplayCurrencyState(data.displayCurrency);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setDisplayCurrency = useCallback(async (code: string) => {
    const next = code.trim().toUpperCase();
    const previous = displayCurrency;
    setDisplayCurrencyState(next); // optimistic
    try {
      const res = await fetch("/api/settings/display-currency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayCurrency: next }),
      });
      if (!res.ok) {
        setDisplayCurrencyState(previous); // rollback
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed to update display currency (HTTP ${res.status})`);
      }
    } catch (err) {
      setDisplayCurrencyState(previous);
      throw err;
    }
  }, [displayCurrency]);

  return (
    <CurrencyContext.Provider value={{ displayCurrency, setDisplayCurrency, isLoading }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useDisplayCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    // Outside a provider — return a no-op stub so static contexts (login pages)
    // still render. The default currency is CAD; setDisplayCurrency throws to
    // surface misuse during development.
    return {
      displayCurrency: DEFAULT_CURRENCY,
      setDisplayCurrency: async () => {
        throw new Error("useDisplayCurrency called outside CurrencyProvider");
      },
      isLoading: false,
    };
  }
  return ctx;
}
