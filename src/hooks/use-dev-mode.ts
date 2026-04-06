"use client";

import { useEffect, useState } from "react";

let cached: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();

/** Returns whether dev mode is active. Caches the result for the session. */
export function useDevMode() {
  const [devMode, setDevMode] = useState<boolean>(cached ?? false);

  useEffect(() => {
    if (cached !== null) {
      setDevMode(cached);
      return;
    }
    fetch("/api/settings/dev-mode")
      .then((r) => r.json())
      .then((d) => {
        cached = d.devMode === true;
        setDevMode(cached!);
        listeners.forEach((fn) => fn(cached!));
      })
      .catch(() => {});

    const handler = (v: boolean) => setDevMode(v);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  return devMode;
}
