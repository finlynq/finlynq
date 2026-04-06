"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-side guard for dev-mode-only pages.
 * Redirects to /dashboard if dev mode is disabled.
 * Shows nothing while checking (avoids flash of content).
 */
export function DevModeGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch("/api/settings/dev-mode")
      .then((r) => r.json())
      .then((data) => {
        if (!data.devMode) {
          router.replace("/dashboard");
        } else {
          setChecking(false);
        }
      })
      .catch(() => {
        // On error, allow access (fail open for dev mode)
        setChecking(false);
      });
  }, [router]);

  if (checking) return null;
  return <>{children}</>;
}
