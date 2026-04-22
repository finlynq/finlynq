"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AuthState = "loading" | "unauthenticated" | "authenticated";

/**
 * Gate around authenticated app pages. If the session is valid we render
 * the children; otherwise we redirect to the login page.
 *
 * The previous self-hosted passphrase/unlock/setup flow was removed when
 * the product became PostgreSQL-only (accounts are provisioned via
 * /register and /cloud login). This component only handles the
 * "am I signed in?" check now.
 */
export function UnlockGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/session");
        const data = await res.json();
        if (cancelled) return;
        setState(data.authenticated ? "authenticated" : "unauthenticated");
      } catch {
        if (!cancelled) setState("unauthenticated");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state === "unauthenticated") {
    router.replace("/cloud");
  }

  if (state !== "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
