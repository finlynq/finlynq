"use client";

/**
 * DropdownOrderProvider — single source of truth for the user's customizable
 * dropdown ordering, fetched once from `/api/settings/dropdown-order` on
 * mount.
 *
 * Pages use the helper hook to apply the saved order to a list of items
 * before rendering them in a `<Combobox>`:
 *
 *   const sortAccounts = useDropdownOrder("account");
 *   const ordered = sortAccounts(
 *     accounts,
 *     (a) => a.id,
 *     (a, b) => a.name.localeCompare(b.name),
 *   );
 *
 * The hook is SSR-safe: until the provider hydrates, it returns the items
 * sorted purely by the fallback comparator (matching today's behaviour).
 *
 * Section G ("setup pages: dropdown ordering") will own the UI for editing
 * the saved order; this provider only consumes it.
 *
 * See issue #21.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  EMPTY_DROPDOWN_ORDER,
  parseDropdownOrder,
  sortByUserOrder,
  type DropdownKind,
  type DropdownOrder,
  type DropdownOrderEntry,
} from "@/lib/dropdown-order";

type DropdownOrderContextValue = {
  order: DropdownOrder;
  isLoading: boolean;
  refresh: () => Promise<void>;
};

const DropdownOrderContext = createContext<DropdownOrderContextValue | null>(null);

export function DropdownOrderProvider({ children }: { children: ReactNode }) {
  const [order, setOrder] = useState<DropdownOrder>(EMPTY_DROPDOWN_ORDER);
  const [isLoading, setIsLoading] = useState(true);

  const fetchOrder = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/dropdown-order");
      if (!res.ok) return;
      const data = await res.json();
      const parsed = parseDropdownOrder(data);
      if (parsed) setOrder(parsed);
    } catch {
      // Ignore — keep empty order, fallback compare still works.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchOrder().finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchOrder]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchOrder();
    setIsLoading(false);
  }, [fetchOrder]);

  const value = useMemo<DropdownOrderContextValue>(
    () => ({ order, isLoading, refresh }),
    [order, isLoading, refresh]
  );

  return (
    <DropdownOrderContext.Provider value={value}>
      {children}
    </DropdownOrderContext.Provider>
  );
}

export function useDropdownOrderContext(): DropdownOrderContextValue {
  const ctx = useContext(DropdownOrderContext);
  if (!ctx) {
    return { order: EMPTY_DROPDOWN_ORDER, isLoading: false, refresh: async () => {} };
  }
  return ctx;
}

/**
 * Returns a memoized sorter for the given dropdown list. Pass it items + a
 * key extractor + a fallback comparator. Pinned items appear first in the
 * saved order, the rest follow in fallback order.
 */
export function useDropdownOrder(kind: DropdownKind) {
  const { order } = useDropdownOrderContext();
  const savedOrder = order.lists[kind];

  return useCallback(
    <T,>(
      items: ReadonlyArray<T>,
      keyOf: (item: T) => DropdownOrderEntry,
      fallbackCompare: (a: T, b: T) => number
    ): T[] => sortByUserOrder(items, keyOf, savedOrder, fallbackCompare),
    [savedOrder]
  );
}
