import { useEffect, useState } from "react";

/**
 * Returns the current dev mode state.
 * null = still loading (default to hiding dev features while loading)
 * true = dev mode on (show all features)
 * false = prod mode (hide dev-only features)
 */
export function useDevMode(): boolean | null {
  const [devMode, setDevMode] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/settings/dev-mode")
      .then((r) => r.json())
      .then((d) => setDevMode(d.devMode ?? false))
      .catch(() => setDevMode(false));
  }, []);

  return devMode;
}
