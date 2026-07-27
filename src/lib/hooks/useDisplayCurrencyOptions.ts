"use client";

import { useEffect, useState } from "react";
import {
  SUPPORTED_FIAT_CURRENCIES,
  currencyLabel,
} from "@/lib/fx/supported-currencies";
import type { ComboboxItemShape } from "@/components/ui/combobox";

/**
 * The options for an app-wide DISPLAY (reporting) currency picker — the single
 * source for all three surfaces that ask the question: the onboarding wizard's
 * Currency step, the `display_currency` decision prompt, and
 * Settings → General.
 *
 * Deliberately NOT `useActiveCurrencies` (#291). That hook scopes a currency
 * stored ON a record to the user's active set, which `/api/settings/active-
 * currencies` derives FROM `display_currency` — so using it here is circular,
 * and for a user with no display-currency row and no data it collapses to two
 * options.
 *
 * The list is the built-in fiat set PLUS any currency the user has an
 * `fx_overrides` row for. That second half matters: `PUT /api/settings/display-
 * currency` rejects anything `isSupportedCurrency()` says no to, with "Add a
 * custom rate via Settings → Custom exchange rates first" — but until now, once
 * you HAD added that rate, no picker listed the currency, so the instruction
 * led to a dead end. An override is also exactly what makes reporting correct:
 * `getRateToUsd` checks `fx_overrides` FIRST, ahead of `fx_rates` and Yahoo.
 *
 * Currencies with neither a built-in rate source nor an override are omitted on
 * purpose. FX resolution ends in a `rate = 1` fallback rather than an error, so
 * offering them would silently convert 1:1 and put every total out by orders of
 * magnitude — a wrong number that looks plausible.
 *
 * `ensure` force-includes a code regardless (the value a form is currently bound
 * to), so a picker never renders a value missing from its own item list.
 */
export function useDisplayCurrencyOptions(
  ensure?: string | null,
): ComboboxItemShape[] {
  const [overrideCurrencies, setOverrideCurrencies] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/fx/overrides")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: unknown) => {
        if (cancelled || !Array.isArray(rows)) return;
        const codes = rows
          .map((r) => (r as { currency?: unknown }).currency)
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean);
        setOverrideCurrencies(Array.from(new Set(codes)));
      })
      .catch(() => {
        /* built-in list still renders — the override tier is additive */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const builtIn = new Set<string>(SUPPORTED_FIAT_CURRENCIES);
  const ensured = ensure?.trim().toUpperCase();

  // Built-ins first, in their curated order (USD, CAD, EUR, … — most-used
  // first), then custom-rate currencies alphabetically. Search makes the tail
  // reachable, so ordering only has to serve the common case.
  const custom = Array.from(
    new Set([
      ...overrideCurrencies,
      ...(ensured && !builtIn.has(ensured) ? [ensured] : []),
    ]),
  ).sort();

  return [
    ...SUPPORTED_FIAT_CURRENCIES.map((c) => ({
      value: c,
      label: `${c} — ${currencyLabel(c)}`,
    })),
    ...custom.map((c) => ({
      value: c,
      label: `${c} — ${currencyLabel(c)} · custom rate`,
    })),
  ];
}
