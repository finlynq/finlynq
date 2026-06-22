"use client";

import { useEffect, useState } from "react";

/**
 * Currency codes to offer in form dropdowns (account / transaction / goal /
 * loan / holding / FX-rate forms).
 *
 * Returns ONLY the currencies the user enabled under Settings → "Currencies you
 * use" (`active_currencies`). The dropdowns are intentionally scoped to that
 * curated list rather than the full ~150 currencies a price source could
 * quote — the user manages which currencies exist (and learns which are
 * Yahoo-supported vs custom) on the Settings page; the forms just consume the
 * result. (#291: the Add/Edit Account dropdown was originally hardcoded to
 * CAD/USD/EUR/GBP and ignored the setting entirely; the follow-up trimmed the
 * other forms from the full built-in fiat list down to the active set too.)
 *
 * `ensure` (string | string[]) force-includes specific codes regardless of the
 * setting — pass the value a form is currently bound to (e.g. an account's
 * existing currency in edit mode) so a Combobox/Select never renders a value
 * missing from its own item list even if that currency was later deselected.
 * It also guarantees a non-empty list during the initial fetch / on a failed
 * fetch (the consumer's current value always shows).
 */
export function useActiveCurrencies(ensure?: string | string[] | null): string[] {
  const [active, setActive] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/active-currencies")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { active?: unknown } | null) => {
        if (cancelled) return;
        if (Array.isArray(data?.active)) {
          setActive(
            data.active
              .filter((s): s is string => typeof s === "string")
              .map((s) => s.trim().toUpperCase())
              .filter(Boolean)
          );
        }
      })
      .catch(() => {
        /* keep whatever we have; `ensure` still backs the current value */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ensured = (ensure == null ? [] : Array.isArray(ensure) ? ensure : [ensure])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().toUpperCase());

  return Array.from(new Set([...active, ...ensured])).sort();
}
